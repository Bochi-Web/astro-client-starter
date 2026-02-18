import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { validateAuth } from './_auth.js';
import { getEnv, setCorsHeaders } from './_generate-prompts.js';

/**
 * POST /api/generate-commit
 * Creates an atomic GitHub commit with all generated files.
 * Uses the Git Data API: blobs → tree → commit → update ref.
 */

interface FileEntry {
  path: string;
  content: string;
  encoding?: 'utf-8' | 'base64';
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
    const { client_id, files } = req.body as {
      client_id: string;
      files: FileEntry[];
    };

    if (!client_id || !files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: client_id, files (non-empty array)',
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
      .select('id, client_name, site_config')
      .eq('id', client_id)
      .single();

    if (lookupError || !client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    const siteConfig = (client.site_config || {}) as Record<string, any>;
    const owner = siteConfig.github_owner as string;
    const repo = siteConfig.github_repo as string;
    const token = getEnv('GITHUB_TOKEN');

    if (!owner || !repo) {
      return res.status(400).json({
        success: false,
        message: 'Client is missing github_owner or github_repo in site_config',
      });
    }

    const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    };

    // 1. Get current HEAD ref
    const refRes = await fetch(`${apiBase}/git/ref/heads/main`, { headers });
    if (!refRes.ok) {
      throw new Error(`Failed to get HEAD ref: ${refRes.status}`);
    }
    const refData = await refRes.json();
    const headSha: string = refData.object.sha;

    // 2. Get the commit to find the base tree
    const commitRes = await fetch(`${apiBase}/git/commits/${headSha}`, { headers });
    if (!commitRes.ok) {
      throw new Error(`Failed to get commit: ${commitRes.status}`);
    }
    const commitData = await commitRes.json();
    const baseTreeSha: string = commitData.tree.sha;

    // 3. Create blobs for each file
    const treeEntries: Array<{
      path: string;
      mode: string;
      type: string;
      sha: string;
    }> = [];

    for (const file of files) {
      const blobRes = await fetch(`${apiBase}/git/blobs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          content: file.content,
          encoding: file.encoding || 'utf-8',
        }),
      });

      if (!blobRes.ok) {
        const errText = await blobRes.text();
        throw new Error(`Failed to create blob for ${file.path}: ${blobRes.status} — ${errText}`);
      }

      const blobData = await blobRes.json();
      treeEntries.push({
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: blobData.sha,
      });
    }

    // 4. Create new tree
    const treeRes = await fetch(`${apiBase}/git/trees`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: treeEntries,
      }),
    });

    if (!treeRes.ok) {
      const errText = await treeRes.text();
      throw new Error(`Failed to create tree: ${treeRes.status} — ${errText}`);
    }

    const treeData = await treeRes.json();

    // 5. Create commit
    const newCommitRes = await fetch(`${apiBase}/git/commits`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: `Generated site from creative brief\n\n${files.length} files generated for ${client.client_name}`,
        tree: treeData.sha,
        parents: [headSha],
      }),
    });

    if (!newCommitRes.ok) {
      const errText = await newCommitRes.text();
      throw new Error(`Failed to create commit: ${newCommitRes.status} — ${errText}`);
    }

    const newCommitData = await newCommitRes.json();

    // 6. Update ref to point to new commit
    const updateRefRes = await fetch(`${apiBase}/git/refs/heads/main`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        sha: newCommitData.sha,
      }),
    });

    if (!updateRefRes.ok) {
      const errText = await updateRefRes.text();
      throw new Error(`Failed to update ref: ${updateRefRes.status} — ${errText}`);
    }

    return res.status(200).json({
      success: true,
      data: {
        commit_sha: newCommitData.sha,
        commit_url: newCommitData.html_url,
      },
    });
  } catch (error: any) {
    console.error('generate-commit error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Commit failed',
    });
  }
}
