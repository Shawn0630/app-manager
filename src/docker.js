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

// Parse `docker compose ps --format json` output. Real Compose v2
// output comes in two shapes:
//  - newer compose v2: a single JSON array (one line, compact)
//  - older compose v2: one JSON object per line (NDJSON)
// and stdout is not guaranteed to be pure JSON: compose and Docker
// Desktop can print human warning lines (obsolete `version`
// attribute notices, plugin hints, ...) before or after the payload.
// The parser therefore tries, in order:
//  1. the whole output as JSON,
//  2. line by line (NDJSON, or one compact array on its own line),
//     flattening any line that parses to an array and skipping
//     lines that do not parse at all,
//  3. the outermost [...] slice — last resort for a pretty-printed
//     array surrounded by noise; accepted only when the items look
//     like containers, so an inner array (e.g. a Publishers list
//     inside an NDJSON object) is never mistaken for the payload.
export function parseComposePs(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];

  const asList = (v) => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') return [v];
    return null;
  };

  try {
    const list = asList(JSON.parse(text));
    if (list) return list;
  } catch {
    // not pure JSON — keep digging
  }

  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) continue;
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) out.push(...parsed);
      else if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      // noise line (warning, banner, ...) — skip it
    }
  }
  if (out.length) return out;

  const open = text.indexOf('[');
  const close = text.lastIndexOf(']');
  if (open >= 0 && close > open) {
    try {
      const list = asList(JSON.parse(text.slice(open, close + 1)));
      const looksLikeContainers = list && list.some(
        (c) => c && typeof c === 'object' && ('Name' in c || 'Service' in c || 'State' in c || 'ID' in c),
      );
      if (looksLikeContainers) return list;
    } catch {
      // not a JSON array slice either
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
  const src = c && typeof c === 'object' ? c : {};
  let ports = [];
  if (Array.isArray(src.Publishers) && src.Publishers.length) {
    const seen = new Set();
    for (const p of src.Publishers) {
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
  } else if (src.Ports) {
    ports = parsePortsString(src.Ports);
  }
  // State is the machine field ("running", "exited", ...). Very old
  // compose versions only print the human Status string ("Up 2
  // minutes", "Exited (0) 3 hours ago") — derive the state from its
  // first word in that case so old installs still report correctly.
  let state = String(src.State || src.state || '').toLowerCase();
  const status = src.Status || src.status || '';
  if (!state && status) {
    if (/^up\b/i.test(status)) state = 'running';
    else if (/^exited\b/i.test(status)) state = 'exited';
    else if (/^created\b/i.test(status)) state = 'created';
    else if (/^paused\b/i.test(status)) state = 'paused';
    else if (/^restarting\b/i.test(status)) state = 'restarting';
    else if (/^dead\b/i.test(status)) state = 'dead';
  }
  return {
    name: src.Name || src.name || '',
    service: src.Service || src.service || '',
    state,
    status,
    health: src.Health || src.health || null,
    ports,
  };
}

// Query container state for an app. `--all` matters: plain
// `compose ps` lists only running containers, so an exited service
// would be invisible and a mixed project would look fully "running"
// instead of "partial". On command failure returns state=unknown
// with the error attached instead of throwing; a successful command
// with no containers means the project is stopped.
export async function composePs(app) {
  const checkedAt = new Date().toISOString();
  try {
    const { stdout } = await composeRun(app, ['ps', '--all', '--format', 'json'], { timeout: 60_000 });
    const containers = parseComposePs(stdout).map(normalizeContainer);
    let state;
    if (containers.length === 0) state = 'stopped';
    else if (containers.every((c) => c.state === 'running')) state = 'running';
    else if (containers.some((c) => c.state === 'running')) state = 'partial';
    else state = 'stopped';
    return { state, containers, error: null, checkedAt };
  } catch (e) {
    return { state: 'unknown', containers: [], error: e.stderr || e.message || String(e), checkedAt };
  }
}

export async function composeLogs(app, tail) {
  const n = Math.min(2000, Math.max(1, Number(tail) || 200));
  const { stdout, stderr } = await composeRun(app, ['logs', '--no-color', '--tail', String(n)], { timeout: 60_000 });
  return `${stdout}${stderr}`;
}
