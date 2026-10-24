// Small persisted state in DATA_DIR/state.json — currently just the
// GitHub Actions trigger bookkeeping: which run id each app has
// already consumed, so a restart never re-triggers an old run.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'state.json');
let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    cache = {};
  }
  if (!cache.apps || typeof cache.apps !== 'object') cache.apps = {};
  return cache;
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 1)}\n`, 'utf8');
  fs.renameSync(tmp, FILE);
}

export function getLastActionRunId(appId) {
  const s = load();
  const v = s.apps[appId] && s.apps[appId].lastActionRunId;
  return typeof v === 'number' ? v : null;
}

export function setLastActionRunId(appId, id) {
  const s = load();
  s.apps[appId] = { ...(s.apps[appId] || {}), lastActionRunId: id };
  persist();
}

export function clearAppState(appId) {
  const s = load();
  if (s.apps[appId]) {
    delete s.apps[appId];
    persist();
  }
}
