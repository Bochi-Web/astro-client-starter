import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { validateAuth } from './_auth.js';

/**
 * POST /api/create-site
 * Automated infrastructure creation for a new client site.
 * Creates GitHub repo from template, Vercel project, sets env vars,
 * triggers deploy, and updates the client record in Supabase.
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

// ── Slug helper ──

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Step results ──

interface StepResult {
  step: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

// ── Constants ──

const GITHUB_OWNER = 'Bochi-Web';
const TEMPLATE_REPO = 'astro-client-starter';
const VERCEL_TEAM_ID = 'team_E4Dn7b04H6O30YBuNWgCC9YC';

// ── Step A: Create GitHub repo from template ──

async function createGitHubRepo(slug: string, githubToken: string): Promise<StepResult> {
  // Idempotency: check if repo already exists
  const checkRes = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${slug}`, {
    headers: {
      'Authorization': `Bearer ${githubToken}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  });

  if (checkRes.ok) {
    return {
      step: 'create_repo',
      success: true,
      data: { repoName: slug, alreadyExisted: true },
    };
  }

  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${TEMPLATE_REPO}/generate`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        owner: GITHUB_OWNER,
        name: slug,
        description: `Client site: ${slug}`,
        private: true,
        include_all_branches: false,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    return {
      step: 'create_repo',
      success: false,
      error: `GitHub repo creation failed (${response.status}): ${errorText}`,
    };
  }

  return {
    step: 'create_repo',
    success: true,
    data: { repoName: slug, alreadyExisted: false },
  };
}

// ── Step B: Create Vercel project ──

async function createVercelProject(
  slug: string,
  vercelToken: string
): Promise<StepResult> {
  // Idempotency: check if project already exists
  const checkRes = await fetch(
    `https://api.vercel.com/v9/projects/${slug}?teamId=${VERCEL_TEAM_ID}`,
    { headers: { 'Authorization': `Bearer ${vercelToken}` } }
  );

  if (checkRes.ok) {
    const existing = await checkRes.json();
    return {
      step: 'create_project',
      success: true,
      data: {
        projectId: existing.id,
        url: `https://${slug}.vercel.app`,
        alreadyExisted: true,
      },
    };
  }

  const response = await fetch(
    `https://api.vercel.com/v10/projects?teamId=${VERCEL_TEAM_ID}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${vercelToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: slug,
        framework: 'astro',
        gitRepository: {
          type: 'github',
          repo: `${GITHUB_OWNER}/${slug}`,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    return {
      step: 'create_project',
      success: false,
      error: `Vercel project creation failed (${response.status}): ${errorText}`,
    };
  }

  const projectData = await response.json();
  return {
    step: 'create_project',
    success: true,
    data: {
      projectId: projectData.id,
      url: `https://${slug}.vercel.app`,
      alreadyExisted: false,
    },
  };
}

// ── Step C: Set environment variables on the new Vercel project ──

async function setVercelEnvVars(
  projectId: string,
  vercelToken: string,
  repoSlug: string
): Promise<StepResult> {
  const envVars = [
    { key: 'OPENROUTER_API_KEY', value: getEnv('OPENROUTER_API_KEY') },
    { key: 'GITHUB_TOKEN', value: getEnv('GITHUB_TOKEN') },
    { key: 'GITHUB_OWNER', value: GITHUB_OWNER },
    { key: 'GITHUB_REPO', value: repoSlug },
    { key: 'SUPABASE_URL', value: getEnv('SUPABASE_URL') },
    { key: 'SUPABASE_ANON_KEY', value: getEnv('SUPABASE_ANON_KEY') },
  ];

  const results: string[] = [];

  for (const envVar of envVars) {
    const response = await fetch(
      `https://api.vercel.com/v10/projects/${projectId}/env?teamId=${VERCEL_TEAM_ID}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${vercelToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          key: envVar.key,
          value: envVar.value,
          type: 'encrypted',
          target: ['production', 'preview', 'development'],
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      // Duplicate key is OK (idempotency)
      if (response.status === 400 && errorText.includes('already')) {
        results.push(`${envVar.key}: already set`);
        continue;
      }
      return {
        step: 'set_env_vars',
        success: false,
        error: `Failed to set ${envVar.key} (${response.status}): ${errorText}`,
      };
    }
    results.push(`${envVar.key}: set`);
  }

  return { step: 'set_env_vars', success: true, data: { vars: results } };
}

// ── Step D: Trigger deploy ──

async function triggerDeploy(
  slug: string,
  vercelToken: string
): Promise<StepResult> {
  const response = await fetch(
    `https://api.vercel.com/v13/deployments?teamId=${VERCEL_TEAM_ID}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${vercelToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: slug,
        project: slug,
        gitSource: {
          type: 'github',
          org: GITHUB_OWNER,
          repo: slug,
          ref: 'main',
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    return {
      step: 'trigger_deploy',
      success: false,
      error: `Deploy trigger failed (${response.status}): ${errorText}`,
    };
  }

  const deployData = await response.json();
  return {
    step: 'trigger_deploy',
    success: true,
    data: { deploymentId: deployData.id, url: deployData.url },
  };
}

// ── Request handler ──

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

    const githubToken = getEnv('GITHUB_TOKEN');
    const vercelToken = getEnv('BW_VERCEL_TOKEN');

    // Look up the client record (pass user's token so RLS sees an authenticated user)
    const supabaseUrl = getEnv('SUPABASE_URL');
    const supabaseKey = getEnv('SUPABASE_ANON_KEY');
    const userToken = (req.headers.authorization || '').replace('Bearer ', '');
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${userToken}` } },
    });

    const { data: clientRecord, error: lookupError } = await supabase
      .from('ai_website_clients')
      .select('id, client_name, status')
      .eq('id', client_id)
      .single();

    if (lookupError || !clientRecord) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    if (clientRecord.status !== 'setup') {
      return res.status(400).json({
        success: false,
        message: `Client is in "${clientRecord.status}" status, expected "setup"`,
      });
    }

    const slug = slugify(clientRecord.client_name);
    const completedSteps: StepResult[] = [];

    // Step A: Create GitHub repo from template
    const repoResult = await createGitHubRepo(slug, githubToken);
    completedSteps.push(repoResult);
    if (!repoResult.success) {
      return res.status(500).json({ success: false, message: repoResult.error, completedSteps });
    }

    // Step B: Create Vercel project
    const vercelResult = await createVercelProject(slug, vercelToken);
    completedSteps.push(vercelResult);
    if (!vercelResult.success) {
      return res.status(500).json({ success: false, message: vercelResult.error, completedSteps });
    }

    const projectId = vercelResult.data!.projectId as string;
    const vercelUrl = vercelResult.data!.url as string;

    // Step C: Set environment variables
    const envResult = await setVercelEnvVars(projectId, vercelToken, slug);
    completedSteps.push(envResult);
    if (!envResult.success) {
      return res.status(500).json({ success: false, message: envResult.error, completedSteps });
    }

    // Step D: Trigger deploy (non-fatal if it fails)
    const deployResult = await triggerDeploy(slug, vercelToken);
    completedSteps.push(deployResult);
    if (!deployResult.success) {
      console.error('Deploy trigger failed (non-fatal):', deployResult.error);
    }

    // Step E: Update client record in Supabase
    const { error: updateError } = await supabase
      .from('ai_website_clients')
      .update({
        github_repo: slug,
        github_owner: GITHUB_OWNER,
        vercel_url: vercelUrl,
        status: 'active',
        updated_at: new Date().toISOString(),
      })
      .eq('id', client_id);

    if (updateError) {
      completedSteps.push({ step: 'update_client', success: false, error: updateError.message });
      return res.status(500).json({ success: false, message: `Supabase update failed: ${updateError.message}`, completedSteps });
    }

    completedSteps.push({ step: 'update_client', success: true });

    return res.status(200).json({
      success: true,
      message: 'Site infrastructure created successfully',
      completedSteps,
      data: {
        github_repo: slug,
        github_owner: GITHUB_OWNER,
        vercel_url: vercelUrl,
      },
    });
  } catch (error: any) {
    console.error('Create-site API error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create site infrastructure',
    });
  }
}
