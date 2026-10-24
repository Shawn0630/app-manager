// docker compose wrapper: every call is
// `docker compose -p <project> -f <composeFile> <sub...>`.
import path from 'node:path';
import { run } from './run.js';

export function composeArgs(app, sub) {
  return ['compose', '-p', app.projectName, '-f', path.join(app.workdir, app.composeFile), ...sub];
}

export function composeRun(app, sub, opts = {}) {
  return run('docker', composeArgs(app, sub), { timeout: 900_000, ...opts });
}

// Parse `docker compose ps --format json` output; two shapes exist:
//  - newer compose v2: a single JSON array
//  - older compose v2: one JSON object per line (NDJSON)
export function parseComposePs(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {
    // fall through to line-by-line parsing
  }
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // skip unparseable lines
    }
  }
  return out;
}

// Fallback parser for the "0.0.0.0:8088->8088/tcp, :::8088->8088/tcp"
// style Ports string.
function parsePortsString(portsStr) {
  const ports = [];
  const seen = new Set();
  for (const part of String(portsStr || '').split(',')) {
    const m = part.trim().match(/(?:\d{1,3}(?:\.\d{1,3}){3}|\[?::\]?):(\d+)->(\d+)\/(\w+)/);
    if (m) {
      const key = `${m[1]}/${m[3]}`;
      if (!seen.has(key)) {
        seen.add(key);
        ports.push({ published: Number(m[1]), target: Number(m[2]), protocol: m[3] });
      }
    }
  }
  return ports;
}

function normalizeContainer(c) {
  let ports = [];
  if (Array.isArray(c.Publishers) && c.Publishers.length) {
    const seen = new Set();
    for (const p of c.Publishers) {
      if (!p || !p.PublishedPort) continue;
      const key = `${p.PublishedPort}/${p.Protocol || 'tcp'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ports.push({
        published: Number(p.PublishedPort),
        target: Number(p.TargetPort) || null,
        protocol: p.Protocol || 'tcp',
      });
    }
  } else if (c.Ports) {
    ports = parsePortsString(c.Ports);
  }
  return {
    name: c.Name || c.name || '',
    service: c.Service || c.service || '',
    state: String(c.State || c.state || '').toLowerCase(),
    status: c.Status || c.status || '',
    health: c.Health || c.health || null,
    ports,
  };
}

// Query container state for an app. On command failure returns
// state=unknown with the error attached instead of throwing.
export async function composePs(app) {
  try {
    const { stdout } = await composeRun(app, ['ps', '--format', 'json'], { timeout: 60_000 });
    const containers = parseComposePs(stdout).map(normalizeContainer);
    let state;
    if (containers.length === 0) state = 'stopped';
    else if (containers.every((c) => c.state === 'running')) state = 'running';
    else if (containers.some((c) => c.state === 'running')) state = 'partial';
    else state = 'stopped';
    return { state, containers, error: null };
  } catch (e) {
    return { state: 'unknown', containers: [], error: e.stderr || e.message || String(e) };
  }
}

export async function composeLogs(app, tail) {
  const n = Math.min(2000, Math.max(1, Number(tail) || 200));
  const { stdout, stderr } = await composeRun(app, ['logs', '--no-color', '--tail', String(n)], { timeout: 60_000 });
  return `${stdout}${stderr}`;
}
