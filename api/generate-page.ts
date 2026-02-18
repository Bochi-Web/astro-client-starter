import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { validateAuth } from './_auth.js';
import {
  getEnv,
  fetchFileFromGitHub,
  callClaude,
  stripFences,
  setCorsHeaders,
  GENERATE_SYSTEM_PROMPT,
} from './_generate-prompts.js';

/**
 * POST /api/generate-page
 * Generates one customized template file per call.
 * Called sequentially by the frontend for each file in the filesToGenerate list.
 */

interface PageData {
  url: string;
  slug: string;
  title?: string;
  meta_description?: string;
  headings?: Array<{ level: number; text: string }>;
  body_text?: string;
  images?: Array<{ src: string; alt: string }>;
  testimonials?: Array<{ text: string; author: string }>;
}

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
    const { client_id, file_path, site_config_content } = req.body as {
      client_id: string;
      file_path: string;
      site_config_content: string;
    };

    if (!client_id || !file_path || !site_config_content) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: client_id, file_path, site_config_content',
      });
    }

    // Supabase client with user token for RLS
    const supabaseUrl = getEnv('SUPABASE_URL');
    const supabaseKey = getEnv('SUPABASE_ANON_KEY');
    const userToken = (req.headers.authorization || '').replace('Bearer ', '');
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${userToken}` } },
    });

    // Fetch client record
    const { data: client, error: lookupError } = await supabase
      .from('ai_website_clients')
      .select('id, client_name, github_owner, github_repo, site_config')
      .eq('id', client_id)
      .single();

    if (lookupError || !client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    const siteConfig = (client.site_config || {}) as Record<string, any>;
    const brief = (siteConfig.creative_brief || {}) as Record<string, any>;
    const scraped = (siteConfig.scraped_data || {}) as Record<string, any>;
    const genSettings = (siteConfig.generation_settings || {}) as Record<string, any>;
    const preserveMeta = genSettings.preserve_meta === true;

    const githubOwner = client.github_owner as string;
    const githubRepo = client.github_repo as string;
    const githubToken = getEnv('GITHUB_TOKEN');

    if (!githubOwner || !githubRepo) {
      return res.status(400).json({
        success: false,
        message: 'Client is missing github_owner or github_repo in site_config',
      });
    }

    // ── Fetch template file ──
    let templateContent: string;
    try {
      templateContent = await fetchFileFromGitHub(file_path, githubOwner, githubRepo, githubToken);
    } catch {
      // For new service pages, fetch the service-one template as a base
      if (file_path.startsWith('src/pages/services/')) {
        templateContent = await fetchFileFromGitHub(
          'src/pages/services/service-one.astro',
          githubOwner,
          githubRepo,
          githubToken,
        );
      } else {
        throw new Error(`Template file not found: ${file_path}`);
      }
    }

    // ── Find matching scraped content ──
    const scrapedPages: PageData[] = scraped.pages || [];
    const scrapedGlobal = scraped.global || {};
    const matchedPage = findMatchingScrapedPage(scrapedPages, file_path);

    // ── Collect all testimonials from all pages ──
    const allTestimonials: Array<{ text: string; author: string }> = [];
    for (const page of scrapedPages) {
      if (page.testimonials) {
        allTestimonials.push(...page.testimonials);
      }
    }

    // ── Build prompt ──
    let userPrompt = `I need you to customize this template file for a ${brief.business_type || 'local business'} called "${client.client_name}".

TEMPLATE FILE (${file_path}):
\`\`\`
${templateContent}
\`\`\`

SITE CONFIG (already generated — reference these values via import):
\`\`\`typescript
${site_config_content}
\`\`\`
`;

    // Add matched scraped content
    if (matchedPage) {
      userPrompt += `
EXISTING WEBSITE CONTENT (scraped from their current site):
- Page title: ${matchedPage.title || 'N/A'}
- Meta description: ${matchedPage.meta_description || 'N/A'}
- Headings: ${matchedPage.headings?.map((h) => `H${h.level}: ${h.text}`).join(', ') || 'N/A'}
- Content: ${(matchedPage.body_text || '').slice(0, 1500)}
- Images: ${matchedPage.images?.map((img) => `${img.src} (${img.alt})`).join(', ') || 'none'}
`;
    }

    // Add testimonials for the Testimonials section
    if (file_path.includes('Testimonials') && allTestimonials.length > 0) {
      userPrompt += `
SCRAPED TESTIMONIALS:
${allTestimonials.map((t) => `- "${t.text}" — ${t.author}`).join('\n')}
`;
    }

    // Add creative brief context
    userPrompt += `
CREATIVE BRIEF:
- Design direction: ${brief.design_direction || 'professional and modern'}
- Target audience: ${brief.target_audience || 'general audience'}
- Key CTAs: ${JSON.stringify(brief.calls_to_action || [])}
- Special features: ${JSON.stringify(brief.special_features || [])}
`;

    // Preserve meta if enabled
    if (preserveMeta && matchedPage) {
      if (matchedPage.title || matchedPage.meta_description) {
        userPrompt += `
IMPORTANT: Preserve these exact SEO meta values:
${matchedPage.title ? `- Meta title: "${matchedPage.title}"` : ''}
${matchedPage.meta_description ? `- Meta description: "${matchedPage.meta_description}"` : ''}
`;
      }
    }

    // File-specific instructions
    userPrompt += getFileSpecificInstructions(file_path, brief, scrapedGlobal);

    userPrompt += `
Customize this template with real client content. Return the complete file.`;

    // ── Call Claude ──
    let generated = stripFences(await callClaude(GENERATE_SYSTEM_PROMPT, userPrompt));

    // Retry once if result looks obviously wrong (empty or too short)
    if (generated.length < 50) {
      generated = stripFences(await callClaude(GENERATE_SYSTEM_PROMPT, userPrompt));
    }

    // ── Post-process: fix common Claude import mistakes ──
    generated = fixImportPaths(generated, file_path);

    return res.status(200).json({
      success: true,
      data: {
        path: file_path,
        content: generated,
      },
    });
  } catch (error: any) {
    console.error('generate-page error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Page generation failed',
    });
  }
}

// ── Helpers ──

function findMatchingScrapedPage(
  pages: PageData[],
  filePath: string,
): PageData | null {
  // Section components → use homepage
  if (filePath.includes('components/sections/')) {
    return pages.find((p) => p.slug === 'index') || pages[0] || null;
  }

  // index.astro → homepage
  if (filePath.endsWith('index.astro') && !filePath.includes('services')) {
    return pages.find((p) => p.slug === 'index') || pages[0] || null;
  }

  // contact.astro → contact page
  if (filePath.includes('contact')) {
    return pages.find((p) => p.slug.includes('contact')) || null;
  }

  // Service pages → match by slug
  const serviceSlugMatch = filePath.match(/services\/(.+)\.astro/);
  if (serviceSlugMatch) {
    const serviceSlug = serviceSlugMatch[1];
    return (
      pages.find(
        (p) =>
          p.slug.includes(serviceSlug) ||
          p.title?.toLowerCase().includes(serviceSlug.replace(/-/g, ' ')),
      ) || null
    );
  }

  return null;
}

function getFileSpecificInstructions(
  filePath: string,
  brief: Record<string, any>,
  scrapedGlobal: Record<string, any>,
): string {
  if (filePath.includes('Hero.astro')) {
    return `
INSTRUCTIONS: Write a compelling headline and subtext. Use the scraped H1 and homepage content as inspiration. Include strong CTA buttons linking to /contact/ and /services/{first-service-slug}/.`;
  }

  if (filePath.includes('Navigation.astro')) {
    return `
INSTRUCTIONS: Update navigation links to match the services in siteConfig. Include Home, Services dropdown (one link per service), About, and Contact links.`;
  }

  if (filePath.includes('Services.astro')) {
    return `
INSTRUCTIONS: Show all services from siteConfig with their titles, descriptions, and icons. Each service card should link to /services/{slug}/.`;
  }

  if (filePath.includes('About.astro')) {
    return `
INSTRUCTIONS: Write authentic about section content based on the scraped about page or homepage content. Highlight the business's experience and values.`;
  }

  if (filePath.includes('Stats.astro')) {
    return `
INSTRUCTIONS: Create realistic statistics relevant to a ${brief.business_type || 'local business'}. Use numbers that feel authentic (years in business, customers served, etc.).`;
  }

  if (filePath.includes('Testimonials.astro')) {
    return `
INSTRUCTIONS: Display the scraped testimonials if provided. If none exist, create 3 realistic testimonials appropriate for this business type.`;
  }

  if (filePath.includes('FAQ.astro')) {
    return `
INSTRUCTIONS: Create 5-6 relevant FAQs for a ${brief.business_type || 'local business'}. Use real business details from siteConfig.`;
  }

  if (filePath.includes('Footer.astro')) {
    return `
INSTRUCTIONS: Include all contact info from siteConfig, social links, service quick links, and a copyright line.`;
  }

  if (filePath.includes('contact.astro')) {
    return `
INSTRUCTIONS: Include the contact form, business address, phone, email, and hours of operation from scraped data if available.`;
  }

  if (filePath.includes('services/') && filePath.endsWith('.astro')) {
    const slug = filePath.match(/services\/(.+)\.astro/)?.[1] || '';
    return `
INSTRUCTIONS: This is a detail page for the "${slug.replace(/-/g, ' ')}" service. Write detailed content including: overview, key features/benefits, process steps, FAQ, and a CTA. Reference the service from siteConfig by its slug "${slug}".`;
  }

  return '';
}

/**
 * Fix common import path mistakes Claude makes.
 * Claude sometimes invents paths like '../../config', '../../config/siteConfig',
 * '../../config/site.config', etc. Normalize them to the correct paths.
 */
function fixImportPaths(content: string, filePath: string): string {
  // Determine the correct relative path to siteConfig based on file location
  const isSection = filePath.includes('components/sections/');
  const isPage = filePath.startsWith('src/pages/');
  const isServicePage = filePath.includes('pages/services/');

  let correctSiteConfigPath: string;
  if (isSection) {
    correctSiteConfigPath = '../../data/siteConfig';
  } else if (isServicePage) {
    correctSiteConfigPath = '../../data/siteConfig';
  } else if (isPage) {
    correctSiteConfigPath = '../data/siteConfig';
  } else {
    return content; // Unknown location, don't touch
  }

  // Fix any wrong siteConfig import path
  // Matches: from '../../config', from '../../config/siteConfig', from '../config/site.config', etc.
  const siteConfigImportRegex = /from\s+['"]([^'"]*(?:config|siteConfig|site\.config)[^'"]*)['"]/g;
  content = content.replace(siteConfigImportRegex, (match, importPath) => {
    // Don't fix if it's already the correct path
    if (importPath === correctSiteConfigPath) return match;
    // Only fix if it looks like a siteConfig import (not some other config)
    if (/(?:site[._-]?config|\/config(?:\/|$))/i.test(importPath)) {
      return `from '${correctSiteConfigPath}'`;
    }
    return match;
  });

  return content;
}
