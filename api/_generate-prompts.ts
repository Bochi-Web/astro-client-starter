/**
 * Shared helpers for the generate-* endpoints.
 * NOT a route (underscore prefix).
 */

// ── Environment variables ──

export function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing environment variable: ${key}`);
  return value;
}

// ── GitHub file fetch (parameterized) ──

export async function fetchFileFromGitHub(
  filePath: string,
  owner: string,
  repo: string,
  token: string,
): Promise<string> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3.raw',
      },
    },
  );

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} fetching ${filePath}`);
  }

  return response.text();
}

// ── Claude API call (raw string response) ──

export const GENERATE_SYSTEM_PROMPT = `You are a web developer customizing an Astro website template for a new client.
You will receive a template file and client-specific data.
Return ONLY the complete file content — no markdown fences, no explanation, no preamble.

Rules:
- Keep all import statements from the template
- Keep BaseLayout wrapper and data-section attributes
- Keep CSS custom property usage (var(--color-primary) etc.)
- Use siteConfig references for phone, email, address, services
- Replace ALL placeholder text with real client content
- Reference scraped image URLs where appropriate
- Do not add external dependencies or npm packages
- Keep code clean, well-formatted, and production-ready`;

export async function callClaude(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const apiKey = getEnv('OPENROUTER_API_KEY');

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://bochi-web.com',
      'X-Title': 'Bochi Web Site Generator',
    },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4',
      max_tokens: 8192,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} — ${errorText}`);
  }

  const data = await response.json();
  const text: string | undefined = data.choices?.[0]?.message?.content;

  if (!text) {
    throw new Error('Empty response from OpenRouter API');
  }

  return text;
}

// ── Strip markdown fences ──

export function stripFences(content: string): string {
  let result = content.trim();
  // Remove leading ```lang and trailing ```
  const fenceMatch = result.match(/^```[\w]*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) {
    result = fenceMatch[1];
  }
  return result;
}

// ── CORS ──

export const ALLOWED_ORIGINS = [
  'http://localhost:8080',
  'https://bw-command-center.vercel.app',
  'https://command.bochi-web.com',
];

export function setCorsHeaders(req: { headers: { origin?: string } }, res: { setHeader: (k: string, v: string) => void }) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
