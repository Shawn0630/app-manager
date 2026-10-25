// Server-side folder browser for the Add Project "local folder"
// form: list the directories the manager process itself can see,
// one level at a time, so the user can pick a folder in the UI
// instead of typing a path. A web page cannot open the OS file
// dialog, and this has a matching virtue: folders that were never
// mounted into the manager container simply do not appear, which
// makes the same-path mount requirement visible instead of an
// error to decode.
//
// Only directory NAMES are ever listed — no file contents are
// read. The probe fields (git repo root? compose file?) reuse the
// registry's own detection so the picker describes a folder
// exactly the way registering it would treat it.
import fs from 'node:fs';
import path from 'node:path';
import * as git from './git.js';
import { parseRepo } from './github.js';
import { detectComposeFile } from './registry.js';

// Browse one directory. `rawPath` undefined/null starts at the
// filesystem root; anything else must be a non-empty absolute path
// ("~" is rejected, like in registerLocalApp — nothing expands it
// here either). Returns:
//   { path, parent, dirs: [{ name, path }],
//     isGitRepo, gitRemote, githubRepo, branch, composeFile }
// Errors carry .status (400 bad path / 403 unreadable), in the same
// style as the registry errors.
export async function browseDirectory(rawPath) {
  let dir;
  if (rawPath == null) {
    dir = path.parse(process.cwd()).root;
  } else {
    const raw = String(rawPath).trim();
    if (!raw) {
      const err = new Error('path must not be empty');
      err.status = 400;
      throw err;
    }
    if (raw.startsWith('~')) {
      const err = new Error(`path must be the full absolute path — "~" is not expanded (you entered: ${raw})`);
      err.status = 400;
      throw err;
    }
    dir = path.resolve(raw);
  }

  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') {
      const err = new Error(`folder not found: ${dir}`);
      err.status = 400;
      throw err;
    }
    throw e;
  }
  if (!stat.isDirectory()) {
    const err = new Error(`not a folder: ${dir}`);
    err.status = 400;
    throw err;
  }

  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      const err = new Error(`permission denied: cannot read folder ${dir}`);
      err.status = 403;
      throw err;
    }
    throw e;
  }
  const dirs = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      // statSync follows symlinks: a symlink to a directory counts
      // as a directory; a broken symlink is skipped silently.
      if (fs.statSync(full).isDirectory()) dirs.push({ name, path: full });
    } catch {
      // unreadable or dangling entry — not a browsable folder
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));

  const parentDir = path.dirname(dir);
  const isGitRepo = await git.isGitRepo(dir);
  let gitRemote = null;
  let githubRepo = null;
  let branch = null;
  if (isGitRepo) {
    gitRemote = await git.remoteUrl(dir, 'origin');
    const parsed = gitRemote ? parseRepo(gitRemote) : null;
    if (parsed) githubRepo = `${parsed.owner}/${parsed.repo}`;
    branch = await git.currentBranch(dir);
  }

  return {
    path: dir,
    parent: parentDir === dir ? null : parentDir,
    dirs,
    isGitRepo,
    gitRemote,
    githubRepo,
    branch,
    composeFile: detectComposeFile(dir),
  };
}
