// Two-layer environment model.
//
// Static layer: the app repo's own .env file (see envfile.js). It
// belongs to the repo, is edited through the Environment panel's
// Static section, and is NEVER modified by deployments.
//
// Dynamic layer: per-app overrides kept by the manager itself at
// DATA_DIR/dynamic/<appId>.json. They are applied at DEPLOYMENT
// time only (manual Update, commit polling, GitHub Actions, and
// env redeploys) — Start / Stop / Restart never apply them.
//
// How a deployment applies them (prepareDynamicOverride): the
// manager discovers the compose project's services with
// `docker compose config --services` and generates a small compose
// override file, DATA_DIR/overrides/<appId>/docker-compose.manager.json
// (JSON is valid compose), that sets `environment:` for every
// service from the dynamic entries. The deploy then passes it as an
// extra `-f` file, so containers really receive the dynamic values
// while the repo's .env stays byte-for-byte untouched. Per compose
// semantics, `environment:` entries also win over `env_file:` values
// for the same key, which is exactly the override behaviour wanted.
//
// After a deployment whose `up` step succeeded, a snapshot of WHICH
// keys were in effect and WHERE each came from (names + sources
// only, never values) is stored at DATA_DIR/in-use/<appId>.json.
// The "Currently in use" view reads that snapshot and resolves the
// values live from the static file + the dynamic store.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { run } from './run.js';
import { composeArgs } from './docker.js';
import { readEnvFile, parseEnvText, invalidLines, diffEnvKeys } from './envfile.js';
import { appendDeployment } from './deployments.js';

function safeFileName(appId) {
  return String(appId).replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function dynamicPath(appId) {
  return path.join(DATA_DIR, 'dynamic', `${safeFileName(appId)}.json`);
}

export function overridePathFor(appId) {
  return path.join(DATA_DIR, 'overrides', safeFileName(appId), 'docker-compose.manager.json');
}

export function inUsePath(appId) {
  return path.join(DATA_DIR, 'in-use', `${safeFileName(appId)}.json`);
}

// Ordered dynamic entries [{ key, value }] for one app (empty when
// no dynamic layer has been saved yet).
export async function readDynamicEntries(app) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(dynamicPath(app.id), 'utf8'));
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return entries
      .filter((e) => e && typeof e.key === 'string')
      .map((e) => ({ key: e.key, value: String(e.value ?? '') }));
  } catch {
    return [];
  }
}

export async function dynamicExists(app) {
  try {
    await fs.promises.access(dynamicPath(app.id));
    return true;
  } catch {
    return false;
  }
}

// Validate + store the dynamic layer from raw KEY=VALUE text (same
// line rules as the static file) and journal a kind:"env" record
// with layer:"dynamic" and key NAMES only. Throws with .badLines on
// invalid content. Returns the key diff, like saveEnvFile.
export async function saveDynamicEnv(app, text) {
  const bad = invalidLines(text);
  if (bad.length) {
    const e = new Error(`invalid env line(s): ${bad.join(', ')}`);
    e.badLines = bad;
    throw e;
  }
  const before = await readDynamicEntries(app);
  // Dedupe keys: first position wins, last value wins.
  const byKey = new Map();
  for (const e of parseEnvText(text)) byKey.set(e.key, e.value);
  const entries = [...byKey.entries()].map(([key, value]) => ({ key, value }));
  const file = dynamicPath(app.id);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, `${JSON.stringify({ entries, updatedAt: new Date().toISOString() }, null, 1)}\n`, 'utf8');
  await fs.promises.rename(tmp, file);
  const diff = diffEnvKeys(before, entries);
  await appendDeployment({
    ts: new Date().toISOString(),
    appId: app.id,
    kind: 'env',
    layer: 'dynamic',
    trigger: 'manual',
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
  });
  return diff;
}

// Merge static + dynamic entries into the effective list.
// Dynamic wins on duplicate keys; order is static order first, then
// dynamic-only keys in dynamic order. Each entry is annotated with
// its source; shadowed static keys are flagged overridden.
export function mergeEnvEntries(staticEntries, dynamicEntries) {
  const dynMap = new Map(dynamicEntries.map((e) => [e.key, e.value]));
  const seen = new Set();
  const entries = [];
  for (const e of staticEntries) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    if (dynMap.has(e.key)) entries.push({ key: e.key, value: dynMap.get(e.key), source: 'dynamic', overridden: true });
    else entries.push({ key: e.key, value: e.value, source: 'static', overridden: false });
  }
  for (const e of dynamicEntries) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    entries.push({ key: e.key, value: e.value, source: 'dynamic', overridden: false });
  }
  return {
    entries,
    overriddenKeys: entries.filter((e) => e.overridden).map((e) => e.key),
  };
}

// Prepare the compose override for one deployment. Returns
// { overridePath: null, dynamicKeys: [], entries } when the app has
// no dynamic entries (the deploy then runs exactly as before), or
// { overridePath, dynamicKeys, entries, services } with the override
// file (re)generated. Throws when service discovery fails — the
// caller records that as a failed "apply dynamic env" step, so a
// deployment that could not apply its overrides fails loudly
// instead of silently deploying without them.
export async function prepareDynamicOverride(app) {
  const entries = await readDynamicEntries(app);
  if (!entries.length) return { overridePath: null, dynamicKeys: [], entries, services: [] };
  const { stdout } = await run('docker', composeArgs(app, ['config', '--services']), { timeout: 60_000 });
  const services = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!services.length) throw new Error('docker compose config --services returned no services');
  const environment = {};
  for (const e of entries) {
    // Compose interpolates `environment:` values; $$ is the escape
    // for a literal dollar sign.
    environment[e.key] = e.value.replace(/\$/g, '$$$$');
  }
  const doc = { services: {} };
  for (const svc of services) doc.services[svc] = { environment };
  const file = overridePathFor(app.id);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(doc, null, 1)}\n`, 'utf8');
  await fs.promises.rename(tmp, file);
  return { overridePath: file, dynamicKeys: entries.map((e) => e.key), entries, services };
}

// Persist which env was in effect after a deployment: key names +
// sources only (merged entries WITHOUT values), the trigger, and
// the applied dynamic key names.
export async function writeInUseSnapshot(app, { ts, trigger, mergedEntries, dynamicKeys }) {
  const file = inUsePath(app.id);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const data = {
    ts,
    trigger,
    dynamicKeys,
    entries: mergedEntries.map((e) => ({ key: e.key, source: e.source, overridden: Boolean(e.overridden) })),
  };
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 1)}\n`, 'utf8');
  await fs.promises.rename(tmp, file);
  return data;
}

async function readInUseSnapshot(app) {
  try {
    return JSON.parse(await fs.promises.readFile(inUsePath(app.id), 'utf8'));
  } catch {
    return null;
  }
}

// Build the "Currently in use" view for one app. Values are resolved
// live from the current static file and the saved dynamic layer;
// the key set and sources come from the last deployment's snapshot.
// Without any applying deployment, this is the static layer alone,
// clearly labelled as such.
export async function currentInUse(app) {
  const [staticData, dynEntries, snap] = await Promise.all([
    readEnvFile(app).catch(() => ({ exists: false, entries: [] })),
    readDynamicEntries(app),
    readInUseSnapshot(app),
  ]);
  const staticMap = new Map(staticData.entries.map((e) => [e.key, e.value]));
  const dynMap = new Map(dynEntries.map((e) => [e.key, e.value]));
  const pendingDynamicKeys = dynEntries.map((e) => e.key);

  if (!snap || !Array.isArray(snap.entries)) {
    return {
      applied: false,
      deployedAt: null,
      trigger: null,
      note: 'Static values only — no deployment has applied dynamic overrides yet.',
      entries: staticData.entries.map((e) => ({
        key: e.key, value: e.value, source: 'static', overridden: false, stale: false,
      })),
      overriddenKeys: [],
      pendingDynamicKeys,
    };
  }

  const entries = snap.entries.map((se) => {
    const value = se.source === 'dynamic' ? dynMap.get(se.key) : staticMap.get(se.key);
    return {
      key: se.key,
      source: se.source,
      overridden: Boolean(se.overridden),
      value: value === undefined ? null : value,
      stale: value === undefined,
    };
  });
  const appliedDynamic = (snap.dynamicKeys || []).length > 0;
  return {
    applied: appliedDynamic,
    deployedAt: snap.ts || null,
    trigger: snap.trigger || null,
    note: appliedDynamic
      ? null
      : 'Static values only — the last deployment applied no dynamic overrides.',
    entries,
    overriddenKeys: entries.filter((e) => e.overridden).map((e) => e.key),
    pendingDynamicKeys,
  };
}
