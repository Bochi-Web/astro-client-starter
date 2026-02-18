import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

/**
 * /api/auth-token
 *
 * POST — Create a one-time login token for the editor.
 *   Receives: { supabaseToken: "..." }
 *   Returns:  { success: true, token: "abc123xyz" }
 *
 * GET  — Validate and consume a one-time token.
 *   Query:   ?token=abc123xyz
 *   Returns: { valid: true, email: "...", sessionToken: "..." } or { valid: false }
 *
 * The one-time token is stored in memory, expires after 60s, and is single-use.
 * If the serverless instance is cold (token lost), the user sees the normal
 * login screen as a fallback.
 */

// ── In-memory token store (persists while the serverless instance is warm) ──
const tokenStore = new Map<string, { email: string; sessionToken: string; expiresAt: number }>();

const TOKEN_TTL_MS = 60_000; // 60 seconds

function cleanupExpired() {
  const now = Date.now();
  for (const [key, val] of tokenStore) {
    if (val.expiresAt < now) tokenStore.delete(key);
  }
}

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── Handler ──
export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  cleanupExpired();

  // ── POST: Create one-time token ──
  if (req.method === 'POST') {
    const { supabaseToken } = req.body || {};

    if (!supabaseToken) {
      return res.status(400).json({ success: false, message: 'Missing supabaseToken' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ success: false, message: 'Server configuration error' });
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await supabase.auth.getUser(supabaseToken);

    if (error || !data.user) {
      return res.status(401).json({ success: false, message: 'Invalid session' });
    }

    // Generate a one-time token and store with the real session token
    const token = crypto.randomBytes(32).toString('hex');
    tokenStore.set(token, {
      email: data.user.email || '',
      sessionToken: supabaseToken,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });

    return res.status(200).json({ success: true, token });
  }

  // ── GET: Validate and consume token ──
  if (req.method === 'GET') {
    const token = req.query.token as string;

    if (!token) {
      return res.status(400).json({ valid: false, message: 'Missing token parameter' });
    }

    const stored = tokenStore.get(token);

    if (!stored || stored.expiresAt < Date.now()) {
      tokenStore.delete(token);
      return res.status(200).json({ valid: false });
    }

    // Consume — single use
    tokenStore.delete(token);

    return res.status(200).json({
      valid: true,
      email: stored.email,
      sessionToken: stored.sessionToken,
    });
  }

  return res.status(405).json({ success: false, message: 'Method not allowed' });
}
