// Read-only git queries + ls-remote.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './run.js';

// Local HEAD info: { head, short, time, subject }.
// Throws when the directory is not a git repo / has no commits; callers
// that need a soft failure use headOrNull.
export async function localHead(workdir) {
  const { stdout } = await run('git', ['-C', workdir, 'log', '-1', '--format=%H%x09%cI%x09%s'], { timeout: 30_000 });
  const [head, time, subject] = stdout.trim().split('\t');
  if (!head) throw new Error(`no git commit readable in ${workdir}`);
  return { head, short: head.slice(0, 7), time: time || null, subject: subject || '' };
}

export async function headOrNull(workdir) {
  try {
    return await localHead(workdir);
  } catch {
    return null;
  }
}

// Is this directory the ROOT of a git work tree? Deliberately
// stricter than "inside some work tree": a folder nested inside an
// unrelated parent repo must not inherit that repo's remote/branch
// (its origin is not the folder's own GitHub connection).
export async function isGitRepo(workdir) {
  try {
    const { stdout } = await run('git', ['-C', workdir, 'rev-parse', '--show-toplevel'], { timeout: 15_000 });
    const top = stdout.trim();
    if (!top) return false;
    const real = (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };
    return real(top) === real(workdir);
  } catch {
    return false;
  }
}

// The configured URL of the given remote (default "origin"), read
// from remote.<name>.url as-is — NOT via `git remote get-url`, which
// would substitute url.*.insteadOf rewrites and hide the GitHub URL
// the user actually configured. Null when there is no such remote /
// the directory is not a git repo.
export async function remoteUrl(workdir, remote = 'origin') {
  try {
    const { stdout } = await run('git', ['-C', workdir, 'config', '--get', `remote.${remote}.url`], { timeout: 15_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// The checked-out branch name, or null when HEAD is detached or the
// directory is not a git repo.
export async function currentBranch(workdir) {
  try {
    const { stdout } = await run('git', ['-C', workdir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 15_000 });
    const b = stdout.trim();
    return b && b !== 'HEAD' ? b : null;
  } catch {
    return null;
  }
}

// Remote branch HEAD (full hash). Throws on failure.
export async function lsRemote(repoUrl, branch) {
  const { stdout } = await run('git', ['ls-remote', repoUrl, `refs/heads/${branch}`], { timeout: 60_000 });
  const first = stdout.trim().split('\n')[0] || '';
  const hash = first.split(/\s+/)[0];
  if (!hash) throw new Error(`ls-remote returned nothing for refs/heads/${branch}`);
  return hash;
}
