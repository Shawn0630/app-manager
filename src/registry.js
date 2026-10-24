// Add App: turn a repository URL into a registered app.
// The repo is cloned into APPS_ROOT/<id>. Registration always
// succeeds when the input is basically valid — problems (clone
// failed, no compose file) are stored as a `warning` on the app and
// shown on its card, so nothing is silently dropped and the user
// can fix the repo and use Update later.
import fs from 'node:fs';
import path from 'node:path';
import { APPS_ROOT, normalizeApp } from './config.js';
import { run, tailText } from './run.js';

const COMPOSE_CANDIDATES = ['docker-compose.yml', 'compose.yml', 'compose.yaml'];

export function repoBaseName(repoUrl) {
  const s = String(repoUrl || '').trim().replace(/\.git\/?$/, '');
  const parts = s.split(/[/:\\]/).filter(Boolean);
  return parts[parts.length - 1] || 'app';
}

export function appIdFromRepo(repoUrl) {
  const slug = repoBaseName(repoUrl)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'app';
}

export async function registerApp(input, existingIds) {
  const repoUrl = String((input && input.repoUrl) || '').trim();
  if (!repoUrl) {
    const err = new Error('repoUrl is required');
    err.status = 400;
    throw err;
  }
  let id = appIdFromRepo(repoUrl);
  const base = id;
  let n = 2;
  while (existingIds.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  const name = String((input && input.name) || '').trim() || repoBaseName(repoUrl);
  const branch = String((input && input.branch) || '').trim() || 'main';
  const workdir = path.join(APPS_ROOT, id);
  let warning = null;
  let composeFile = 'docker-compose.yml';

  fs.mkdirSync(APPS_ROOT, { recursive: true });
  const dirExists = fs.existsSync(workdir) && fs.readdirSync(workdir).length > 0;
  if (dirExists) {
    warning = `workdir already exists (${workdir}); clone skipped`;
  } else {
    try {
      await run('git', ['clone', '--branch', branch, '--', repoUrl, workdir], { timeout: 600_000 });
    } catch (e) {
      warning = `clone failed: ${tailText(e.output || e.message || String(e), 3, 300)}`;
    }
  }
  if (!warning) {
    const found = COMPOSE_CANDIDATES.find((f) => fs.existsSync(path.join(workdir, f)));
    if (found) composeFile = found;
    else warning = `no compose file found in repo root (looked for ${COMPOSE_CANDIDATES.join(' / ')})`;
  }

  const app = normalizeApp({
    id,
    name,
    repoUrl,
    workdir,
    branch,
    composeFile,
    projectName: id,
    port: input && input.port != null && input.port !== '' ? Number(input.port) : null,
    autoDeploy: Boolean(input && input.autoDeploy),
    pollIntervalSec: input && input.pollIntervalSec,
    trigger: input && input.trigger,
    workflow: input && input.workflow,
    actionsEvent: input && input.actionsEvent,
    provider: 'builtin',
    warning,
  });
  return { app, warning };
}

// Purge safety: a workdir may only be deleted when it lives strictly
// inside APPS_ROOT.
export function isInsideAppsRoot(workdir) {
  const root = path.resolve(APPS_ROOT);
  const wd = path.resolve(workdir);
  return wd !== root && wd.startsWith(root + path.sep);
}
