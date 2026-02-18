import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateAuth } from './_lib/auth';

/**
 * POST /api/client-intake
 * Conversational AI intake for new client sites.
 * Called from the BWCC NewClientChat dialog.
 * Claude extracts client details and returns either a follow-up question
 * or structured client data ready for insertion.
 */

// ── CORS helpers ──

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

// ── Environment helpers ──

function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing environment variable: ${key}`);
  return value;
}

// ── System prompt for client intake ──

const SYSTEM_PROMPT = `You are an AI assistant helping a web agency onboard new client websites. Your job is to gather enough information about a new client to create a database record for their website project.

You need to extract the following fields:
- client_name (required): The business/client name
- business_type: What kind of business (e.g., "Pressure Washing", "Plumbing", "Restaurant")
- domain: Their website domain if known (e.g., "example.com")
- github_repo: Repository name — default to "astro-client-starter" unless told otherwise
- github_owner: GitHub org/user — default to "Bochi-Web" unless told otherwise
- notes: Any additional context about the project
- site_config: A JSON object with any structured data like address, phone, colors, services, etc.

Respond in this exact JSON format (no markdown, no code fences):

If you have enough info to create the client record:
{
  "action": "create_client",
  "reply": "A confirmation message summarizing what you're creating",
  "clientData": {
    "client_name": "...",
    "business_type": "...",
    "domain": "...",
    "github_repo": "...",
    "github_owner": "...",
    "notes": "...",
    "site_config": { ... }
  }
}

If you need more information:
{
  "action": "need_more_info",
  "reply": "Your follow-up question to the user"
}

Guidelines:
- At minimum you need the client/business name to create a record
- Be conversational and helpful — don't just list questions
- If the user gives you a lot of info at once, extract everything and create the record
- For site_config, structure any provided details (address, phone, services, colors, tagline, etc.) as a clean JSON object
- Default github_repo to "astro-client-starter" and github_owner to "Bochi-Web"
- Only respond with valid JSON`;

// ── Types ──

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface RequestBody {
  message: string;
  conversationHistory: ConversationMessage[];
}

// ── Request handler ──

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(req, res);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  // Auth check
  const user = await validateAuth(req, res);
  if (!user) return;

  try {
    const body = req.body as RequestBody;
    const { message, conversationHistory = [] } = body;

    if (!message) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: message',
      });
    }

    const apiKey = getEnv('OPENROUTER_API_KEY');

    // Build messages array
    const messages: any[] = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];

    for (const msg of conversationHistory) {
      messages.push({ role: msg.role, content: msg.content });
    }

    messages.push({ role: 'user', content: message });

    // Call OpenRouter
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://bochi-web.com',
        'X-Title': 'Bochi Web Client Intake',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        max_tokens: 2048,
        messages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} — ${errorText}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;

    if (!text) {
      throw new Error('Empty response from OpenRouter API');
    }

    // Parse Claude's JSON response
    const parsed = JSON.parse(text);

    return res.status(200).json({
      success: true,
      action: parsed.action,
      reply: parsed.reply,
      clientData: parsed.clientData || null,
    });
  } catch (error: any) {
    console.error('Client intake API error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to process intake request',
    });
  }
}
