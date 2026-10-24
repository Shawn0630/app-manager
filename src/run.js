// Run external commands (git / docker) with execFile + argument arrays.
// Never build shell strings.
import { execFile } from 'node:child_process';

export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts.timeout ?? 120_000,
        maxBuffer: 32 * 1024 * 1024,
        cwd: opts.cwd,
        env: process.env,
      },
      (err, stdout, stderr) => {
        const output = `${stdout || ''}${stderr || ''}`;
        if (err) {
          const e = new Error(`${cmd} ${args.join(' ')} failed: ${err.message}`);
          e.code = typeof err.code === 'number' ? err.code : null;
          e.stdout = stdout || '';
          e.stderr = stderr || '';
          e.output = output;
          reject(e);
        } else {
          resolve({ code: 0, stdout: stdout || '', stderr: stderr || '', output });
        }
      },
    );
  });
}

// Keep only the tail of an output (about 50 lines per step in deployment
// records, so the jsonl log does not balloon).
export function tailText(text, lines = 50, maxChars = 8000) {
  const s = String(text || '');
  const kept = s.split('\n').slice(-lines).join('\n');
  return kept.length > maxChars ? kept.slice(-maxChars) : kept;
}
