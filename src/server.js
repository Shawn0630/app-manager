// app-manager: LAN dashboard + auto-deploy service for Docker apps.
//
// Routes:
//   GET    /api/health
//   GET    /api/apps                   status of every registered app
//   POST   /api/apps                   add an app by cloning its repo
//   DELETE /api/apps/:id[?purge=1]     remove an app (purge: + workdir)
//   POST   /api/apps/:id/start|stop|restart|update|check|redeploy
//   GET    /api/apps/:id/logs?tail=200
//   GET/PUT /api/apps/:id/env            static layer (repo .env)
//   GET/PUT /api/apps/:id/env/dynamic    dynamic layer (deploy-time overrides)
//   GET    /api/apps/:id/env/current     "currently in use" effective env
//   GET    /api/deployments?limit=20
// Everything else is the static dashboard in public/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { PORT, CONFIG_PATH, DATA_DIR, APPS_ROOT, loadApps, saveApps } from './config.js';
import { appStatus } from './status.js';
import { composeRun, composeLogs } from './docker.js';
import { listDeployments, appendActionRecord } from './deployments.js';
import { tagsForRecord, failedStepOf } from './activity.js';
import { readDynamicEntries, dynamicExists, saveDynamicEnv, currentInUse } from './dynenv.js';
import { runOp, BusyError } from './ops.js';
import { appState } from './store.js';
import { readEnvFile, saveEnvFile } from './envfile.js';
import { getProvider } from './providers/index.js';
import { startPollers, watchApp, unwatchApp } from './poller.js';
import { registerApp, isInsideAppsRoot } from './registry.js';
import { refreshRuns } from './actionsWatch.js';
import { clearAppState } from './appstate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let apps;
try {
  apps = loadApps();
} catch (e) {
  console.error(`Failed to load config ${CONFIG_PATH}: ${e.message}`);
  process.exit(1);
}
const byId = new Map(apps.map((a) => [a.id, a]));

const app = express();
app.disable('x-powered-by');

// Optional HTTP Basic auth: enabled only when MANAGER_PASSWORD is set.
// Covers every route, API and static files alike.
const managerPassword = process.env.MANAGER_PASSWORD || '';
if (managerPassword) {
  const managerUser = process.env.MANAGER_USER || 'admin';
  const expectedUser = Buffer.from(managerUser);
  const expectedPass = Buffer.from(managerPassword);
  const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const m = header.match(/^Basic (.+)$/i);
    let ok = false;
    if (m) {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx >= 0) {
        ok = eq(Buffer.from(decoded.slice(0, idx)), expectedUser)
          && eq(Buffer.from(decoded.slice(idx + 1)), expectedPass);
      }
    }
    if (!ok) {
      res.set('WWW-Authenticate', 'Basic realm="app-manager"');
      return res.status(401).send('Authentication required');
    }
    return next();
  });
  console.log(`Basic auth enabled (user: ${managerUser})`);
}

app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/apps', async (req, res) => {
  const out = [];
  for (const a of apps) out.push(await appStatus(a));
  res.json({ apps: out });
});

// Add App: clone the repo into APPS_ROOT/<id> and register it. Always
// registered on success (HTTP 201) — clone/compose problems come back
// as a `warning` on the app instead of an error. Adds are serialized
// because they mutate the registry file.
let addChain = Promise.resolve();
app.post('/api/apps', (req, res) => {
  const job = addChain.then(async () => {
    const { app: newApp, warning } = await registerApp(req.body || {}, new Set(apps.map((x) => x.id)));
    apps.push(newApp);
    byId.set(newApp.id, newApp);
    saveApps(apps);
    watchApp(newApp);
    return { newApp, warning };
  });
  addChain = job.catch(() => {});
  job.then(
    ({ newApp, warning }) => res.status(201).json({ ok: true, app: newApp, warning }),
    (e) => res.status(e.status || 500).json({ error: e.message || String(e) }),
  );
});

// Remove an app from the registry. The workdir is kept unless
// ?purge=1 is given, and purging is only allowed for workdirs inside
// APPS_ROOT. The dashboard only uses the plain removal.
app.delete('/api/apps/:id', async (req, res) => {
  const a = byId.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'app not found' });
  if (appState(a.id).busy) {
    return res.status(409).json({ error: `app ${a.id} is busy, try again later` });
  }
  const purge = req.query.purge === '1';
  if (purge && !isInsideAppsRoot(a.workdir)) {
    return res.status(400).json({ error: 'purge refused: workdir is outside APPS_ROOT' });
  }
  try {
    if (purge) await fs.promises.rm(a.workdir, { recursive: true, force: true });
  } catch (e) {
    return res.status(500).json({ error: `purge failed: ${e.message}` });
  }
  const idx = apps.findIndex((x) => x.id === a.id);
  if (idx >= 0) apps.splice(idx, 1);
  byId.delete(a.id);
  saveApps(apps);
  unwatchApp(a.id);
  clearAppState(a.id);
  return res.json({ ok: true, removed: a.id, purged: purge });
});

app.get('/api/deployments', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 20));
  // Each record is annotated with display tags (kind / action /
  // trigger / result / failed step) computed server-side, so the
  // dashboard renders chips instead of decoding raw fields.
  const deployments = listDeployments(limit).map((d) => ({
    ...d,
    tags: tagsForRecord(d),
    failedStep: failedStepOf(d),
  }));
  res.json({ deployments });
});

app.get('/api/apps/:id/logs', async (req, res) => {
  const a = byId.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'app not found' });
  try {
    const logs = await composeLogs(a, req.query.tail);
    return res.json({ logs });
  } catch (e) {
    return res.status(502).json({ error: e.stderr || e.message || String(e) });
  }
});

// Read one app's .env file (existence, ordered entries, raw text).
// This is the ONLY endpoint that returns env values.
app.get('/api/apps/:id/env', async (req, res) => {
  const a = byId.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'app not found' });
  try {
    const data = await readEnvFile(a);
    return res.json({ envFile: a.envFile, ...data });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// Replace one app's .env file with the posted full text. The text is
// validated line by line first (KEY=VALUE / comment / blank); invalid
// lines are rejected with 400 and their line numbers. The write is
// atomic (temp file + rename), the previous version is backed up, and
// only the changed KEY NAMES are recorded — never values.
app.put('/api/apps/:id/env', async (req, res) => {
  const a = byId.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'app not found' });
  const text = req.body && typeof req.body.text === 'string' ? req.body.text : null;
  if (text === null) return res.status(400).json({ error: 'body must be { "text": "..." }' });
  if (appState(a.id).busy) {
    return res.status(409).json({ error: `app ${a.id} is busy, try again later` });
  }
  try {
    const diff = await saveEnvFile(a, text);
    return res.json({ ok: true, ...diff });
  } catch (e) {
    if (e.badLines) return res.status(400).json({ error: e.message, badLines: e.badLines });
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// Read one app's DYNAMIC env layer (manager-kept overrides, applied
// at deployment time). Like the static env endpoint, this returns
// values — it is an editor endpoint.
app.get('/api/apps/:id/env/dynamic', async (req, res) => {
  const a = byId.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'app not found' });
  try {
    const [entries, exists] = await Promise.all([readDynamicEntries(a), dynamicExists(a)]);
    return res.json({ exists, entries });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// Replace one app's dynamic layer from posted KEY=VALUE text (same
// validation as the static file). Only key names are journaled.
// Takes effect at the NEXT deployment; running containers and
// Start/Stop/Restart are unaffected until then.
app.put('/api/apps/:id/env/dynamic', async (req, res) => {
  const a = byId.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'app not found' });
  const text = req.body && typeof req.body.text === 'string' ? req.body.text : null;
  if (text === null) return res.status(400).json({ error: 'body must be { "text": "..." }' });
  if (appState(a.id).busy) {
    return res.status(409).json({ error: `app ${a.id} is busy, try again later` });
  }
  try {
    const diff = await saveDynamicEnv(a, text);
    return res.json({ ok: true, ...diff });
  } catch (e) {
    if (e.badLines) return res.status(400).json({ error: e.message, badLines: e.badLines });
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// The "Currently in use" view: the effective env of the most recent
// deployment (static + dynamic merged, per-key source), resolved
// live; before any applying deployment, the static layer alone.
app.get('/api/apps/:id/env/current', async (req, res) => {
  const a = byId.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'app not found' });
  try {
    return res.json(await currentInUse(a));
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

const ACTIONS = new Set(['start', 'stop', 'restart', 'update', 'check', 'redeploy']);

// Run one lifecycle action (start/stop/restart) and journal it as a
// kind:"action" record — success or failure — so the Activity panel
// shows these operations too, not only deployments. The record is
// written before the error propagates (runOp logs it), so a failed
// start is visible in history as well.
async function runAction(a, action, sub) {
  const startedAt = Date.now();
  try {
    const { output } = await composeRun(a, sub);
    await appendActionRecord({
      appId: a.id, action, result: 'success',
      durationMs: Date.now() - startedAt, output,
    });
  } catch (e) {
    await appendActionRecord({
      appId: a.id, action, result: 'failed',
      durationMs: Date.now() - startedAt, output: e.output || e.stderr || e.message || String(e),
    }).catch(() => {});
    throw e;
  }
}

app.post('/api/apps/:id/:action', (req, res) => {
  const a = byId.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'app not found' });
  const action = req.params.action;
  if (!ACTIONS.has(action)) return res.status(404).json({ error: 'unknown action' });
  const provider = getProvider(a.provider);
  try {
    if (action === 'start') runOp(a, 'start', () => runAction(a, 'start', ['up', '-d']));
    else if (action === 'stop') runOp(a, 'stop', () => runAction(a, 'stop', ['stop']));
    else if (action === 'restart') runOp(a, 'restart', () => runAction(a, 'restart', ['restart']));
    else if (action === 'update') runOp(a, 'update', () => provider.deploy(a, 'manual'));
    else if (action === 'redeploy') {
      if (typeof provider.redeploy !== 'function') return res.status(400).json({ error: `provider ${a.provider} does not support redeploy` });
      runOp(a, 'redeploy', () => provider.redeploy(a, 'manual-env'));
    }
    else if (action === 'check') {
      // Manual refresh of both watch sources (caches only; automatic
      // deployment decisions happen in the poller ticks).
      runOp(a, 'check', async () => {
        await provider.checkRemote(a);
        if (a.trigger === 'actions' || a.trigger === 'both') await refreshRuns(a);
      });
    }
  } catch (e) {
    if (e instanceof BusyError) return res.status(409).json({ error: e.message, busyWith: e.op });
    throw e;
  }
  return res.status(202).json({ ok: true, started: action });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

fs.mkdirSync(DATA_DIR, { recursive: true });
startPollers(apps);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`app-manager listening on http://0.0.0.0:${PORT}`);
  console.log(`config: ${CONFIG_PATH} (${apps.length} app(s)), data dir: ${DATA_DIR}, apps root: ${APPS_ROOT}`);
});
