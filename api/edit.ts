import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/edit
 * Receives a section edit request, fetches the component source from GitHub,
 * sends it to Claude API with the user's instructions, and returns the
 * modified code with an explanation.
 */

// ── Section-to-file mapping (duplicated from src/data/sectionMap.ts to avoid
//    bundling issues with Vercel serverless functions) ──

const componentSections: Record<string, string> = {
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

const pageSections = new Set([
  'service-hero',
  'service-overview',
  'service-features',
  'service-process',
  'service-faq',
  'service-cta',
  'contact',
]);

const pageFileMap: Record<string, string> = {
  '/services/service-one/': 'src/pages/services/service-one.astro',
  '/services/service-two/': 'src/pages/services/service-two.astro',
  '/services/service-three/': 'src/pages/services/service-three.astro',
  '/contact/': 'src/pages/contact.astro',
};

function resolveFilePath(section: string, currentPage: string): string | null {
  if (componentSections[section]) return componentSections[section];
  if (pageSections.has(section)) {
    const normalized = currentPage.endsWith('/') ? currentPage : currentPage + '/';
    return pageFileMap[normalized] || null;
  }
  return null;
}

// ── Environment variables ──

function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing environment variable: ${key}`);
  return value;
}

// ── GitHub file fetch ──

async function fetchFileFromGitHub(filePath: string): Promise<string> {
  const owner = getEnv('GITHUB_OWNER');
  const repo = getEnv('GITHUB_REPO');
  const token = getEnv('GITHUB_TOKEN');

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3.raw',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} fetching ${filePath}`);
  }

  return response.text();
}

// ── Claude API call ──

const SYSTEM_PROMPT = `You are an expert Astro and Tailwind CSS developer working as a website editor. You will receive the source code of an Astro component and a user's request to modify it.

Rules:
- Return the COMPLETE modified component file, not just the changes
- Maintain the existing data-section attribute — never remove it
- If data-global="true" exists, maintain it
- Keep the same Tailwind CSS custom property approach (var(--color-primary) etc.)
- Do not add external dependencies or npm packages
- Do not add client-side JavaScript unless specifically requested
- Keep the code clean, well-formatted, and production-ready
- If the user provides a reference URL, use it as visual/structural inspiration but write original code
- If the user provides a reference image, interpret the design and implement it in Astro/Tailwind

Respond in this JSON format:
{
  "explanation": "Brief description of what you changed and why",
  "code": "The complete modified component file content"
}

Only respond with valid JSON. No markdown, no code fences.`;

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface RequestBody {
  section: string;
  message: string;
  action: 'edit' | 'replace' | 'new-page';
  referenceUrl?: string | null;
  referenceImage?: string | null;
  isGlobal: boolean;
  currentPage: string;
  conversationHistory: ConversationMessage[];
}

async function callClaude(
  userMessage: string,
  conversationHistory: ConversationMessage[],
  referenceImage?: string | null
): Promise<{ explanation: string; code: string }> {
  const apiKey = getEnv('ANTHROPIC_API_KEY');

  // Build messages array with conversation history
  const messages: any[] = [];

  for (const msg of conversationHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // Build the current user message content blocks
  const contentBlocks: any[] = [];

  // If there's a reference image, add it as an image block
  if (referenceImage) {
    // Extract base64 data and media type from data URL
    const match = referenceImage.match(/^data:(image\/\w+);base64,(.+)$/);
    if (match) {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: match[1],
          data: match[2],
        },
      });
    }
  }

  contentBlocks.push({ type: 'text', text: userMessage });

  messages.push({ role: 'user', content: contentBlocks });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claude API error: ${response.status} — ${errorText}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text;

  if (!text) {
    throw new Error('Empty response from Claude API');
  }

  // Parse the JSON response
  const parsed = JSON.parse(text);
  return { explanation: parsed.explanation, code: parsed.code };
}

// ── Request handler ──

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const body = req.body as RequestBody;
    const {
      section,
      message,
      action,
      referenceUrl,
      referenceImage,
      isGlobal,
      currentPage,
      conversationHistory = [],
    } = body;

    if (!section || !message) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: section, message',
      });
    }

    // ── New Page action — no file to fetch ──
    if (action === 'new-page') {
      let userPrompt = `The user wants to create a new page for an Astro website using Tailwind CSS.\n\nThe user wants: ${message}`;
      if (referenceUrl) {
        userPrompt += `\n\nReference website for inspiration: ${referenceUrl}`;
      }
      if (referenceImage) {
        userPrompt += `\n\nA reference image has been provided — use it as design guidance.`;
      }
      userPrompt += `\n\nGenerate a complete Astro page file. Use the same patterns as other pages in the project: import BaseLayout, use SectionWrapper for sections, include data-section attributes on each section, use Tailwind CSS utilities with the project's CSS custom properties (var(--color-primary), etc.).`;

      const result = await callClaude(userPrompt, conversationHistory, referenceImage);

      return res.status(200).json({
        success: true,
        message: result.explanation,
        modifiedCode: result.code,
        originalCode: null,
        filePath: null,
      });
    }

    // ── Resolve the file path ──
    const filePath = resolveFilePath(section, currentPage);
    if (!filePath) {
      return res.status(400).json({
        success: false,
        message: `Could not resolve file path for section "${section}" on page "${currentPage}"`,
      });
    }

    // ── Fetch the source code from GitHub ──
    const originalCode = await fetchFileFromGitHub(filePath);

    // ── Build the user message for Claude ──
    let userPrompt: string;

    if (action === 'replace') {
      userPrompt = `Here is the current component code for the "${section}" section:\n\n\`\`\`astro\n${originalCode}\n\`\`\`\n\nThe user wants: ${message}`;
      if (referenceUrl) {
        userPrompt += `\n\nReference website for inspiration: ${referenceUrl}`;
      }
      if (referenceImage) {
        userPrompt += `\n\nA reference image has been provided — use it as design guidance.`;
      }
      userPrompt += `\n\nBuild a completely new version of this section. Return the complete new file. Keep the same data-section attribute.`;
    } else {
      userPrompt = `Here is the current component code for the "${section}" section:\n\n\`\`\`astro\n${originalCode}\n\`\`\`\n\nThe user wants: ${message}`;
      if (referenceUrl) {
        userPrompt += `\n\nReference website for inspiration: ${referenceUrl}`;
      }
      if (referenceImage) {
        userPrompt += `\n\nA reference image has been provided — use it as design guidance.`;
      }
      userPrompt += `\n\nModify the component to match the user's request. Return the complete modified file.`;
    }

    if (isGlobal) {
      userPrompt += `\n\nIMPORTANT: This is a GLOBAL component (navigation or footer) that appears on every page. Changes here will affect all pages site-wide. Ensure data-global="true" is preserved.`;
    }

    // ── Call Claude ──
    const result = await callClaude(userPrompt, conversationHistory, referenceImage);

    return res.status(200).json({
      success: true,
      message: result.explanation,
      modifiedCode: result.code,
      originalCode,
      filePath,
    });
  } catch (error: any) {
    console.error('Edit API error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Internal server error',
    });
  }
}
