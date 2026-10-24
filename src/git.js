// Read-only git queries + ls-remote.
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

// Remote branch HEAD (full hash). Throws on failure.
export async function lsRemote(repoUrl, branch) {
  const { stdout } = await run('git', ['ls-remote', repoUrl, `refs/heads/${branch}`], { timeout: 60_000 });
  const first = stdout.trim().split('\n')[0] || '';
  const hash = first.split(/\s+/)[0];
  if (!hash) throw new Error(`ls-remote returned nothing for refs/heads/${branch}`);
  return hash;
}
