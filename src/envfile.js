// Per-app .env file reading and writing.
//
// Rules:
//  - The file lives at <workdir>/<envFile> (envFile defaults to ".env").
//  - Valid lines: KEY=VALUE, comments (# ...), blank lines.
//  - Values are NEVER written to any log or deployment record; only
//    changed key NAMES are recorded (see saveEnvFile).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { appendDeployment } from './deployments.js';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function envPathFor(app) {
  const root = path.resolve(app.workdir);
  const p = path.resolve(root, app.envFile || '.env');
  // The env file must stay inside the app's workdir.
  if (p !== root && !p.startsWith(root + path.sep)) {
    throw new Error(`envFile escapes the app workdir: ${app.envFile}`);
  }
  return p;
}

// Classify one line: { type: 'blank' | 'comment' | 'entry' | 'invalid', key?, value? }
export function classifyLine(rawLine) {
  const line = String(rawLine).replace(/\r$/, '');
  const trimmed = line.trim();
  if (!trimmed) return { type: 'blank' };
  if (trimmed.startsWith('#')) return { type: 'comment' };
  const eq = line.indexOf('=');
  if (eq > 0) {
    const key = line.slice(0, eq).trim();
    if (KEY_RE.test(key)) return { type: 'entry', key, value: line.slice(eq + 1) };
  }
  return { type: 'invalid' };
}

// Parse env text into ordered entries [{ key, value }] (comments and
// blank lines are not entries; use the raw text for those).
export function parseEnvText(text) {
  const entries = [];
  for (const line of String(text || '').split('\n')) {
    const c = classifyLine(line);
    if (c.type === 'entry') entries.push({ key: c.key, value: c.value });
  }
  return entries;
}

// Validate env text; returns the 1-based numbers of invalid lines.
export function invalidLines(text) {
  const bad = [];
  String(text || '').split('\n').forEach((line, i) => {
    if (classifyLine(line).type === 'invalid') bad.push(i + 1);
  });
  return bad;
}

export async function readEnvFile(app) {
  const p = envPathFor(app);
  try {
    const text = await fs.promises.readFile(p, 'utf8');
    return { exists: true, entries: parseEnvText(text), text };
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, entries: [], text: '' };
    throw e;
  }
}

// Compare two entry lists by key name only.
// Returns { added, removed, changed } — arrays of key NAMES, never values.
export function diffEnvKeys(oldEntries, newEntries) {
  const oldMap = new Map(oldEntries.map((e) => [e.key, e.value]));
  const newMap = new Map(newEntries.map((e) => [e.key, e.value]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, v] of newMap) {
    if (!oldMap.has(k)) added.push(k);
    else if (oldMap.get(k) !== v) changed.push(k);
  }
  for (const k of oldMap.keys()) {
    if (!newMap.has(k)) removed.push(k);
  }
  return { added, removed, changed };
}

async function backupCurrent(app, envPath) {
  const dir = path.join(DATA_DIR, 'backups', app.id);
  await fs.promises.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${stamp}.env`);
  await fs.promises.copyFile(envPath, dest);
  // Keep only the newest 10 backups (ISO-based names sort by time).
  const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.env')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 10))) {
    await fs.promises.unlink(path.join(dir, f)).catch(() => {});
  }
  return dest;
}

// Validate + atomically save the env file (temp file + rename in the
// same directory), back up the previous version first, and append a
// kind:"env" deployment record containing key names only.
// Throws an error with .badLines for invalid content, .code 'ENOENT'-ish
// errors propagate as normal errors. Returns the key diff.
export async function saveEnvFile(app, text) {
  const bad = invalidLines(text);
  if (bad.length) {
    const e = new Error(`invalid env line(s): ${bad.join(', ')}`);
    e.badLines = bad;
    throw e;
  }
  const envPath = envPathFor(app);
  const before = await readEnvFile(app);
  if (before.exists) await backupCurrent(app, envPath);
  const tmp = `${envPath}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, text, 'utf8');
  await fs.promises.rename(tmp, envPath);
  const diff = diffEnvKeys(before.entries, parseEnvText(text));
  await appendDeployment({
    ts: new Date().toISOString(),
    appId: app.id,
    kind: 'env',
    layer: 'static',
    trigger: 'manual',
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
  });
  return diff;
}
