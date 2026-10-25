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
import * as git from './git.js';
import { parseRepo } from './github.js';

const COMPOSE_CANDIDATES = ['docker-compose.yml', 'compose.yml', 'compose.yaml'];

// Exported for the folder browser (src/browse.js), which reports
// the same detection for the folder being picked.
export function detectComposeFile(workdir) {
  return COMPOSE_CANDIDATES.find((f) => fs.existsSync(path.join(workdir, f))) || null;
}

function noComposeWarning() {
  return `no compose file found in repo root (looked for ${COMPOSE_CANDIDATES.join(' / ')})`;
}

function dedupId(baseId, existingIds) {
  let id = baseId;
  let n = 2;
  while (existingIds.has(id)) {
    id = `${baseId}-${n}`;
    n += 1;
  }
  return id;
}

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
  const id = dedupId(appIdFromRepo(repoUrl), existingIds);
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
    const found = detectComposeFile(workdir);
    if (found) composeFile = found;
    else warning = noComposeWarning();
  }

  const app = normalizeApp({
    id,
    name,
    source: 'clone',
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

// Add Project from a local folder: register a directory that already
// exists on this machine, IN PLACE. Nothing is copied, moved, or
// cloned — workdir is the folder itself, and removing the app later
// only unregisters it (the folder is never deleted; see the purge
// guard in server.js).
//
// When the folder is a git repo with an "origin" remote, the remote
// URL becomes the app's repoUrl and the app gets the full GitHub
// feature set — commit polling, Actions watching, pull-based
// deploys — because all of those key off repoUrl, not off how the
// app was added. Both ssh (git@github.com:owner/repo.git) and https
// remote shapes are recognized by github.js' parseRepo. A folder
// without a git remote registers with repoUrl = null and an explicit
// warning: it can be started/stopped and rebuilt, but nothing can be
// watched or pulled.
export async function registerLocalApp(input, existingIds) {
  const rawPath = String((input && input.path) || '').trim();
  if (!rawPath) {
    const err = new Error('path is required');
    err.status = 400;
    throw err;
  }
  // Nothing expands "~" here — path.resolve would silently turn it
  // into "<cwd>/~/...". Say so instead of reporting a nonsense path.
  if (rawPath.startsWith('~')) {
    const err = new Error(`path must be the full absolute path — "~" is not expanded (you entered: ${rawPath})`);
    err.status = 400;
    throw err;
  }
  const workdir = path.resolve(rawPath);
  if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
    // From the manager's point of view (usually a container) a host
    // folder that was never mounted in simply does not exist. The
    // bare "not found" used to leave users guessing, so name the fix.
    const err = new Error(
      `local folder not found: ${workdir} — the manager can only see folders mounted into its container. `
      + "Add a same-path volume mount for this folder (or its parent directory) in the manager's docker-compose.yml, restart the manager, then enter the full absolute path.",
    );
    err.status = 400;
    throw err;
  }

  const warnings = [];
  const found = detectComposeFile(workdir);
  const composeFile = found || 'docker-compose.yml';
  if (!found) warnings.push(noComposeWarning());

  let repoUrl = null;
  let detectedBranch = null;
  if (await git.isGitRepo(workdir)) {
    repoUrl = await git.remoteUrl(workdir, 'origin');
    detectedBranch = await git.currentBranch(workdir);
    if (!repoUrl) {
      warnings.push('git repo without an "origin" remote: no GitHub connection — polling, Actions watching and pull-based deploys are unavailable');
    } else if (!parseRepo(repoUrl)) {
      warnings.push(`origin remote is not a GitHub URL (${repoUrl}): GitHub Actions watching is unavailable`);
    }
  } else {
    warnings.push('not a git repository: no GitHub connection — polling, Actions watching and pull-based deploys are unavailable; the app can still be started, stopped and rebuilt');
  }

  const folderName = path.basename(workdir);
  const id = dedupId(appIdFromRepo(folderName), existingIds);
  const branch = String((input && input.branch) || '').trim() || detectedBranch || 'main';
  const warning = warnings.length ? warnings.join('; ') : null;

  const app = normalizeApp({
    id,
    name: String((input && input.name) || '').trim() || folderName,
    source: 'local',
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
