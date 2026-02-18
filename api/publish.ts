import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { validateAuth } from './_auth.js';

/**
 * POST /api/publish
 * Commits one or more edited files to GitHub in a single commit
 * using the Git Trees API. Vercel auto-deploys on push.
 */

// ── Environment variables ──

function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing environment variable: ${key}`);
  return value;
}

// ── GitHub API helpers ──

async function ghApi(path: string, options: RequestInit = {}): Promise<any> {
  const token = getEnv('GITHUB_TOKEN');
  const owner = getEnv('GITHUB_OWNER');
  const repo = getEnv('GITHUB_REPO');

  const url = `https://api.github.com/repos/${owner}/${repo}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub API error (${response.status}) on ${path}: ${errorText}`);
  }

  return response.json();
}

// ── Types ──

interface EditEntry {
  filePath: string;
  modifiedCode: string;
  section: string;
  description: string;
}

interface RequestBody {
  edits: EditEntry[];
  commitMessage: string;
}

// ── Request handler ──

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  // Auth check
  const user = await validateAuth(req, res);
  if (!user) return;

  try {
    const body = req.body as RequestBody;
    const { edits, commitMessage } = body;

    if (!edits || edits.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No edits to publish',
      });
    }

    if (!commitMessage) {
      return res.status(400).json({
        success: false,
        message: 'Missing commit message',
      });
    }

    // 1. Get the current commit SHA from main branch
    const refData = await ghApi('/git/ref/heads/main');
    const currentCommitSha = refData.object.sha;

    // 2. Get the tree SHA from that commit
    const commitData = await ghApi(`/git/commits/${currentCommitSha}`);
    const currentTreeSha = commitData.tree.sha;

    // 3. Create a new tree with the modified files
    const tree = edits.map((edit) => ({
      path: edit.filePath,
      mode: '100644' as const,
      type: 'blob' as const,
      content: edit.modifiedCode,
    }));

    const newTree = await ghApi('/git/trees', {
      method: 'POST',
      body: JSON.stringify({
        base_tree: currentTreeSha,
        tree,
      }),
    });

    // 4. Create a new commit pointing to that tree
    const newCommit = await ghApi('/git/commits', {
      method: 'POST',
      body: JSON.stringify({
        message: commitMessage,
        tree: newTree.sha,
        parents: [currentCommitSha],
      }),
    });

    // 5. Update the main branch ref to point to the new commit
    await ghApi('/git/refs/heads/main', {
      method: 'PATCH',
      body: JSON.stringify({
        sha: newCommit.sha,
      }),
    });

    // ── Track edits in Supabase (best-effort, don't fail publish) ──
    try {
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_ANON_KEY;
      const githubRepo = process.env.GITHUB_REPO;

      if (supabaseUrl && supabaseKey && githubRepo) {
        const supabase = createClient(supabaseUrl, supabaseKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        // Look up the client record by github_repo
        const { data: client } = await supabase
          .from('ai_website_clients')
          .select('id, total_edits')
          .eq('github_repo', githubRepo)
          .single();

        if (client) {
          const now = new Date().toISOString();
          const owner = getEnv('GITHUB_OWNER');
          const commitUrl = `https://github.com/${owner}/${githubRepo}/commit/${newCommit.sha}`;

          // Update the client record
          await supabase
            .from('ai_website_clients')
            .update({
              last_edited_at: now,
              last_edited_by: user.email,
              last_published_at: now,
              total_edits: (client.total_edits || 0) + edits.length,
              updated_at: now,
            })
            .eq('id', client.id);

          // Insert edit history rows
          const historyRows = edits.map((edit) => ({
            client_id: client.id,
            editor_email: user.email,
            section: edit.section,
            description: edit.description || `Edited ${edit.section}`,
            commit_sha: newCommit.sha,
            commit_url: commitUrl,
          }));

          await supabase
            .from('ai_website_edit_history')
            .insert(historyRows);
        }
      }
    } catch (trackingError: any) {
      // Log but don't fail the publish
      console.error('Edit tracking error (non-fatal):', trackingError.message);
    }

    return res.status(200).json({
      success: true,
      commitSha: newCommit.sha,
      commitUrl: newCommit.html_url,
      message: `${edits.length} file${edits.length !== 1 ? 's' : ''} updated successfully`,
    });
  } catch (error: any) {
    console.error('Publish API error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to publish changes',
    });
  }
}
