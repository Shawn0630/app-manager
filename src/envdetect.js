// Detect which env file(s) an app's compose file actually uses:
// parse every service's `env_file:` declarations. The visualizer
// incident behind this: its compose says `env_file:
// ./server/.env`, but the manager defaulted to the repo-root
// `.env` and the Environment panel reported "file does not exist".
//
// Tolerant indentation-based extraction, same spirit as the port
// scanner — no YAML dependency. Handles the short forms (scalar,
// inline list, block list of scalars) and the long form (list
// items that are mappings with a `path:` key, inline or nested).
// Returns workdir-relative paths ('/' separators), deduplicated,
// in order of appearance. Values that are absolute, escape the
// workdir (`..`), or are `${...}` interpolations are skipped —
// the env editor can only handle plain files inside the workdir.
import fs from 'node:fs';
import path from 'node:path';

function unquote(s) {
  const t = String(s || '').trim();
  if (
    t.length >= 2
    && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function normalizeRel(v) {
  let t = unquote(v).replace(/\\/g, '/');
  if (!t || t.includes('${')) return null;
  if (t.startsWith('/')) return null; // absolute — not workdir-relative
  if (t.startsWith('./')) t = t.slice(2);
  if (!t || t.split('/').includes('..')) return null;
  return t;
}

export function parseComposeEnvFiles(text) {
  const out = [];
  const push = (v) => {
    const n = normalizeRel(v);
    if (n && !out.includes(n)) out.push(n);
  };
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^(\s*)env_file\s*:\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const rest = m[2].trim();
    if (rest) {
      if (rest.startsWith('[')) {
        rest.replace(/[[\]]/g, '').split(',').forEach((x) => push(x));
      } else {
        push(rest);
      }
      continue;
    }
    // Block form: consume the following, more-indented lines.
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j];
      if (!l.trim() || l.trim().startsWith('#')) continue;
      const li = l.match(/^\s*/)[0].length;
      if (li <= indent) break;
      const t = l.trim();
      const item = t.match(/^-\s*(.*)$/);
      if (item) {
        const v = item[1].trim();
        const pm = v.match(/^path\s*:\s*(.+)$/);
        if (pm) push(pm[1]);
        else if (v && !/^[A-Za-z_][\w.-]*\s*:/.test(v)) push(v); // plain scalar
        // A mapping item without an inline path (`-` alone or
        // `- required: ...`) falls through: a deeper `path:` line
        // is picked up by the non-item branch below.
        continue;
      }
      const pm = t.match(/^path\s*:\s*(.+)$/);
      if (pm) push(pm[1]);
      // Other keys (required:, etc.) are ignored.
    }
  }
  return out;
}

// Read the app's compose file and return its env_file list.
// Any read failure (no compose file, unreadable) yields [] —
// detection is best-effort and never blocks registration.
export function detectEnvFiles(workdir, composeFile) {
  try {
    const text = fs.readFileSync(path.join(workdir, composeFile), 'utf8');
    return parseComposeEnvFiles(text);
  } catch {
    return [];
  }
}
