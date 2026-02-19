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
 * POST /api/generate-config
 * Generates siteConfig.ts + theme.css + sectionMap.ts + vercel.json + filesToGenerate list.
 * First step of the multi-call generation pipeline.
 */

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

    // GitHub details for the client's repo
    const githubOwner = client.github_owner as string;
    const githubRepo = client.github_repo as string;
    const githubToken = getEnv('GITHUB_TOKEN');

    if (!githubOwner || !githubRepo) {
      return res.status(400).json({
        success: false,
        message: 'Client is missing github_owner or github_repo in site_config',
      });
    }

    // ── Fetch template files from client's repo ──
    const [templateSiteConfig, templateThemeCss] = await Promise.all([
      fetchFileFromGitHub('src/data/siteConfig.ts', githubOwner, githubRepo, githubToken),
      fetchFileFromGitHub('src/styles/theme.css', githubOwner, githubRepo, githubToken),
    ]);

    // ── Generate siteConfig.ts ──
    const scrapedGlobal = scraped.global || {};
    const phones: string[] = scrapedGlobal.phone_numbers || [];
    const emails: string[] = scrapedGlobal.email_addresses || [];
    const physicalAddress: string | null = scrapedGlobal.physical_address || null;
    const socialLinks: string[] = scrapedGlobal.social_links || [];

    // Extract homepage content for location context
    const scrapedPages: any[] = scraped.pages || [];
    const homepage = scrapedPages.find((p: any) => p.slug === 'index') || scrapedPages[0];
    const homepageText = homepage?.body_text?.slice(0, 800) || '';

    // Check if logo exists
    const hasLogo = !!siteConfig.logo_data_url;
    const logoDataUrl = siteConfig.logo_data_url as string | undefined;
    let logoExt = 'png';
    if (logoDataUrl) {
      const mimeMatch = logoDataUrl.match(/^data:image\/([\w+]+);base64,/);
      if (mimeMatch) {
        logoExt = mimeMatch[1] === 'svg+xml' ? 'svg' : mimeMatch[1];
      }
    }

    const siteConfigPrompt = `I need you to customize this Astro siteConfig.ts template for a ${brief.business_type || 'local business'} called "${client.client_name}".

TEMPLATE FILE (src/data/siteConfig.ts):
\`\`\`typescript
${templateSiteConfig}
\`\`\`

CLIENT DATA:
- Business name: ${client.client_name}
- Business type: ${brief.business_type || 'local business'}
- Tagline/design direction: ${brief.design_direction || 'professional and modern'}
- Phone: ${phones[0] || '(555) 000-0000'}
- Email: ${emails[0] || `info@${githubRepo}.com`}
- Physical address: ${physicalAddress || 'Not available'}
- Social links: ${socialLinks.length > 0 ? socialLinks.join(', ') : 'none found'}
- Services to feature: ${JSON.stringify(brief.services_to_feature || [])}
- Key CTAs: ${JSON.stringify(brief.calls_to_action || [])}
${hasLogo ? `- Logo file: /logo.${logoExt} (already committed to public/ — add logoPath: "/logo.${logoExt}" to the config)` : ''}

SCRAPED HOMEPAGE CONTENT (use this to determine correct city/state/location):
${homepageText}

IMPORTANT:
- Use the SCRAPED content to determine the correct city, state, and location — do NOT keep the template defaults.
- The address object must reflect the client's actual location from the scraped data, not the template placeholder.
${brief.services_to_feature && brief.services_to_feature.length > 0 ? `- Create one service entry for each of these services: ${brief.services_to_feature.join(', ')}.
  Each service needs a slug (kebab-case, e.g. "pressure-washing"), a title, a short description, and an icon.
  Available icons: "wrench", "chart", "shield", "home", "star", "truck", "leaf", "droplet", "hammer", "sparkles".` : ''}

Customize this siteConfig with real client data. Keep the exact same TypeScript structure and export.
Return the complete file.`;

    const generatedSiteConfig = stripFences(
      await callClaude(GENERATE_SYSTEM_PROMPT, siteConfigPrompt),
    );

    // ── Generate theme.css ──
    const themeCssPrompt = `I need you to customize this CSS theme file for a ${brief.business_type || 'local business'} called "${client.client_name}".

TEMPLATE FILE (src/styles/theme.css):
\`\`\`css
${templateThemeCss}
\`\`\`

CLIENT PREFERENCES:
- Color preferences: ${brief.color_preferences || 'professional, modern colors appropriate for the business type'}
- Design direction: ${brief.design_direction || 'clean and professional'}
- Business type: ${brief.business_type || 'local business'}

Update the CSS custom property values in the :root block to match the client's brand.
Keep the @theme block structure identical — only change the color values in :root.
Return the complete file.`;

    const generatedThemeCss = stripFences(
      await callClaude(GENERATE_SYSTEM_PROMPT, themeCssPrompt),
    );

    // ── Parse services from generated siteConfig to build file list ──
    const serviceSlugs = parseServiceSlugs(generatedSiteConfig);

    // ── Build sectionMap.ts ──
    const sectionMapContent = buildSectionMap(serviceSlugs);

    // ── Build vercel.json ──
    const redirectMap: Array<{ old_path: string; new_path: string }> =
      genSettings.redirect_map || [];
    const vercelJsonContent = buildVercelJson(redirectMap);

    // ── Compute filesToGenerate ──
    const filesToGenerate = [
      'src/components/sections/Navigation.astro',
      'src/components/sections/Hero.astro',
      'src/components/sections/Services.astro',
      'src/components/sections/About.astro',
      'src/components/sections/Stats.astro',
      'src/components/sections/HowItWorks.astro',
      'src/components/sections/Testimonials.astro',
      'src/components/sections/FAQ.astro',
      'src/components/sections/CTABanner.astro',
      'src/components/sections/Footer.astro',
      'src/pages/index.astro',
      'src/pages/contact.astro',
      ...serviceSlugs.map((slug) => `src/pages/services/${slug}.astro`),
    ];

    return res.status(200).json({
      success: true,
      data: {
        siteConfig: generatedSiteConfig,
        themeCss: generatedThemeCss,
        sectionMap: sectionMapContent,
        vercelJson: vercelJsonContent,
        filesToGenerate,
      },
    });
  } catch (error: any) {
    console.error('generate-config error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Config generation failed',
    });
  }
}

// ── Helpers ──

function parseServiceSlugs(siteConfigContent: string): string[] {
  const slugs: string[] = [];
  // Match slug: "some-slug" or slug: 'some-slug'
  const regex = /slug:\s*["']([^"']+)["']/g;
  let match;
  while ((match = regex.exec(siteConfigContent)) !== null) {
    slugs.push(match[1]);
  }
  return slugs;
}

function buildSectionMap(serviceSlugs: string[]): string {
  const pageFileEntries = serviceSlugs
    .map((slug) => `  '/services/${slug}/': 'src/pages/services/${slug}.astro',`)
    .join('\n');

  return `/**
 * Section-to-File Mapping
 * Maps data-section attribute values to their source file paths in the repo.
 * Used by the edit API to know which file to fetch and modify.
 */

/** Sections that are dedicated component files */
export const componentSections: Record<string, string> = {
  'navigation': 'src/components/sections/Navigation.astro',
  'hero': 'src/components/sections/Hero.astro',
  'services': 'src/components/sections/Services.astro',
  'about': 'src/components/sections/About.astro',
  'stats': 'src/components/sections/Stats.astro',
  'how-it-works': 'src/components/sections/HowItWorks.astro',
  'testimonials': 'src/components/sections/Testimonials.astro',
  'faq': 'src/components/sections/FAQ.astro',
  'cta-banner': 'src/components/sections/CTABanner.astro',
  'footer': 'src/components/sections/Footer.astro',
};

/** Sections that live inline inside page files */
const pageSections = new Set([
  'service-hero',
  'service-overview',
  'service-features',
  'service-process',
  'service-faq',
  'service-cta',
  'contact',
]);

/** Page URL pathname → source file path */
const pageFileMap: Record<string, string> = {
${pageFileEntries}
  '/contact/': 'src/pages/contact.astro',
};

/**
 * Resolve a data-section value + current page URL to a source file path.
 * Returns null if the section can't be mapped.
 */
export function resolveFilePath(
  section: string,
  currentPage: string
): string | null {
  if (componentSections[section]) {
    return componentSections[section];
  }
  if (pageSections.has(section)) {
    const normalized = currentPage.endsWith('/') ? currentPage : currentPage + '/';
    return pageFileMap[normalized] || null;
  }
  return null;
}
`;
}

function buildVercelJson(
  redirectMap: Array<{ old_path: string; new_path: string }>,
): string {
  if (redirectMap.length === 0) {
    return JSON.stringify({ redirects: [] }, null, 2);
  }

  const redirects = redirectMap
    .filter((r) => r.old_path !== r.new_path) // Skip self-redirects
    .map((r) => ({
      source: r.old_path,
      destination: r.new_path,
      statusCode: 301,
    }));

  return JSON.stringify({ redirects }, null, 2);
}
