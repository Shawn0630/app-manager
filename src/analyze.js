// Project analysis for Add Project / the Environment panel:
// which env file(s) does this project really use, and which
// environment variables does its code require?
//
// Two layers, like the port scan:
//  1. Rules (deterministic, always run): the compose file's
//     env_file declarations (envdetect.js), plus a grep of the
//     code for env references — process.env.X, os.environ,
//     getenv, System.getenv, os.Getenv — and for dotenv config
//     calls that name a path (dotenv.config({ path: '...' }),
//     load_dotenv('...')). The grep catches what compose cannot:
//     a project whose compose file declares NO env_file but whose
//     entry point loads server/.env itself.
//  2. AI check (only when an LLM is configured — the SAME config
//     and transport as the port scan): a compact material pack
//     (shallow file listing, compose, Dockerfile, package.json,
//     env KEY NAMES per file, the grep hits, README excerpts)
//     goes to the chat completions endpoint, which must answer
//     strict JSON: the env files it concludes the project uses
//     (incl. framework conventions like .env.local), the
//     required variables, and a suggested primary env file.
//
// RED LINE: materials contain env KEY NAMES ONLY — never a
// single env value (unlike the port scan there is no exception
// here; key names are all the analysis needs). The API key never
// leaves the server (see llm.js).
//
// Everything the AI returns is a SUGGESTION: paths and keys are
// sanitized, presence (presentInEnvFile) is recomputed on the
// server against the real files, and nothing is written until
// the user confirms (POST /api/apps/:id/env-file).
import fs from 'node:fs';
import path from 'node:path';
import { LLM } from './config.js';
import { chatJson } from './llm.js';
import { detectEnvFiles } from './envdetect.js';
import { parseEnvText } from './envfile.js';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.next', '__pycache__', 'target', '.venv']);
const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.php', '.go', '.java']);
const MAX_LISTING = 120;
const MAX_GREP_FILES = 60;
const MAX_HITS = 80;
const MAX_MATERIALS = 24_000;

const KEY_PATTERNS = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
  /os\.environ(?:\.get)?\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /os\.environ\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
  /getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /System\.getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/g,
  /os\.Getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/g,
];
const DOTENV_PATTERNS = [
  /dotenv\.config\(\s*\{[^}]*?path\s*:\s*['"]([^'"]+)['"]/g,
  /['"]dotenv['"]\)\.config\(\s*\{[^}]*?path\s*:\s*['"]([^'"]+)['"]/g,
  /load_dotenv\(\s*(?:dotenv_path\s*=\s*)?['"]([^'"]+)['"]/g,
];

// Same normalization rules as envdetect: workdir-relative, no
// escapes, no interpolation.
function saneRel(v) {
  let t = String(v || '').trim().replace(/\\/g, '/');
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    t = t.slice(1, -1);
  }
  if (!t || t.includes('${') || t.startsWith('/')) return null;
  if (t.startsWith('./')) t = t.slice(2);
  if (!t || t.split('/').includes('..')) return null;
  return t;
}

function walk(workdir) {
  const out = [];
  const rec = (dir, rel, depth) => {
    if (depth > 4 || out.length >= 400) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= 400) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        out.push(`${r}/`);
        rec(path.join(dir, e.name), r, depth + 1);
      } else if (e.isFile()) {
        out.push(r);
      }
    }
  };
  rec(workdir, '', 0);
  return out;
}

// Grep the project's code for env references and dotenv paths.
// Returns { hits: [{ file, line, keys }], dotenvPaths:
// [{ path, file }], requiredKeys: [names in first-seen order] }.
export function collectEnvRefs(workdir, listing) {
  const files = (listing || walk(workdir))
    .filter((r) => !r.endsWith('/') && CODE_EXTS.has(path.posix.extname(r)))
    .slice(0, MAX_GREP_FILES);
  const hits = [];
  const dotenvPaths = [];
  const requiredKeys = [];
  const seenKey = new Set();
  for (const rel of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(workdir, rel), 'utf8').slice(0, 64_000);
    } catch {
      continue;
    }
    for (const rawLine of text.split('\n')) {
      if (hits.length >= MAX_HITS) break;
      const line = rawLine.trim().slice(0, 160);
      if (!line) continue;
      const keys = [];
      for (const re of KEY_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {
          if (!keys.includes(m[1])) keys.push(m[1]);
        }
      }
      let dotenvPath = null;
      for (const re of DOTENV_PATTERNS) {
        re.lastIndex = 0;
        const m = re.exec(line);
        if (m) {
          dotenvPath = saneRel(m[1]);
          break;
        }
      }
      if (dotenvPath && !dotenvPaths.some((d) => d.path === dotenvPath)) {
        dotenvPaths.push({ path: dotenvPath, file: rel });
      }
      if (keys.length || dotenvPath) {
        hits.push({ file: rel, line, keys, dotenvPath });
        for (const k of keys) {
          if (!seenKey.has(k)) {
            seenKey.add(k);
            requiredKeys.push(k);
          }
        }
      }
    }
  }
  return { hits, dotenvPaths, requiredKeys };
}

function readCapped(abs, cap) {
  try {
    return fs.readFileSync(abs, 'utf8').slice(0, cap);
  } catch {
    return null;
  }
}

function keysOfFile(workdir, rel) {
  const text = readCapped(path.join(workdir, rel), 32_000);
  if (text === null) return null;
  return parseEnvText(text).map((e) => e.key);
}

// The union of keys present in the given (existing) env files —
// presence is always computed here, never trusted from the AI.
function presentKeySet(workdir, rels) {
  const set = new Set();
  for (const rel of rels) {
    const keys = keysOfFile(workdir, rel);
    if (keys) for (const k of keys) set.add(k);
  }
  return set;
}

function buildMaterials(workdir, composeFile, listing, refs, keyFiles) {
  const parts = [];
  parts.push(`## Files in the project (shallow listing)\n${listing.slice(0, MAX_LISTING).join('\n')}`);
  const compose = readCapped(path.join(workdir, composeFile), 8000);
  if (compose !== null) parts.push(`## ${composeFile}\n${compose}`);
  const dockerfile = readCapped(path.join(workdir, 'Dockerfile'), 3000);
  if (dockerfile !== null) parts.push(`## Dockerfile\n${dockerfile}`);
  const pkg = readCapped(path.join(workdir, 'package.json'), 3000);
  if (pkg !== null) parts.push(`## package.json\n${pkg}`);
  const keyLines = [];
  for (const rel of keyFiles) {
    const keys = keysOfFile(workdir, rel);
    keyLines.push(keys ? `${rel}: ${keys.join(', ') || '(no entries)'}` : `${rel}: (missing)`);
  }
  if (keyLines.length) {
    parts.push(`## Env key NAMES by file (values are never included)\n${keyLines.join('\n')}`);
  }
  if (refs.hits.length) {
    const hitLines = refs.hits.map((h) => `${h.file}: ${h.line}`).join('\n');
    parts.push(`## Code references to environment variables (grep hits)\n${hitLines}`);
  }
  const readme = readCapped(path.join(workdir, 'README.md'), 12_000);
  if (readme !== null) {
    const envLines = readme.split('\n').filter((l) => /env/i.test(l)).slice(0, 25).join('\n');
    parts.push(`## README excerpts\n${envLines || readme.slice(0, 800)}`);
  }
  return parts.join('\n\n').slice(0, MAX_MATERIALS);
}

async function aiAnalyze(materials, ruleSummary) {
  const parsed = await chatJson(LLM, [
    {
      role: 'system',
      content: 'You inspect a software project to determine which env file(s) it actually loads and which environment variables its code requires. '
        + 'Reply with STRICT JSON only — no prose, no code fence: {"envFiles":[{"path":"<path relative to project root>","evidence":"<one short line>"}],'
        + '"requiredVars":[{"key":"<VARIABLE_NAME>","evidence":"<one short line>"}],'
        + '"suggestedEnvFile":"<relative path or null>","notes":"<one or two short sentences>"}. '
        + 'Claim only what the materials evidence. You are shown env key NAMES only, never values.',
    },
    {
      role: 'user',
      content: `A deterministic pass already found: ${ruleSummary}\n\n`
        + 'Improve on it: find env files the rules cannot see (a dotenv path set in code, framework conventions such as .env.local), the variables the code requires, and which single env file is the primary one.\n\n'
        + materials,
    },
  ]);
  const envFiles = [];
  for (const f of Array.isArray(parsed.envFiles) ? parsed.envFiles : []) {
    const p = saneRel(f && f.path);
    if (p && !envFiles.some((x) => x.path === p)) {
      envFiles.push({ path: p, evidence: String((f && f.evidence) || '').slice(0, 200) });
    }
  }
  const requiredVars = [];
  for (const v of Array.isArray(parsed.requiredVars) ? parsed.requiredVars : []) {
    const key = String((v && v.key) || '');
    if (KEY_RE.test(key) && !requiredVars.some((x) => x.key === key)) {
      requiredVars.push({ key, evidence: String((v && v.evidence) || '').slice(0, 200) });
    }
  }
  return {
    envFiles,
    requiredVars,
    suggestedEnvFile: saneRel(parsed.suggestedEnvFile),
    notes: String(parsed.notes || '').slice(0, 500),
  };
}

// Analyze one project folder. `composeFile` is the detected
// compose file name inside workdir. Never throws for AI problems
// — they degrade to the rule results with aiNote set.
export async function analyzeProject(workdir, composeFile) {
  const listing = walk(workdir);
  const ruleFiles = detectEnvFiles(workdir, composeFile);
  const refs = collectEnvRefs(workdir, listing);

  // Files whose key names may be shown (and which count for
  // presence): detected + dotenv-named + the root defaults when
  // they exist. *.example files are documented templates — shown
  // to the AI, never counted as "present".
  const candidateFiles = [...new Set([
    ...ruleFiles,
    ...refs.dotenvPaths.map((d) => d.path),
    '.env',
    '.env.local',
  ])];
  const keyFiles = [...new Set([...candidateFiles, '.env.example', '.env.sample'])]
    .filter((rel) => fs.existsSync(path.join(workdir, rel)));

  const envFiles = [];
  const addFile = (p, source, evidence) => {
    if (p && !envFiles.some((x) => x.path === p)) {
      envFiles.push({ path: p, source, evidence, exists: fs.existsSync(path.join(workdir, p)) });
    }
  };
  for (const p of ruleFiles) addFile(p, 'compose', `declared in ${composeFile} env_file`);
  for (const d of refs.dotenvPaths) addFile(d.path, 'code', `dotenv config in ${d.file}`);

  let ai = null;
  let aiUsed = false;
  let aiNote = null;
  if (!LLM) {
    aiNote = 'AI analysis not configured';
  } else {
    try {
      const ruleSummary = [
        ruleFiles.length ? `compose env_file: ${ruleFiles.join(', ')}` : 'no compose env_file',
        refs.dotenvPaths.length ? `dotenv paths in code: ${refs.dotenvPaths.map((d) => d.path).join(', ')}` : 'no dotenv path in code',
        refs.requiredKeys.length ? `env vars referenced in code: ${refs.requiredKeys.join(', ')}` : 'no env vars referenced in code',
      ].join('; ');
      ai = await aiAnalyze(buildMaterials(workdir, composeFile, listing, refs, keyFiles), ruleSummary);
      aiUsed = true;
      for (const f of ai.envFiles) addFile(f.path, 'ai', f.evidence || 'identified by the AI check');
    } catch (e) {
      aiNote = `AI analysis failed: ${e.message}`;
    }
  }

  // Presence is computed against every candidate env file that
  // exists (compose-declared, dotenv-named, AI-suggested, root
  // defaults) — the server's fact, not the AI's claim.
  const presenceFiles = [...new Set([...candidateFiles, ...envFiles.map((f) => f.path)])];
  const present = presentKeySet(workdir, presenceFiles);
  const requiredVars = [];
  const addVar = (key, source, evidence) => {
    if (KEY_RE.test(key) && !requiredVars.some((v) => v.key === key)) {
      requiredVars.push({ key, source, evidence, presentInEnvFile: present.has(key) });
    }
  };
  if (ai) for (const v of ai.requiredVars) addVar(v.key, 'ai', v.evidence);
  for (const key of refs.requiredKeys) {
    const hit = refs.hits.find((h) => h.keys.includes(key));
    addVar(key, 'code', hit ? `${hit.file}: ${hit.line}` : 'referenced in code');
  }

  return {
    envFiles,
    suggestedEnvFile: (ai && ai.suggestedEnvFile) || (envFiles.length ? envFiles[0].path : null),
    requiredVars,
    notes: ai ? ai.notes : '',
    aiUsed,
    aiConfigured: Boolean(LLM),
    aiNote,
    composeFile,
  };
}
