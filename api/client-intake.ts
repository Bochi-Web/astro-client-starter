import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateAuth } from './_auth';

/**
 * POST /api/client-intake
 * Creative brief conversation for new client sites.
 * Called from the BWCC NewClientChat dialog.
 * Claude acts as a creative director gathering design & content requirements.
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

// ── System prompt for creative brief ──

const SYSTEM_PROMPT = `You are a creative director at a web design agency helping build a client brief. You're having a conversation to gather everything needed to build their website. Be conversational and enthusiastic.

When the conversation starts, you'll receive the structured fields (business name, domain, current website URL if provided) as a [Client info: ...] block in the user's first message.

Your job:
1. Acknowledge what you know so far
2. If a current website URL was provided, note that it will be scraped for content later
3. Ask about design preferences:
   - What vibe/mood? (modern, classic, bold, minimal, etc.)
   - Color preferences? Any brand colors to keep or change?
   - Sites they admire or want to look like?
   - What feeling should visitors get?
4. Ask about content priorities:
   - What's most important to highlight?
   - Any specific services or offerings to feature?
   - Testimonials or reviews they want included?
   - Calls to action — what should visitors do?
5. Ask about anything else:
   - Photos they want to use?
   - Specific pages beyond the standard set?
   - Any features they need (booking, forms, etc.)?

Don't ask everything at once. Have a natural conversation — ask 2-3 questions at a time based on what they've shared so far.

When URLs are pasted, acknowledge them as reference sites and note what style elements you'd draw from them.
When images are shared, describe what you see and incorporate the visual direction into the brief.

RESPONSE FORMAT — always respond with valid JSON, no markdown code fences:

For regular conversation:
{
  "action": "continue",
  "reply": "Your conversational response here"
}

When the user's message contains [FINALIZE_BRIEF], compile everything discussed into a structured creative brief:
{
  "action": "brief_complete",
  "reply": "A conversational summary of the brief for the user to read",
  "creativeBrief": {
    "business_type": "Type of business",
    "design_direction": "Overall design direction and mood",
    "color_preferences": "Color palette notes",
    "target_audience": "Who the site is for",
    "content_priorities": ["Priority 1", "Priority 2"],
    "services_to_feature": ["Service 1", "Service 2"],
    "reference_sites": ["site1.com", "site2.com"],
    "calls_to_action": ["CTA 1", "CTA 2"],
    "special_features": ["Feature 1", "Feature 2"],
    "pages": ["Home", "Services", "About", "Contact"],
    "notes": "Any additional context or requirements"
  }
}

Only include fields in creativeBrief that were actually discussed. Omit fields that weren't covered.
Always respond with valid JSON only — no markdown, no code fences, no extra text.`;

// ── Types ──

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface RequestBody {
  message: string;
  conversationHistory: ConversationMessage[];
  referenceImages?: string[]; // base64 data URLs for vision
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
    const { message, conversationHistory = [], referenceImages } = body;

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

    // Build user message with optional image content blocks
    if (referenceImages && referenceImages.length > 0) {
      const contentBlocks: any[] = [];
      for (const img of referenceImages) {
        contentBlocks.push({ type: 'image_url', image_url: { url: img } });
      }
      contentBlocks.push({ type: 'text', text: message });
      messages.push({ role: 'user', content: contentBlocks });
    } else {
      messages.push({ role: 'user', content: message });
    }

    // Call OpenRouter
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://bochi-web.com',
        'X-Title': 'Bochi Web Creative Brief',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        max_tokens: 4096,
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
      creativeBrief: parsed.creativeBrief || null,
    });
  } catch (error: any) {
    console.error('Client intake API error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to process intake request',
    });
  }
}
