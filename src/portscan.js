// Port detection for Add Project → "from a local folder": before
// the app is registered, scan the folder for the port(s) it will
// listen on, so the form's Port field can be prefilled (never
// locked — the user can always overtype).
//
// Two layers:
//  1. Rules (deterministic, always run): the compose file's
//     published `ports:` mappings (short and long syntax, with
//     ${VAR} / ${VAR:-default} interpolation resolved against the
//     project's own .env), Dockerfile EXPOSE lines, and .env keys
//     whose name contains PORT. Compose findings are ground truth
//     and come first.
//  2. AI check (only when an LLM is configured — see config.js):
//     a compact material pack (compose file, Dockerfile,
//     package.json, ONLY the PORT-keyed .env entries, a README
//     excerpt, an entry-file excerpt) goes to an OpenAI-compatible
//     chat completions endpoint, which must answer strict JSON.
//     It exists to catch what rules cannot: ports hard-coded in
//     code, stated in the README, an unclear main service. Any
//     failure (timeout ~30s, HTTP error, bad JSON) falls back to
//     the rule results with the failure noted — the scan never
//     blocks registration.
//
// Security: the LLM API key is used only in the Authorization
// header of that one call. It never appears in this module's
// return value, in logs, or in any file. Non-PORT .env values are
// never sent to the LLM — they may be secrets.
import fs from 'node:fs';
import path from 'node:path';
import { LLM } from './config.js';
import { detectComposeFile } from './registry.js';
import { parseEnvText } from './envfile.js';

const AI_TIMEOUT_MS = 30_000;
const MATERIALS_CAP = 24_000;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Same path rules as local registration (registry.js): absolute
// path, "~" rejected with an explanation, must exist as a folder
// from the manager's point of view.
function validateScanPath(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) throw badRequest('path is required');
  if (raw.startsWith('~')) {
    throw badRequest(`path must be the full absolute path — "~" is not expanded (you entered: ${raw})`);
  }
  const dir = path.resolve(raw);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw badRequest(
      `local folder not found: ${dir} — the manager can only see folders mounted into its container. `
      + "Add a same-path volume mount for this folder (or its parent directory) in the manager's docker-compose.yml, restart the manager, then enter the full absolute path.",
    );
  }
  return dir;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readCapped(file, cap) {
  const text = readText(file);
  if (text == null) return null;
  return text.length > cap ? `${text.slice(0, cap)}\n…[truncated]` : text;
}

// ---------- compose `ports:` parsing ----------
// A tolerant, indentation-based extractor (no YAML dependency):
// finds each service's `ports:` list and yields its items — short
// scalars ("8088:80", "${PORT:-3000}:3000", "127.0.0.1:8088:80")
// and long mappings (target:/published:/...). Not a general YAML
// parser; it understands the shapes compose files actually use
// for ports, including indentless sequences.

function stripYamlComment(line) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (ch === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(s) {
  const t = String(s || '').trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

export function parseComposePorts(text) {
  const lines = String(text || '').split('\n').map((raw) => {
    const clean = stripYamlComment(raw.replace(/\r$/, ''));
    return { indent: clean.length - clean.trimStart().length, text: clean.trim() };
  });
  const items = [];
  let i = lines.findIndex((l) => l.text === 'services:');
  if (i < 0) return items;
  const servicesIndent = lines[i].indent;
  let serviceIndent = null;
  let service = null;
  i += 1;
  for (; i < lines.length; i += 1) {
    const l = lines[i];
    if (!l.text) continue;
    if (l.indent <= servicesIndent) break;
    if (serviceIndent == null) serviceIndent = l.indent;
    if (l.indent === serviceIndent) {
      const m = l.text.match(/^([A-Za-z0-9._-]+):\s*$/);
      service = m ? m[1] : null;
      continue;
    }
    if (!service || l.text !== 'ports:' || l.indent <= serviceIndent) continue;
    // Inside a service's ports: list.
    const portsIndent = l.indent;
    let current = null; // long-form item under construction
    const flush = () => {
      if (current) {
        delete current.__itemIndent;
        items.push({ service, kind: 'long', kv: current });
      }
      current = null;
    };
    i += 1;
    for (; i < lines.length; i += 1) {
      const p = lines[i];
      if (!p.text) continue;
      if (p.indent <= serviceIndent) { i -= 1; break; }
      if (p.text.startsWith('-') && p.indent >= portsIndent) {
        flush();
        const content = p.text.replace(/^-\s*/, '').trim();
        const kv = content.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
        if (kv) {
          current = { [kv[1]]: kv[2] };
          current.__itemIndent = p.indent;
        } else if (content) {
          items.push({ service, kind: 'short', value: content });
        }
        continue;
      }
      if (current && p.indent > (current.__itemIndent ?? portsIndent)) {
        const kv = p.text.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
        if (kv) current[kv[1]] = kv[2];
        continue;
      }
      if (p.indent <= portsIndent) { i -= 1; break; }
      // Anything else nested deeper (e.g. under a sibling key):
      // ignore the line, keep scanning the list.
    }
    flush();
  }
  return items;
}

// Split a short-syntax mapping on ':' at brace depth 0 —
// "${PORT:-3000}" contains a colon that is NOT a separator.
function splitMapping(expr) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of expr) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ':' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

const validPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;

// Resolve one host-side port expression: a literal number (or the
// start of a range), $VAR / ${VAR}, or ${VAR:-default}, using the
// project's .env for VAR. Returns { port|null, via, name? }.
export function resolveHostExpr(rawExpr, envMap) {
  const expr = unquote(rawExpr).trim();
  if (/^\d+$/.test(expr)) {
    const n = Number(expr);
    return validPort(n) ? { port: n, via: 'literal' } : { port: null, via: 'invalid' };
  }
  if (/^\d+-\d+$/.test(expr)) {
    const n = Number(expr.split('-')[0]);
    return validPort(n) ? { port: n, via: 'literal', range: true } : { port: null, via: 'invalid' };
  }
  const m = expr.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}?$/);
  if (m) {
    const [, name, def] = m;
    const envVal = envMap && envMap.has(name) ? String(envMap.get(name)).trim() : null;
    if (envVal && /^\d+$/.test(envVal) && validPort(Number(envVal))) {
      return { port: Number(envVal), via: 'env', name };
    }
    if (def && /^\d+$/.test(def.trim()) && validPort(Number(def))) {
      return { port: Number(def), via: 'default', name };
    }
    return { port: null, via: 'unresolved', name };
  }
  return { port: null, via: 'unresolved' };
}

function composeCandidates(items, envMap) {
  const out = [];
  for (const item of items) {
    if (item.kind === 'short') {
      const parts = splitMapping(unquote(item.value));
      if (parts.length < 2) continue; // target-only: no fixed host port
      const hostExpr = parts[parts.length - 2];
      const r = resolveHostExpr(hostExpr, envMap);
      if (!r.port) continue;
      let detail = `${item.service} · "${unquote(item.value)}"`;
      if (r.via === 'env') detail += ` — ${r.name} from the project .env`;
      if (r.via === 'default') detail += ` — default of ${r.name}`;
      if (r.range) detail += ' — start of the published range';
      out.push({ port: r.port, source: 'compose', detail });
    } else {
      const pub = item.kv.published;
      if (pub == null || pub === '') continue;
      const r = resolveHostExpr(pub, envMap);
      if (!r.port) continue;
      let detail = `${item.service} · published: ${unquote(pub)}`;
      if (item.kv.target) detail += ` → ${unquote(item.kv.target)}`;
      if (r.via === 'env') detail += ` — ${r.name} from the project .env`;
      if (r.via === 'default') detail += ` — default of ${r.name}`;
      out.push({ port: r.port, source: 'compose', detail });
    }
  }
  return out;
}

function dockerfileCandidates(dir) {
  const file = ['Dockerfile', 'dockerfile'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!file) return [];
  const text = readText(file) || '';
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*EXPOSE\s+(.+)$/i);
    if (!m) continue;
    for (const tok of m[1].trim().split(/\s+/)) {
      const bare = tok.replace(/\/(tcp|udp|sctp)$/i, '');
      if (/^\d+$/.test(bare) && validPort(Number(bare))) {
        out.push({ port: Number(bare), source: 'dockerfile', detail: `Dockerfile · EXPOSE ${tok}` });
      }
    }
  }
  return out;
}

// ---------- AI check ----------

function buildMaterials(dir, composeFile, composeText, envEntries) {
  const sections = [];
  if (composeText != null) sections.push([`docker compose file (${composeFile})`, composeText]);
  const dockerfile = ['Dockerfile', 'dockerfile'].find((f) => fs.existsSync(path.join(dir, f)));
  if (dockerfile) {
    const t = readCapped(path.join(dir, dockerfile), 4000);
    if (t != null) sections.push(['Dockerfile', t]);
  }
  const pkgText = readCapped(path.join(dir, 'package.json'), 4000);
  if (pkgText != null) sections.push(['package.json', pkgText]);
  const portEnv = envEntries.filter((e) => /port/i.test(e.key));
  if (portEnv.length) {
    sections.push(['project .env — only the entries whose key contains PORT', portEnv.map((e) => `${e.key}=${e.value}`).join('\n')]);
  }
  const readmeName = ['README.md', 'readme.md', 'README', 'Readme.md'].find((f) => fs.existsSync(path.join(dir, f)));
  if (readmeName) {
    const t = readCapped(path.join(dir, readmeName), 2000);
    if (t != null) sections.push([`${readmeName} (excerpt)`, t]);
  }
  // Entry file: package.json "main" when it points inside the
  // folder, else a conventional entry name.
  let entryName = null;
  if (pkgText) {
    try {
      const main = JSON.parse(pkgText).main;
      if (typeof main === 'string' && main) {
        const resolved = path.resolve(dir, main);
        if (resolved.startsWith(dir + path.sep) && fs.existsSync(resolved)) entryName = main;
      }
    } catch {
      // unparseable package.json — fall through to conventions
    }
  }
  if (!entryName) {
    entryName = ['server.js', 'app.js', 'index.js', 'main.js', 'app.py', 'main.py']
      .find((f) => fs.existsSync(path.join(dir, f))) || null;
  }
  if (entryName) {
    const t = readCapped(path.join(dir, entryName), 3000);
    if (t != null) sections.push([`entry file (${entryName}, excerpt)`, t]);
  }
  const joined = sections.map(([h, b]) => `## ${h}\n${b}`).join('\n\n');
  return joined.length > MATERIALS_CAP ? joined.slice(0, MATERIALS_CAP) : joined;
}

async function aiCheck(materials, ruleCandidates) {
  const found = ruleCandidates.map((c) => `${c.port} (${c.source}: ${c.detail})`).join('; ') || 'none';
  const messages = [
    {
      role: 'system',
      content: 'You inspect a software project to determine which TCP port its main service listens on or publishes. '
        + 'Reply with STRICT JSON only — no prose, no code fence: {"ports":[{"port":<number>,"evidence":"<where the port appears>"}],"summary":"<one short sentence>"}. '
        + 'Include only ports you have concrete evidence for.',
    },
    {
      role: 'user',
      content: `A deterministic scan of this project already found these published ports (treat compose-published ports as ground truth): ${found}\n\n`
        + 'Add any port the scan may have missed — for example a port hard-coded in code, stated in the README, or the main service\'s port when several services exist — each with its evidence.\n\n'
        + materials,
    },
  ];
  let res;
  try {
    res = await fetch(`${LLM.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(LLM.apiKey ? { Authorization: `Bearer ${LLM.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: LLM.model, temperature: 0, messages }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(e && e.name === 'TimeoutError' ? `timed out after ${AI_TIMEOUT_MS / 1000}s` : 'request failed');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : null;
  if (!content) throw new Error('empty response');
  const open = content.indexOf('{');
  const close = content.lastIndexOf('}');
  if (open < 0 || close <= open) throw new Error('response was not JSON');
  let parsed;
  try {
    parsed = JSON.parse(content.slice(open, close + 1));
  } catch {
    throw new Error('response was not JSON');
  }
  const ports = (Array.isArray(parsed.ports) ? parsed.ports : [])
    .map((p) => ({
      port: Number(p && p.port),
      evidence: String((p && p.evidence) || '').slice(0, 200),
    }))
    .filter((p) => validPort(p.port));
  return { ports, summary: String(parsed.summary || '').slice(0, 300) };
}

// ---------- Orchestration ----------

export async function scanPorts(rawPath) {
  const dir = validateScanPath(rawPath);
  const composeFile = detectComposeFile(dir);

  const envText = readText(path.join(dir, '.env'));
  const envEntries = envText != null ? parseEnvText(envText) : [];
  const envMap = new Map(envEntries.map((e) => [e.key, e.value]));

  const candidates = [];
  const seen = new Set();
  const add = (c) => {
    if (c && c.port && !seen.has(c.port)) {
      seen.add(c.port);
      candidates.push(c);
    }
  };

  let composeText = null;
  if (composeFile) {
    composeText = readText(path.join(dir, composeFile));
    if (composeText != null) {
      for (const c of composeCandidates(parseComposePorts(composeText), envMap)) add(c);
    }
  }
  for (const c of dockerfileCandidates(dir)) add(c);
  for (const e of envEntries) {
    if (/port/i.test(e.key) && /^\d+$/.test(String(e.value).trim()) && validPort(Number(e.value))) {
      add({ port: Number(e.value), source: `env:${e.key}`, detail: `.env · ${e.key}=${e.value}` });
    }
  }

  let aiUsed = false;
  let aiNote = 'AI check not configured';
  const aiConfigured = Boolean(LLM);
  if (LLM) {
    try {
      const materials = buildMaterials(dir, composeFile, composeText, envEntries);
      const ai = await aiCheck(materials, candidates);
      aiUsed = true;
      aiNote = ai.summary || 'AI check completed';
      for (const p of ai.ports) {
        add({ port: p.port, source: 'ai', detail: p.evidence || 'reported by the AI check' });
      }
    } catch (e) {
      aiNote = `AI check failed: ${e.message || String(e)}`;
    }
  }

  return {
    candidates,
    primaryPort: candidates.length ? candidates[0].port : null,
    aiUsed,
    aiConfigured,
    aiNote,
    composeFile,
  };
}
