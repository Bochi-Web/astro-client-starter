import * as cheerio from 'cheerio';

// ── Types ──

export interface PageData {
  url: string;
  slug: string;
  title: string | null;
  meta_description: string | null;
  og_tags: Record<string, string>;
  canonical: string | null;
  schema: unknown[];
  headings: { level: number; text: string }[];
  body_text: string;
  images: { src: string; alt: string; filename: string }[];
  internal_links: string[];
  phone_numbers: string[];
  email_addresses: string[];
  physical_address: string | null;
  social_links: string[];
  testimonials: string[];
  forms: { action: string; method: string; fields: { name: string; type: string; placeholder: string }[] }[];
  navigation: { text: string; href: string }[];
  snapshot_path: string | null;
}

export interface ScrapedData {
  scraped_at: string;
  source_url: string;
  canonical_prefix: 'www' | 'non-www';
  ssl: boolean;
  total_pages: number;
  sitemap_urls: string[];
  robots_txt: string | null;
  global: {
    phone_numbers: string[];
    email_addresses: string[];
    physical_address: string | null;
    social_links: string[];
    navigation: { text: string; href: string }[];
  };
  pages: PageData[];
  skipped: { url: string; error: string }[];
}

// ── URL Helpers ──

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function normalizeUrl(url: string, baseOrigin: string): string | null {
  try {
    const parsed = new URL(url, baseOrigin);
    // Only allow same-origin
    if (parsed.origin !== new URL(baseOrigin).origin) return null;
    // Strip fragment and query params for deduplication
    parsed.hash = '';
    parsed.search = '';
    // Strip trailing slash (except for root)
    let normalized = parsed.href;
    if (normalized.endsWith('/') && parsed.pathname !== '/') {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return null;
  }
}

export function urlToSlug(url: string, baseOrigin: string): string {
  try {
    const parsed = new URL(url, baseOrigin);
    let path = parsed.pathname;
    // Root → index
    if (path === '/' || path === '') return 'index';
    // Remove leading slash
    path = path.replace(/^\//, '');
    // Remove trailing slash
    path = path.replace(/\/$/, '');
    // Remove .html extension if present
    path = path.replace(/\.html$/, '');
    // Replace slashes with double dashes
    path = path.replace(/\//g, '--');
    return path;
  } catch {
    return 'unknown';
  }
}

// ── Robots.txt ──

export function parseRobotsTxt(robotsTxt: string): string[] {
  const disallowed: string[] = [];
  let relevantSection = false;

  for (const line of robotsTxt.split('\n')) {
    const trimmed = line.trim().toLowerCase();
    if (trimmed.startsWith('user-agent:')) {
      const agent = trimmed.replace('user-agent:', '').trim();
      relevantSection = agent === '*' || agent === 'bochibotWeb/1.0';
    } else if (relevantSection && trimmed.startsWith('disallow:')) {
      const path = line.trim().replace(/^disallow:\s*/i, '').trim();
      if (path) disallowed.push(path);
    }
  }

  return disallowed;
}

export function isBlockedByRobots(urlPath: string, disallowed: string[]): boolean {
  return disallowed.some((rule) => urlPath.startsWith(rule));
}

// ── Fetch ──

const USER_AGENT = 'BochiBotWeb/1.0 (site migration tool)';
const FETCH_TIMEOUT = 8000; // 8s — leave 2s buffer for 10s function limit

export async function fetchPage(url: string): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;
    if (!response.ok) return null;

    const html = await response.text();
    return { html, finalUrl: response.url };
  } catch (err) {
    console.error(`fetchPage failed for ${url}:`, (err as Error).message);
    return null;
  }
}

// ── Extraction ──

const PHONE_REGEX = /(?:\+1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/g;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const SOCIAL_DOMAINS = [
  'facebook.com', 'fb.com',
  'instagram.com',
  'twitter.com', 'x.com',
  'linkedin.com',
  'youtube.com',
  'yelp.com',
  'google.com/maps', 'maps.google.com',
  'tiktok.com',
  'nextdoor.com',
];

export function extractPageData(html: string, url: string, baseOrigin: string): PageData {
  const $ = cheerio.load(html);

  // Title
  const title = $('title').first().text().trim() || null;

  // Meta description
  const meta_description = $('meta[name="description"]').attr('content')?.trim() || null;

  // OG tags
  const og_tags: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => {
    const prop = $(el).attr('property');
    const content = $(el).attr('content');
    if (prop && content) og_tags[prop] = content;
  });

  // Canonical
  const canonical = $('link[rel="canonical"]').attr('href') || null;

  // Schema / JSON-LD
  const schema: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      schema.push(JSON.parse($(el).html() || ''));
    } catch { /* skip invalid JSON-LD */ }
  });

  // Headings
  const headings: { level: number; text: string }[] = [];
  $('h1, h2, h3').each((_, el) => {
    const text = $(el).text().trim();
    if (text) {
      const tag = (el as any).tagName?.toLowerCase() || 'h1';
      headings.push({ level: parseInt(tag[1], 10), text });
    }
  });

  // Body text
  const bodyParts: string[] = [];
  $('p, li, blockquote').each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length > 10) bodyParts.push(text);
  });
  const body_text = bodyParts.join('\n');

  // Images
  const images: { src: string; alt: string; filename: string }[] = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src');
    if (!src) return;
    let absoluteSrc: string;
    try {
      absoluteSrc = new URL(src, url).href;
    } catch {
      absoluteSrc = src;
    }
    const filename = absoluteSrc.split('/').pop()?.split('?')[0] || '';
    images.push({
      src: absoluteSrc,
      alt: $(el).attr('alt') || '',
      filename,
    });
  });

  // Internal links
  const internal_links = extractInternalLinks(html, url, baseOrigin);

  // Phone numbers
  const phone_numbers = [...new Set(html.match(PHONE_REGEX) || [])];

  // Email addresses
  const rawEmails: string[] = html.match(EMAIL_REGEX) || [];
  const email_addresses = [...new Set(
    rawEmails.filter((e) => !e.includes('.png') && !e.includes('.jpg') && !e.includes('.svg'))
  )];

  // Physical address
  let physical_address: string | null = null;
  // Try schema PostalAddress first
  for (const s of schema) {
    const addr = findPostalAddress(s);
    if (addr) { physical_address = addr; break; }
  }
  // Fallback to <address> tag
  if (!physical_address) {
    const addrText = $('address').first().text().trim();
    if (addrText) physical_address = addrText;
  }

  // Social links
  const social_links: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (SOCIAL_DOMAINS.some((d) => href.includes(d))) {
      social_links.push(href);
    }
  });

  // Testimonials
  const testimonials: string[] = [];
  $('[class*="testimonial"], [class*="review"], [class*="Testimonial"], [class*="Review"]').each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length > 20 && text.length < 2000) {
      testimonials.push(text);
    }
  });
  // Also check blockquotes that look like testimonials
  $('blockquote').each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length > 20 && text.length < 2000) {
      testimonials.push(text);
    }
  });

  // Forms
  const forms: PageData['forms'] = [];
  $('form').each((_, el) => {
    const fields: { name: string; type: string; placeholder: string }[] = [];
    $(el).find('input, textarea, select').each((_, field) => {
      fields.push({
        name: $(field).attr('name') || '',
        type: $(field).attr('type') || (field as any).tagName?.toLowerCase() || 'input',
        placeholder: $(field).attr('placeholder') || '',
      });
    });
    if (fields.length === 0) return;
    forms.push({
      action: $(el).attr('action') || '',
      method: $(el).attr('method') || 'get',
      fields,
    });
  });

  // Navigation
  const navigation: { text: string; href: string }[] = [];
  $('nav a, header a').each((_, el) => {
    const text = $(el).text().trim();
    const href = $(el).attr('href') || '';
    if (text && href && !href.startsWith('#') && !href.startsWith('tel:') && !href.startsWith('mailto:')) {
      navigation.push({ text, href });
    }
  });

  const slug = urlToSlug(url, baseOrigin);

  return {
    url,
    slug,
    title,
    meta_description,
    og_tags,
    canonical,
    schema,
    headings,
    body_text,
    images,
    internal_links,
    phone_numbers,
    email_addresses,
    physical_address,
    social_links: [...new Set(social_links)],
    testimonials: [...new Set(testimonials)],
    forms,
    navigation,
    snapshot_path: null, // filled in by the endpoint after upload
  };
}

export function extractInternalLinks(html: string, url: string, baseOrigin: string): string[] {
  const $ = cheerio.load(html);
  const links: Set<string> = new Set();
  const origin = new URL(baseOrigin).origin;

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    // Skip non-page links
    if (href.startsWith('#') || href.startsWith('tel:') || href.startsWith('mailto:') || href.startsWith('javascript:')) return;
    // Skip file downloads
    if (/\.(pdf|jpg|jpeg|png|gif|svg|doc|docx|xls|xlsx|zip|mp4|mp3)$/i.test(href)) return;

    const normalized = normalizeUrl(href, origin);
    if (normalized) links.add(normalized);
  });

  return [...links];
}

// ── Helpers ──

function findPostalAddress(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  if (o['@type'] === 'PostalAddress') {
    const parts = [
      o.streetAddress,
      o.addressLocality,
      o.addressRegion,
      o.postalCode,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  // Recurse into nested objects/arrays
  if (o.address) return findPostalAddress(o.address);
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findPostalAddress(item);
      if (found) return found;
    }
  }
  for (const val of Object.values(o)) {
    if (typeof val === 'object') {
      const found = findPostalAddress(val);
      if (found) return found;
    }
  }
  return null;
}

// ── Sitemap Parser ──

export function parseSitemapXml(xml: string, baseOrigin: string): string[] {
  const $ = cheerio.load(xml, { xml: true });
  const urls: string[] = [];
  const origin = new URL(baseOrigin).origin;

  $('url > loc').each((_, el) => {
    const loc = $(el).text().trim();
    if (loc) {
      const normalized = normalizeUrl(loc, origin);
      if (normalized) urls.push(normalized);
    }
  });

  return urls;
}
