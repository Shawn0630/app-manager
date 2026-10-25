// builtin provider: no external CI needed. It does both halves of
// the job itself:
//   check the remote (git ls-remote) -> deploy (git pull --ff-only
//   + docker compose up -d --build)
// That is the "Jenkins effect" core: watch commits -> pull code ->
// rebuild -> restart, with a deployment record for every run.
//
// To add Jenkins later: create jenkins.js in this directory exporting
// the same two functions — checkRemote(app) and deploy(app, trigger) —
// register it as "jenkins" in providers/index.js, then set
// "provider": "jenkins" in the app config. The polling loop and the
// HTTP layer stay untouched.
import { run, tailText } from '../run.js';
import * as git from '../git.js';
import { appendDeployment } from '../deployments.js';
import { appState } from '../store.js';
import { prepareDynamicOverride, mergeEnvEntries, writeInUseSnapshot } from '../dynenv.js';
import { readEnvFile } from '../envfile.js';

// Shared tail of deploy()/redeploy(): when the run's `up` step
// succeeded, record which env is now in effect (static file as it
// stands now + the dynamic entries this run applied — key names and
// sources only) so the "Currently in use" view survives restarts.
async function snapshotInUse(app, trigger, dyn) {
  try {
    const staticNow = await readEnvFile(app).catch(() => ({ entries: [] }));
    const merged = mergeEnvEntries(staticNow.entries, dyn.entries || []);
    await writeInUseSnapshot(app, {
      ts: new Date().toISOString(),
      trigger,
      mergedEntries: merged.entries,
      dynamicKeys: dyn.dynamicKeys || [],
    });
  } catch {
    // A snapshot failure must never fail the deployment itself.
  }
}

// Prepare the dynamic-env override as a recorded pipeline step.
// With no dynamic entries this is a no-op (no step, no override
// file). A preparation failure is a failed step and aborts the
// pipeline: deploying without the requested overrides would be a
// silent lie.
async function dynamicStep(app, steps) {
  try {
    const dyn = await prepareDynamicOverride(app);
    if (dyn.dynamicKeys.length) {
      steps.push({
        name: 'apply dynamic env',
        ok: true,
        code: 0,
        output: tailText(
          `dynamic overrides for services: ${dyn.services.join(', ')}\nkeys: ${dyn.dynamicKeys.join(', ')}\noverride file: ${dyn.overridePath}`,
        ),
      });
    }
    return dyn;
  } catch (e) {
    steps.push({ name: 'apply dynamic env', ok: false, code: e.code ?? null, output: tailText(e.output || e.message) });
    throw e;
  }
}

function composeFileArgs(app, dyn) {
  const args = ['compose', '-p', app.projectName, '-f', `${app.workdir}/${app.composeFile}`];
  if (dyn && dyn.overridePath) args.push('-f', dyn.overridePath);
  return args;
}

// Check the remote branch HEAD and update the cache. On failure only
// lastPollError is recorded and null is returned — polling must never
// crash the process. An app without a remote (local folder, no
// origin) has nothing to check: a quiet no-op, not an error.
export async function checkRemote(app) {
  if (!app.repoUrl) return null;
  const st = appState(app.id);
  st.lastPollAt = new Date().toISOString();
  try {
    const head = await git.lsRemote(app.repoUrl, app.branch);
    st.remoteHead = head;
    st.lastPollError = null;
    return head;
  } catch (e) {
    st.lastPollError = tailText(e.stderr || e.message || String(e), 5, 500);
    return null;
  }
}

// The deployment pipeline. The caller must already hold the app's
// operation lock (ops.runOp). A record is appended to
// deployments.jsonl either way, and also returned.
// opts may carry { workflowRunId, targetSha } for Actions-triggered
// deploys; when the HEAD after the pull differs from targetSha, the
// record says so in `note` instead of pretending otherwise.
export async function deploy(app, trigger, opts = {}) {
  const startedAt = Date.now();
  const steps = [];
  const from = await git.headOrNull(app.workdir);
  const fromCommit = from ? from.head : null;

  async function step(name, cmd, args, timeout) {
    try {
      const { output } = await run(cmd, args, { timeout });
      steps.push({ name, ok: true, code: 0, output: tailText(output) });
    } catch (e) {
      steps.push({ name, ok: false, code: e.code, output: tailText(e.output || e.message) });
      throw e;
    }
  }

  // An app without a remote (local folder, no origin) deploys as a
  // plain rebuild: the git steps are skipped entirely rather than
  // failing with a meaningless git error, and the record says so.
  const hasRemote = Boolean(app.repoUrl);
  let result = 'success';
  let dyn = { overridePath: null, dynamicKeys: [], entries: [] };
  let upOk = false;
  try {
    if (hasRemote) {
      await step('git fetch', 'git', ['-C', app.workdir, 'fetch', 'origin', app.branch], 120_000);
      // --ff-only: if local and remote have diverged, fail and record it;
      // never force-push or overwrite local changes. For a local
      // folder app this runs in the user's own checkout — the same
      // rule protects their uncommitted work.
      await step('git pull --ff-only', 'git', ['-C', app.workdir, 'pull', '--ff-only', 'origin', app.branch], 120_000);
    }
    // Dynamic env overrides are a deployment-time concern: the
    // override file is generated here and added to the up/ps calls.
    dyn = await dynamicStep(app, steps);
    await step(
      'docker compose up -d --build',
      'docker',
      [...composeFileArgs(app, dyn), 'up', '-d', '--build'],
      900_000,
    );
    upOk = true;
    await step(
      'docker compose ps (verify)',
      'docker',
      [...composeFileArgs(app, dyn), 'ps', '--format', 'json'],
      60_000,
    );
  } catch {
    result = 'failed';
  }
  if (upOk) await snapshotInUse(app, trigger, dyn);

  const to = await git.headOrNull(app.workdir);
  const record = {
    ts: new Date(startedAt).toISOString(),
    appId: app.id,
    kind: 'deploy',
    trigger,
    fromCommit,
    toCommit: to ? to.head : null,
    result,
    durationMs: Date.now() - startedAt,
    // Dynamic override KEY NAMES applied by this deployment (values
    // are never recorded). Empty when the app has no dynamic layer.
    dynamicKeys: dyn.dynamicKeys,
    steps,
  };
  if (!hasRemote) record.note = 'no remote — rebuild only';
  if (opts.workflowRunId != null) record.workflowRunId = opts.workflowRunId;
  if (opts.targetSha) {
    record.targetSha = opts.targetSha;
    if (!to || to.head !== opts.targetSha) {
      record.note = `HEAD after pull (${to ? to.head.slice(0, 7) : 'unknown'}) differs from the Actions run head SHA (${opts.targetSha.slice(0, 7)}); the branch head was deployed`;
    }
  }
  await appendDeployment(record);
  return record;
}

// Re-apply configuration after an .env edit: `docker compose up -d`
// (no rebuild, no git pull) so containers pick up the new env file.
// Recorded as a deployment with the given trigger ("manual-env").
// The caller must already hold the app's operation lock.
export async function redeploy(app, trigger) {
  const startedAt = Date.now();
  const steps = [];
  const head = await git.headOrNull(app.workdir);
  const commit = head ? head.head : null;

  async function step(name, cmd, args, timeout) {
    try {
      const { output } = await run(cmd, args, { timeout });
      steps.push({ name, ok: true, code: 0, output: tailText(output) });
    } catch (e) {
      steps.push({ name, ok: false, code: e.code, output: tailText(e.output || e.message) });
      throw e;
    }
  }

  let result = 'success';
  let dyn = { overridePath: null, dynamicKeys: [], entries: [] };
  let upOk = false;
  try {
    // A redeploy is a deployment too: dynamic overrides apply.
    dyn = await dynamicStep(app, steps);
    await step(
      'docker compose up -d (env updated)',
      'docker',
      [...composeFileArgs(app, dyn), 'up', '-d'],
      300_000,
    );
    upOk = true;
    await step(
      'docker compose ps (verify)',
      'docker',
      [...composeFileArgs(app, dyn), 'ps', '--format', 'json'],
      60_000,
    );
  } catch {
    result = 'failed';
  }
  if (upOk) await snapshotInUse(app, trigger, dyn);

  const record = {
    ts: new Date(startedAt).toISOString(),
    appId: app.id,
    kind: 'deploy',
    trigger,
    fromCommit: commit,
    toCommit: commit,
    result,
    durationMs: Date.now() - startedAt,
    dynamicKeys: dyn.dynamicKeys,
    steps,
  };
  await appendDeployment(record);
  return record;
}
