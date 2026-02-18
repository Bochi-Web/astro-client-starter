import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { validateAuth } from './_auth.js';
import { urlToSlug, fetchPage, extractPageData } from './_scraper.js';

/**
 * POST /api/scrape-page
 * Scrapes a single page: fetches HTML, extracts structured data,
 * uploads HTML snapshot to Supabase Storage.
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
    const { url, client_slug } = req.body as { url: string; client_slug: string };

    if (!url || !client_slug) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: url, client_slug',
      });
    }

    // Determine base origin from URL
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return res.status(400).json({ success: false, message: `Invalid URL: ${url}` });
    }

    // Fetch the page
    const result = await fetchPage(url);
    if (!result) {
      return res.status(200).json({
        success: true,
        data: {
          skipped: true,
          error: `Could not fetch ${url} — page may be down, non-HTML, or timed out`,
          url,
        },
      });
    }

    // Extract structured data
    const page = extractPageData(result.html, result.finalUrl, origin);

    // Upload HTML snapshot to Supabase Storage (non-fatal)
    try {
      const supabaseUrl = getEnv('SUPABASE_URL');
      const supabaseKey = getEnv('SUPABASE_ANON_KEY');
      const userToken = (req.headers.authorization || '').replace('Bearer ', '');
      const supabase = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${userToken}` } },
      });

      const comment = `<!-- Snapshot of ${result.finalUrl} taken on ${new Date().toISOString()} by Bochi Web -->\n`;
      const snapshotPath = `${client_slug}/${urlToSlug(result.finalUrl, origin)}.html`;
      await supabase.storage
        .from('site-snapshots')
        .upload(snapshotPath, comment + result.html, {
          contentType: 'text/html',
          upsert: true,
        });
      page.snapshot_path = snapshotPath;
    } catch (err) {
      console.error('Snapshot upload failed (non-fatal):', (err as Error).message);
    }

    return res.status(200).json({
      success: true,
      data: {
        page,
        skipped: false,
      },
    });
  } catch (error: any) {
    console.error('scrape-page error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Page scrape failed',
    });
  }
}
