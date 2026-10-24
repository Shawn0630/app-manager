// Minimal GitHub API client for Actions workflow runs.
// API base defaults to https://api.github.com and can be overridden
// with GITHUB_API_URL (GitHub Enterprise, or the mock server used by
// the tests). A token is taken from GITHUB_TOKEN when set: required
// for private repos, and it lifts the rate limit for public ones.
const API_BASE = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');

// Parse owner/repo out of the common GitHub remote URL shapes:
//   https://github.com/owner/repo(.git)
//   git@github.com:owner/repo(.git)
//   ssh://git@github.com/owner/repo(.git)
// Returns null for non-GitHub URLs.
export function parseRepo(repoUrl) {
  const s = String(repoUrl || '').trim();
  let m = s.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (m) return { owner: m[1], repo: m[2] };
  m = s.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

function normalizeRun(r) {
  return {
    id: r.id,
    workflowName: r.name || '',
    path: r.path || '',
    status: r.status || '',
    conclusion: r.conclusion || null,
    headSha: r.head_sha || null,
    branch: r.head_branch || null,
    event: r.event || '',
    htmlUrl: r.html_url || null,
    updatedAt: r.updated_at || null,
  };
}

function workflowMatches(app, run) {
  if (!app.workflow) return true;
  if (run.workflowName === app.workflow) return true;
  const base = run.path.split('/').pop();
  return base === app.workflow || run.path === app.workflow;
}

// Fetch recent workflow runs for the app's repo and return the ones
// matching the app filters (branch, event, workflow), newest first.
// Throws on HTTP/network errors; callers record the message.
export async function fetchWorkflowRuns(app, perPage = 10) {
  const parsed = parseRepo(app.repoUrl);
  if (!parsed) throw new Error(`repoUrl is not a GitHub URL: ${app.repoUrl}`);
  const url = new URL(`${API_BASE}/repos/${parsed.owner}/${parsed.repo}/actions/runs`);
  url.searchParams.set('branch', app.branch);
  url.searchParams.set('per_page', String(perPage));
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'app-manager',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`GitHub API HTTP ${res.status}${body ? `: ${body}` : ''}`);
  }
  const data = await res.json();
  const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs.map(normalizeRun) : [];
  const event = app.actionsEvent || 'push';
  return runs.filter(
    (r) => r.branch === app.branch && r.event === event && workflowMatches(app, r),
  );
}

// The newest completed run from fetchWorkflowRuns' output (the API
// returns newest first), or null.
export function latestCompletedRun(runs) {
  return runs.find((r) => r.status === 'completed') || null;
}
