// Deployment records: data/deployments.jsonl, one JSON object per line,
// append-only.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'deployments.jsonl');

export function deploymentsFile() {
  return FILE;
}

export async function appendDeployment(record) {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  await fs.promises.appendFile(FILE, `${JSON.stringify(record)}\n`, 'utf8');
}

function readAllSync() {
  try {
    const text = fs.readFileSync(FILE, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        // skip corrupt lines
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Latest `limit` deployments across all apps, newest first.
export function listDeployments(limit = 20) {
  const all = readAllSync();
  return all.slice(-Math.max(1, limit)).reverse();
}

// Most recent real deployment for one app (kind "env" records from
// .env edits are not deployments and are skipped). Null when none.
export function lastDeploymentFor(appId) {
  const all = readAllSync();
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i].appId === appId && all[i].kind !== 'env') return all[i];
  }
  return null;
}
