import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { validateAuth } from './_auth.js';
import {
  slugify,
  normalizeUrl,
  urlToSlug,
  fetchPage,
  extractPageData,
  extractInternalLinks,
  parseRobotsTxt,
  isBlockedByRobots,
  parseSitemapXml,
} from './_scraper.js';

/**
 * POST /api/scrape-discover
 * Discovers all pages on a client's existing website.
 * Fetches homepage, robots.txt, sitemap.xml, and returns the page list.
 */

// ── CORS ──

const ALLOWED_ORIGINS = [
  'http://localhost:8080',
  'https://bw-command-center.vercel.app',
  'https://command.bochi-web.com',
];

function setCorsHeaders(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing environment variable: ${key}`);
  return value;
}

// ── Handler ──

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const user = await validateAuth(req, res);
  if (!user) return;

  try {
    const { client_id } = req.body as { client_id: string };
    if (!client_id) {
      return res.status(400).json({ success: false, message: 'Missing required field: client_id' });
    }

    // Supabase client with user token for RLS
    const supabaseUrl = getEnv('SUPABASE_URL');
    const supabaseKey = getEnv('SUPABASE_ANON_KEY');
    const userToken = (req.headers.authorization || '').replace('Bearer ', '');
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${userToken}` } },
    });

    // Look up client
    const { data: client, error: lookupError } = await supabase
      .from('ai_website_clients')
      .select('id, client_name, site_config')
      .eq('id', client_id)
      .single();

    if (lookupError || !client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    const siteConfig = (client.site_config || {}) as Record<string, unknown>;
    const currentUrl = siteConfig.current_website_url as string | undefined;

    if (!currentUrl) {
      return res.status(400).json({
        success: false,
        message: 'No current_website_url found in site_config. Add one in the client details first.',
      });
    }

    // Determine origin and properties
    let startUrl: string;
    try {
      const parsed = new URL(currentUrl.startsWith('http') ? currentUrl : `https://${currentUrl}`);
      startUrl = parsed.href;
    } catch {
      return res.status(400).json({ success: false, message: `Invalid URL: ${currentUrl}` });
    }

    const origin = new URL(startUrl).origin;
    const ssl = startUrl.startsWith('https');
    const canonical_prefix = new URL(startUrl).hostname.startsWith('www.') ? 'www' : 'non-www';
    const clientSlug = slugify(client.client_name);

    // Fetch robots.txt (non-fatal)
    let robots_txt: string | null = null;
    let disallowed: string[] = [];
    try {
      const robotsRes = await fetch(`${origin}/robots.txt`, {
        headers: { 'User-Agent': 'BochiBotWeb/1.0 (site migration tool)' },
        signal: AbortSignal.timeout(5000),
      });
      if (robotsRes.ok) {
        robots_txt = await robotsRes.text();
        disallowed = parseRobotsTxt(robots_txt);
      }
    } catch { /* robots.txt not available */ }

    // Fetch sitemap.xml (non-fatal)
    let sitemap_urls: string[] = [];
    try {
      const sitemapRes = await fetch(`${origin}/sitemap.xml`, {
        headers: { 'User-Agent': 'BochiBotWeb/1.0 (site migration tool)' },
        signal: AbortSignal.timeout(5000),
      });
      if (sitemapRes.ok) {
        const xml = await sitemapRes.text();
        sitemap_urls = parseSitemapXml(xml, origin);
      }
    } catch { /* sitemap not available */ }

    // Fetch + parse homepage
    const homepageResult = await fetchPage(startUrl);
    if (!homepageResult) {
      return res.status(502).json({
        success: false,
        message: `Could not fetch homepage at ${startUrl}. The site may be down or blocking our request.`,
      });
    }

    const homepage = extractPageData(homepageResult.html, homepageResult.finalUrl, origin);

    // Upload homepage HTML snapshot
    try {
      const comment = `<!-- Snapshot of ${homepageResult.finalUrl} taken on ${new Date().toISOString()} by Bochi Web -->\n`;
      const snapshotPath = `${clientSlug}/${urlToSlug(homepageResult.finalUrl, origin)}.html`;
      await supabase.storage
        .from('site-snapshots')
        .upload(snapshotPath, comment + homepageResult.html, {
          contentType: 'text/html',
          upsert: true,
        });
      homepage.snapshot_path = snapshotPath;
    } catch (err) {
      console.error('Homepage snapshot upload failed (non-fatal):', (err as Error).message);
    }

    // Discover internal links from homepage
    const homepageLinks = extractInternalLinks(homepageResult.html, homepageResult.finalUrl, origin);

    // Combine homepage links + sitemap URLs, deduplicate
    const allDiscovered = new Set<string>();
    for (const link of [...homepageLinks, ...sitemap_urls]) {
      const normalized = normalizeUrl(link, origin);
      if (normalized && normalized !== normalizeUrl(startUrl, origin)) {
        // Check robots.txt
        const path = new URL(normalized).pathname;
        if (!isBlockedByRobots(path, disallowed)) {
          allDiscovered.add(normalized);
        }
      }
    }

    // Cap at 49 pages (homepage already scraped = 50 total max)
    const pages_to_scrape = [...allDiscovered].slice(0, 49);

    return res.status(200).json({
      success: true,
      data: {
        client_slug: clientSlug,
        source_url: startUrl,
        canonical_prefix,
        ssl,
        robots_txt,
        robots_disallowed: disallowed,
        sitemap_urls,
        pages_to_scrape,
        homepage,
      },
    });
  } catch (error: any) {
    console.error('scrape-discover error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Discovery failed',
    });
  }
}
