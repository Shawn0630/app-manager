// Config loading: CONFIG_PATH / DATA_DIR / PORT come from the environment,
// everything else has a default.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PORT = Number(process.env.PORT) || 9000;
export const CONFIG_PATH = process.env.CONFIG_PATH
  ? path.resolve(process.env.CONFIG_PATH)
  : path.join(ROOT, 'config', 'apps.json');
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');
// Where Add App clones new repositories (<APPS_ROOT>/<id>).
export const APPS_ROOT = process.env.APPS_ROOT
  ? path.resolve(process.env.APPS_ROOT)
  : path.join(ROOT, 'apps');

const TRIGGERS = new Set(['commit', 'actions', 'both', 'manual']);

export function normalizeApp(raw, idx) {
  if (!raw || typeof raw !== 'object') throw new Error(`apps[${idx}] is not an object`);
  if (!raw.id) throw new Error(`apps[${idx}] is missing id`);
  if (!raw.workdir) throw new Error(`app ${raw.id} is missing workdir`);
  return {
    id: String(raw.id),
    name: String(raw.name || raw.id),
    // How the app got into the registry: 'clone' (Add Project from
    // GitHub, cloned into APPS_ROOT) or 'local' (Add Project from a
    // local folder, registered in place — never copied or deleted).
    source: raw.source === 'local' ? 'local' : 'clone',
    // repoUrl is the app's GitHub remote when it has one; a local
    // folder without a git remote registers with repoUrl = null and
    // is managed locally only (no polling / Actions / git deploys).
    repoUrl: raw.repoUrl ? String(raw.repoUrl) : null,
    workdir: String(raw.workdir),
    envFile: String(raw.envFile || '.env'),
    branch: String(raw.branch || 'main'),
    composeFile: String(raw.composeFile || 'docker-compose.yml'),
    projectName: String(raw.projectName || raw.id),
    port: raw.port == null ? null : Number(raw.port),
    autoDeploy: Boolean(raw.autoDeploy),
    pollIntervalSec: Math.max(1, Number(raw.pollIntervalSec) || 120),
    provider: String(raw.provider || 'builtin'),
    // What may automatically start a deployment when autoDeploy is on:
    // 'commit' (ls-remote polling), 'actions' (GitHub Actions runs),
    // 'both', or 'manual' (nothing automatic).
    trigger: TRIGGERS.has(raw.trigger) ? raw.trigger : 'commit',
    workflow: raw.workflow ? String(raw.workflow) : '',
    actionsEvent: raw.actionsEvent ? String(raw.actionsEvent) : 'push',
    // Registration-time problem (clone failed, no compose file, ...).
    // Persisted so it survives restarts and shows on the card.
    warning: raw.warning ? String(raw.warning) : null,
  };
}

export function loadApps() {
  const text = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : parsed.apps;
  if (!Array.isArray(list)) throw new Error('config must be shaped as { "apps": [...] }');
  const apps = list.map(normalizeApp);
  const seen = new Set();
  for (const app of apps) {
    if (seen.has(app.id)) throw new Error(`duplicate app id: ${app.id}`);
    seen.add(app.id);
  }
  return apps;
}

// Persist the registry back to CONFIG_PATH (atomic: temp file +
// rename in the same directory). Used when apps are added/removed
// through the API.
export function saveApps(apps) {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ apps }, null, 1)}\n`, 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}
