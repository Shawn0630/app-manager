// End-to-end verification on a machine WITHOUT a Docker daemon:
//   - a local bare git repo stands in for GitHub
//   - a clone of it stands in for an app's workdir
//   - tests/fake-bin/docker stands in for the docker CLI
// The manager is spawned with fake-bin first on PATH and exercised
// over HTTP: status, check, manual update, stop/start, logs, the
// busy mutex, Basic auth, and polling auto-deploy.
// Run: npm run test:e2e
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseComposePs } from '../src/docker.js';
import { tagsForRecord, failedStepOf } from '../src/activity.js';
import { mergeEnvEntries } from '../src/dynenv.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, 'tests', '.work');
const PORT = 19090;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  if (!cond) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.output = `${stdout}${stderr}`;
        reject(err);
      } else resolve({ stdout, stderr });
    });
  });
}
const gitC = (dir, args) => sh('git', ['-C', dir, ...args]);

async function api(method, p, headers = {}) {
  const res = await fetch(BASE + p, { method, headers });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave null
  }
  return { status: res.status, json, text };
}

async function waitFor(desc, fn, timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try {
      v = await fn();
    } catch {
      v = false; // e.g. connection refused while the server is starting
    }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for: ${desc}`);
    await sleep(400);
  }
}

async function setupFixtures() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const remote = path.join(WORK, 'remote.git');
  const seed = path.join(WORK, 'seed');
  const workdir = path.join(WORK, 'app');
  await sh('git', ['init', '--bare', '-b', 'main', remote]);
  await sh('git', ['init', '-b', 'main', seed]);
  await gitC(seed, ['config', 'user.name', 'Verify Bot']);
  await gitC(seed, ['config', 'user.email', 'verify@example.com']);
  fs.writeFileSync(path.join(seed, 'docker-compose.yml'), [
    'services:',
    '  web:',
    '    image: nginx:alpine',
    '    ports:',
    '      - "8088:80"',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(seed, 'app.txt'), 'v1\n');
  await gitC(seed, ['add', '.']);
  await gitC(seed, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'v1 initial']);
  await gitC(seed, ['remote', 'add', 'origin', remote]);
  await gitC(seed, ['push', 'origin', 'main']);
  await sh('git', ['clone', remote, workdir]);
  const { stdout } = await gitC(workdir, ['rev-parse', 'HEAD']);
  return { remote, seed, workdir, v1: stdout.trim() };
}

async function pushVersion(seed, version) {
  fs.writeFileSync(path.join(seed, 'app.txt'), `${version}\n`);
  await gitC(seed, ['commit', '-a', '-m', version]);
  await gitC(seed, ['push', 'origin', 'main']);
  const { stdout } = await gitC(seed, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

function writeConfig(file, app) {
  fs.writeFileSync(file, JSON.stringify({ apps: [app] }, null, 1));
}

function startManager({ configPath, dataDir, extraEnv = {} }) {
  const proc = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
    env: {
      ...process.env,
      PATH: `${path.join(ROOT, 'tests', 'fake-bin')}:${process.env.PATH}`,
      PORT: String(PORT),
      CONFIG_PATH: configPath,
      DATA_DIR: dataDir,
      FAKE_DOCKER_STATE: path.join(WORK, 'fake-state.json'),
      FAKE_DOCKER_CALLS: path.join(WORK, 'fake-calls.log'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => process.stdout.write(`[mgr] ${d}`));
  proc.stderr.on('data', (d) => process.stdout.write(`[mgr:err] ${d}`));
  return proc;
}

async function waitHealth() {
  await waitFor('manager health', async () => {
    try {
      const r = await api('GET', '/api/health');
      return r.status === 200;
    } catch {
      return false;
    }
  }, 15_000);
}

async function stopManager(proc) {
  if (!proc || proc.killed) return;
  proc.kill('SIGTERM');
  await sleep(600);
  if (!proc.killed) proc.kill('SIGKILL');
}

async function getApp() {
  const r = await api('GET', '/api/apps');
  return r.json.apps[0];
}

async function main() {
  const { remote, seed, workdir, v1 } = await setupFixtures();
  const dataDir = path.join(WORK, 'data');
  const appBase = {
    id: 'test-app',
    name: 'Test App',
    repoUrl: remote,
    workdir,
    branch: 'main',
    composeFile: 'docker-compose.yml',
    projectName: 'testapp',
    port: 8088,
    provider: 'builtin',
  };

  // ---- Phase 1: manual operations ----
  const manualCfg = path.join(WORK, 'apps.manual.json');
  writeConfig(manualCfg, { ...appBase, autoDeploy: false, pollIntervalSec: 120 });
  let mgr = startManager({ configPath: manualCfg, dataDir });
  try {
    await waitHealth();
    let a = await getApp();
    check('status includes local commit (v1)', a.commit && a.commit.head === v1, a.commit);
    check('state starts "stopped" (no containers)', a.state === 'stopped', a.state);
    check('no last deployment yet', a.lastDeployment === null);

    let r = await api('POST', '/api/apps/test-app/start');
    check('POST start -> 202', r.status === 202, r.status);
    await waitFor('running after start', async () => (await getApp()).state === 'running');
    a = await getApp();
    check(
      'container running with published port 8088',
      a.containers.length === 1
        && a.containers[0].state === 'running'
        && a.containers[0].ports.some((p) => p.published === 8088),
      a.containers,
    );

    const v2 = await pushVersion(seed, 'v2 change');
    r = await api('POST', '/api/apps/test-app/check');
    check('POST check -> 202', r.status === 202, r.status);
    await waitFor('behind flag set', async () => (await getApp()).behind === true);
    a = await getApp();
    check('remote head is v2', a.remote && a.remote.head === v2, a.remote);

    r = await api('POST', '/api/apps/test-app/update');
    check('POST update -> 202', r.status === 202, r.status);
    const dep = await waitFor('manual deployment record', async () => {
      const x = await api('GET', '/api/deployments?limit=5');
      return x.json.deployments.find((d) => d.appId === 'test-app' && d.kind === 'deploy' && d.trigger === 'manual');
    }, 60_000);
    check('manual deployment succeeded', dep.result === 'success', dep.result);
    check('deployment fromCommit = v1', dep.fromCommit === v1, dep.fromCommit);
    check('deployment toCommit = v2', dep.toCommit === v2, dep.toCommit);
    check('all pipeline steps ok', dep.steps.every((s) => s.ok), dep.steps.map((s) => s.name));
    const { stdout: headAfter } = await gitC(workdir, ['rev-parse', 'HEAD']);
    check('workdir HEAD moved to v2', headAfter.trim() === v2, headAfter.trim());
    const calls = fs.readFileSync(path.join(WORK, 'fake-calls.log'), 'utf8');
    check('fake docker saw "up -d --build"', calls.includes('"up","-d","--build"'));
    a = await getApp();
    check('app no longer busy after update', a.busy === null, a.busy);
    check('behind cleared after update', a.behind === false, a.behind);

    await api('POST', '/api/apps/test-app/stop');
    await waitFor('stopped after stop', async () => (await getApp()).state === 'stopped');
    check('state flips to stopped after stop', true);
    await api('POST', '/api/apps/test-app/start');
    await waitFor('running after start again', async () => (await getApp()).state === 'running');
    check('state flips back to running after start', true);

    r = await api('GET', '/api/apps/test-app/logs?tail=200');
    check('logs returns canned fake log lines', r.status === 200 && r.json.logs.includes('fake log line'), r.text.slice(0, 120));
  } finally {
    await stopManager(mgr);
  }

  // ---- Phase 2: polling auto-deploy ----
  const autoCfg = path.join(WORK, 'apps.auto.json');
  writeConfig(autoCfg, { ...appBase, autoDeploy: true, pollIntervalSec: 2 });
  mgr = startManager({ configPath: autoCfg, dataDir });
  try {
    await waitHealth();
    const v3 = await pushVersion(seed, 'v3 change');
    const dep = await waitFor('poll deployment record', async () => {
      const x = await api('GET', '/api/deployments?limit=10');
      return x.json.deployments.find((d) => d.appId === 'test-app' && d.trigger === 'poll' && d.toCommit === v3);
    }, 45_000);
    check('auto-deploy (poll) succeeded for v3', dep.result === 'success', dep.result);
    const { stdout: headV3 } = await gitC(workdir, ['rev-parse', 'HEAD']);
    check('workdir HEAD moved to v3 by auto-deploy', headV3.trim() === v3, headV3.trim());
  } finally {
    await stopManager(mgr);
  }

  // ---- Phase 3: Basic auth + busy mutex ----
  const authCfg = path.join(WORK, 'apps.auth.json');
  writeConfig(authCfg, { ...appBase, autoDeploy: false, pollIntervalSec: 120 });
  mgr = startManager({
    configPath: authCfg,
    dataDir,
    extraEnv: { MANAGER_PASSWORD: 's3cret', FAKE_DOCKER_DELAY_MS: '1500' },
  });
  try {
    // health is behind auth too; wait for a 401 to know the server is up
    await waitFor('auth challenge', async () => (await api('GET', '/api/health')).status === 401);
    const noAuth = await api('GET', '/api/apps');
    check('no credentials -> 401', noAuth.status === 401, noAuth.status);
    const auth = { Authorization: `Basic ${Buffer.from('admin:s3cret').toString('base64')}` };
    const withAuth = await api('GET', '/api/apps', auth);
    check('correct credentials -> 200', withAuth.status === 200, withAuth.status);

    const u = await api('POST', '/api/apps/test-app/update', auth);
    check('update accepted (auth phase)', u.status === 202, u.status);
    const s = await api('POST', '/api/apps/test-app/stop', auth);
    check('second op while busy -> 409', s.status === 409, s.status);
    await waitFor('busy cleared', async () => (await api('GET', '/api/apps', auth)).json.apps[0].busy === null, 30_000);
    check('busy clears after op finishes', true);
  } finally {
    await stopManager(mgr);
  }

  // ---- Phase 4: .env view / edit / redeploy ----
  const workdir2 = path.join(WORK, 'app2');
  await sh('git', ['clone', remote, workdir2]);
  fs.writeFileSync(path.join(workdir, '.env'), '# test env\nFOO=one\nBAR=keep\n');
  const envCfg = path.join(WORK, 'apps.env.json');
  fs.writeFileSync(envCfg, JSON.stringify({
    apps: [
      { ...appBase, autoDeploy: false, pollIntervalSec: 120 },
      { ...appBase, id: 'bare-app', name: 'Bare App', workdir: workdir2, projectName: 'bareapp', port: 3001 },
    ],
  }, null, 1));
  mgr = startManager({ configPath: envCfg, dataDir });
  try {
    await waitHealth();
    const putEnv = async (id, text) => {
      const res = await fetch(`${BASE}/api/apps/${id}/env`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };

    let r = await api('GET', '/api/apps/test-app/env');
    check('GET env: exists, ordered entries', r.status === 200 && r.json.exists === true
      && r.json.entries.length === 2 && r.json.entries[0].key === 'FOO' && r.json.entries[0].value === 'one'
      && r.json.entries[1].key === 'BAR', r.json);
    check('GET env: raw text includes the comment', Boolean(r.json && r.json.text.includes('# test env')));
    r = await api('GET', '/api/apps/bare-app/env');
    check('GET env: missing file -> exists=false, no entries',
      r.status === 200 && r.json.exists === false && r.json.entries.length === 0, r.json);

    const newText = '# test env\nFOO=secret-two\nBAR=keep\nNEWKEY=topsecret\n';
    const put = await putEnv('test-app', newText);
    check('PUT env -> 200 with key-name diff', put.status === 200 && put.json.ok === true
      && JSON.stringify(put.json.changed) === '["FOO"]'
      && JSON.stringify(put.json.added) === '["NEWKEY"]'
      && JSON.stringify(put.json.removed) === '[]', put.json);
    check('env file on disk updated', fs.readFileSync(path.join(workdir, '.env'), 'utf8') === newText);

    const backupDir = path.join(dataDir, 'backups', 'test-app');
    const backups = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter((f) => f.endsWith('.env'))
      : [];
    check('backup of previous version created', backups.length === 1, backups);
    if (backups.length) {
      const backupText = fs.readFileSync(path.join(backupDir, backups[0]), 'utf8');
      check('backup holds the OLD content', backupText.includes('FOO=one'), backupText);
    }

    const bad = await putEnv('test-app', 'FOO=ok\nTHIS IS NOT VALID\nBAR=keep\n');
    check('invalid line -> 400 with line number',
      bad.status === 400 && JSON.stringify(bad.json.badLines) === '[2]', bad.json);
    check('env file untouched after rejected PUT',
      fs.readFileSync(path.join(workdir, '.env'), 'utf8') === newText);

    const journal = fs.readFileSync(path.join(dataDir, 'deployments.jsonl'), 'utf8');
    const envRecord = journal.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((d) => d.kind === 'env');
    check('env record present in deployments.jsonl (key names)', Boolean(envRecord)
      && JSON.stringify(envRecord.added) === '["NEWKEY"]'
      && JSON.stringify(envRecord.changed) === '["FOO"]', envRecord);
    check('no env VALUES anywhere in deployments.jsonl',
      !journal.includes('topsecret') && !journal.includes('secret-two'));

    const callsBefore = fs.readFileSync(path.join(WORK, 'fake-calls.log'), 'utf8');
    const put2 = await putEnv('test-app', newText.replace('BAR=keep', 'BAR=keep2'));
    check('second PUT ok (changed BAR)',
      put2.status === 200 && JSON.stringify(put2.json.changed) === '["BAR"]', put2.json);
    r = await api('POST', '/api/apps/test-app/redeploy');
    check('POST redeploy -> 202', r.status === 202, r.status);
    const rdep = await waitFor('manual-env deployment record', async () => {
      const x = await api('GET', '/api/deployments?limit=30');
      return x.json.deployments.find((d) => d.appId === 'test-app' && d.trigger === 'manual-env');
    }, 30_000);
    check('redeploy recorded as manual-env success', rdep.result === 'success', rdep.result);
    const newCalls = fs.readFileSync(path.join(WORK, 'fake-calls.log'), 'utf8').slice(callsBefore.length);
    check('fake docker saw up -d without --build',
      newCalls.includes('"up","-d"') && !newCalls.includes('--build'),
      newCalls.trim().split('\n').slice(-3));
    const a = await getApp();
    check('lastDeployment after redeploy is the manual-env one',
      a.lastDeployment && a.lastDeployment.trigger === 'manual-env', a.lastDeployment && a.lastDeployment.trigger);
  } finally {
    await stopManager(mgr);
  }

  // ---- Phase 5: GitHub Actions trigger (mock API) + Add App ----
  // A local HTTP server stands in for api.github.com. The actions
  // app's repoUrl is a github.com URL (so owner/repo parsing works),
  // while its workdir origin is the local bare repo, so the deploy
  // pipeline's fetch/pull stay on this machine.
  const mockGh = { runs: [], lastAuth: null, hits: 0 };
  const mockServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://mock');
    if (/^\/repos\/[^/]+\/[^/]+\/actions\/runs$/.test(u.pathname)) {
      mockGh.hits += 1;
      mockGh.lastAuth = req.headers.authorization || null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total_count: mockGh.runs.length, workflow_runs: mockGh.runs }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"message":"not found"}');
    }
  });
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const ghApi = `http://127.0.0.1:${mockServer.address().port}`;
  const mkRun = (id, conclusion, sha) => ({
    id,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    status: 'completed',
    conclusion,
    head_sha: sha,
    head_branch: 'main',
    event: 'push',
    html_url: `https://github.com/test-owner/test-repo/actions/runs/${id}`,
    updated_at: new Date().toISOString(),
  });
  const cloneA = path.join(WORK, 'app-actions');
  const cloneB = path.join(WORK, 'app-commit');
  await sh('git', ['clone', remote, cloneA]);
  await sh('git', ['clone', remote, cloneB]);
  const { stdout: headNow } = await gitC(cloneA, ['rev-parse', 'HEAD']);
  const H0 = headNow.trim();
  mockGh.runs = [mkRun(101, 'success', H0)]; // already deployed: baseline only
  const ghData = path.join(WORK, 'data-gh');
  const appsRoot = path.join(WORK, 'apps-root');
  const ghCfg = path.join(WORK, 'apps.gh.json');
  fs.writeFileSync(ghCfg, JSON.stringify({
    apps: [
      {
        id: 'actions-app', name: 'Actions App', repoUrl: 'https://github.com/test-owner/test-repo.git',
        workdir: cloneA, branch: 'main', composeFile: 'docker-compose.yml', projectName: 'actionsapp',
        port: 8090, autoDeploy: true, pollIntervalSec: 2, trigger: 'actions', provider: 'builtin',
      },
      {
        id: 'commit-app', name: 'Commit App', repoUrl: remote,
        workdir: cloneB, branch: 'main', composeFile: 'docker-compose.yml', projectName: 'commitapp',
        port: 8091, autoDeploy: true, pollIntervalSec: 2, trigger: 'commit', provider: 'builtin',
      },
    ],
  }, null, 1));
  const ghEnv = { GITHUB_API_URL: ghApi, GITHUB_TOKEN: 'test-token-123', APPS_ROOT: appsRoot };
  const getAppById = async (id) => {
    const r = await api('GET', '/api/apps');
    return r.json.apps.find((x) => x.id === id);
  };
  const deploymentsOf = async (id) => {
    const r = await api('GET', '/api/deployments?limit=50');
    return r.json.deployments.filter((d) => d.appId === id);
  };
  mgr = startManager({ configPath: ghCfg, dataDir: ghData, extraEnv: ghEnv });
  try {
    await waitHealth();
    const a0 = await waitFor('actions run parsed into status', async () => {
      const x = await getAppById('actions-app');
      return x && x.lastActionRun && x.lastActionRun.id === 101 ? x : false;
    }, 20_000);
    check('status carries the latest completed Actions run',
      a0.lastActionRun.workflowName === 'CI' && a0.lastActionRun.conclusion === 'success' && a0.lastActionRun.headSha === H0,
      a0.lastActionRun);
    check('GITHUB_TOKEN sent to the API as a Bearer header',
      mockGh.lastAuth === 'Bearer test-token-123', mockGh.lastAuth);
    await sleep(5000);
    check('baseline run does not trigger a deploy', (await deploymentsOf('actions-app')).length === 0);

    const v4 = await pushVersion(seed, 'v4 change');
    await waitFor('commit-triggered deploy for the commit app', async () => {
      const ds = await deploymentsOf('commit-app');
      return ds.find((d) => d.trigger === 'poll' && d.toCommit === v4) || false;
    }, 30_000);
    check('trigger=commit app still auto-deploys on new commits', true);
    check('actions app NOT deployed by the commit alone',
      (await deploymentsOf('actions-app')).length === 0);
    const { stdout: headA1 } = await gitC(cloneA, ['rev-parse', 'HEAD']);
    check('actions app workdir still at the old commit', headA1.trim() === H0, headA1.trim());

    mockGh.runs.unshift(mkRun(102, 'failure', v4));
    await sleep(6000);
    check('a failed run does not trigger a deploy', (await deploymentsOf('actions-app')).length === 0);

    mockGh.runs.unshift(mkRun(103, 'success', v4));
    const dep103 = await waitFor('actions-triggered deployment', async () => {
      const ds = await deploymentsOf('actions-app');
      return ds.find((d) => d.trigger === 'actions') || false;
    }, 30_000);
    check('successful run triggers a deployment', dep103.result === 'success', dep103.result);
    check('deployment records workflowRunId + targetSha',
      dep103.workflowRunId === 103 && dep103.targetSha === v4, { run: dep103.workflowRunId, sha: dep103.targetSha });
    const { stdout: headA2 } = await gitC(cloneA, ['rev-parse', 'HEAD']);
    check('actions app workdir pulled to the run commit', headA2.trim() === v4, headA2.trim());
  } finally {
    await stopManager(mgr);
  }
  // Restart with the same DATA_DIR: run 103 must not fire again.
  mgr = startManager({ configPath: ghCfg, dataDir: ghData, extraEnv: ghEnv });
  try {
    await waitHealth();
    await waitFor('actions run visible after restart', async () => {
      const x = await getAppById('actions-app');
      return x && x.lastActionRun && x.lastActionRun.id === 103 ? x : false;
    }, 20_000);
    await sleep(5000);
    check('same run does not re-trigger after restart',
      (await deploymentsOf('actions-app')).filter((d) => d.trigger === 'actions').length === 1);

    // Add App: clone from the local bare repo into APPS_ROOT.
    const addRes = await fetch(`${BASE}/api/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoUrl: remote, trigger: 'commit', autoDeploy: false }),
    });
    const addJson = await addRes.json().catch(() => ({}));
    check('POST /api/apps registers the cloned repo (201, no warning)',
      addRes.status === 201 && addJson.app && addJson.app.id === 'remote' && !addJson.warning, addJson);
    check('clone landed in APPS_ROOT with the compose file',
      fs.existsSync(path.join(appsRoot, 'remote', 'docker-compose.yml')));
    const cfgOnDisk = JSON.parse(fs.readFileSync(ghCfg, 'utf8'));
    check('registry persisted to the config file',
      cfgOnDisk.apps.some((x) => x.id === 'remote'));
    const addedStatus = await getAppById('remote');
    check('added app appears in GET /api/apps at the current commit',
      addedStatus && addedStatus.commit && addedStatus.commit.head === (await gitC(seed, ['rev-parse', 'HEAD'])).stdout.trim(),
      addedStatus && addedStatus.commit);

    // Add App: repo without a compose file -> registered WITH warning.
    const ncRemote = path.join(WORK, 'nocompose.git');
    const ncSeed = path.join(WORK, 'seed-nc');
    await sh('git', ['init', '--bare', '-b', 'main', ncRemote]);
    await sh('git', ['init', '-b', 'main', ncSeed]);
    await gitC(ncSeed, ['config', 'user.name', 'Verify Bot']);
    await gitC(ncSeed, ['config', 'user.email', 'verify@example.com']);
    fs.writeFileSync(path.join(ncSeed, 'README.md'), 'no compose here\n');
    await gitC(ncSeed, ['add', '.']);
    await gitC(ncSeed, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'init']);
    await gitC(ncSeed, ['remote', 'add', 'origin', ncRemote]);
    await gitC(ncSeed, ['push', 'origin', 'main']);
    const addNc = await fetch(`${BASE}/api/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoUrl: ncRemote }),
    });
    const addNcJson = await addNc.json().catch(() => ({}));
    check('repo without compose file registers WITH a warning',
      addNc.status === 201 && typeof addNcJson.warning === 'string' && addNcJson.warning.includes('compose'),
      addNcJson.warning);
    const ncStatus = await getAppById('nocompose');
    check('warning is visible in the app status', Boolean(ncStatus && ncStatus.warning), ncStatus && ncStatus.warning);

    // Add App: un-cloneable repo -> registered WITH a clone warning.
    const addBad = await fetch(`${BASE}/api/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoUrl: '/nonexistent/nope.git' }),
    });
    const addBadJson = await addBad.json().catch(() => ({}));
    check('un-cloneable repo registers WITH a clone warning',
      addBad.status === 201 && typeof addBadJson.warning === 'string' && addBadJson.warning.includes('clone failed'),
      addBadJson.warning);

    // DELETE: plain removal keeps the workdir; purge removes it.
    const del1 = await fetch(`${BASE}/api/apps/nope`, { method: 'DELETE' });
    check('DELETE removes an app from the registry', del1.status === 200, del1.status);
    const del2 = await fetch(`${BASE}/api/apps/nocompose?purge=1`, { method: 'DELETE' });
    check('DELETE ?purge=1 ok', del2.status === 200, del2.status);
    check('purge deleted the workdir', !fs.existsSync(path.join(appsRoot, 'nocompose')));
    const del3 = await fetch(`${BASE}/api/apps/remote`, { method: 'DELETE' });
    check('DELETE (no purge) ok', del3.status === 200, del3.status);
    check('plain removal keeps the workdir', fs.existsSync(path.join(appsRoot, 'remote', 'docker-compose.yml')));
    const cfgAfter = JSON.parse(fs.readFileSync(ghCfg, 'utf8'));
    check('registry file no longer lists removed apps',
      !cfgAfter.apps.some((x) => ['remote', 'nocompose', 'nope'].includes(x.id)),
      cfgAfter.apps.map((x) => x.id));
  } finally {
    await stopManager(mgr);
    mockServer.close();
  }

  // ---- Phase 6: action journal + real-format ps parsing ----
  // Parser-level tolerance for the real Compose v2 output shapes:
  // pretty/compact arrays, NDJSON, and human warning lines mixed
  // into stdout (the case that used to collapse the parse).
  {
    const realC = {
      ID: 'abc123', Name: 'p-web-1', Image: 'nginx:alpine', Project: 'p', Service: 'web',
      State: 'running', Status: 'Up 2 minutes', Health: 'healthy', ExitCode: 0,
      Publishers: [{ URL: '0.0.0.0', TargetPort: 80, PublishedPort: 8088, Protocol: 'tcp' }],
    };
    const warn = 'time="2026-10-24T19:58:12Z" level=warning msg="the attribute `version` is obsolete"';
    check('parser: pretty-printed JSON array',
      parseComposePs(JSON.stringify([realC], null, 2)).length === 1);
    check('parser: warning line + compact array on one line',
      parseComposePs(`${warn}\n${JSON.stringify([realC])}`).length === 1);
    check('parser: NDJSON with a warning line',
      parseComposePs(`${warn}\n${JSON.stringify(realC)}\n${JSON.stringify({ ...realC, Name: 'p-db-1' })}`).length === 2);
    const oneLine = parseComposePs(`${warn}\n${JSON.stringify(realC)}`);
    check('parser: single NDJSON object is not mistaken for its Publishers array',
      oneLine.length === 1 && oneLine[0].Name === 'p-web-1', oneLine.map((c) => c.Name));
    check('parser: pure garbage -> empty list', parseComposePs('not json at all\n{broken').length === 0);
    check('parser: empty output -> empty list', parseComposePs('').length === 0);
  }

  // End to end with the fake docker emitting the older NDJSON
  // shape AND a warning line: status must still parse, and
  // start/stop must land in the activity journal.
  const psCfg = path.join(WORK, 'apps.manual.json');
  mgr = startManager({
    configPath: psCfg,
    dataDir,
    extraEnv: { FAKE_DOCKER_PS_FORMAT: 'ndjson', FAKE_DOCKER_PS_WARN: '1' },
  });
  try {
    await waitHealth();
    let a = await getApp();
    check('status carries statusError + statusCheckedAt',
      a.statusError === null && typeof a.statusCheckedAt === 'string', a.statusError);
    const stopRes = await api('POST', '/api/apps/test-app/stop');
    check('POST stop -> 202 (ndjson phase)', stopRes.status === 202, stopRes.status);
    await waitFor('busy cleared after stop', async () => (await getApp()).busy === null);
    a = await getApp();
    check('state stopped, parsed from NDJSON + warning line', a.state === 'stopped', a.state);
    const stopRec = await waitFor('stop action record', async () => {
      const x = await api('GET', '/api/deployments?limit=100');
      return x.json.deployments.find((d) => d.appId === 'test-app' && d.kind === 'action' && d.action === 'stop');
    });
    check('stop recorded as kind=action, success',
      stopRec.result === 'success' && typeof stopRec.durationMs === 'number', stopRec);

    const startRes = await api('POST', '/api/apps/test-app/start');
    check('POST start -> 202 (ndjson phase)', startRes.status === 202, startRes.status);
    await waitFor('running after start (ndjson)', async () => (await getApp()).state === 'running');
    a = await getApp();
    check('running with port 8088 parsed from NDJSON + warning line',
      a.containers.length === 1 && a.containers[0].state === 'running'
        && a.containers[0].ports.some((p) => p.published === 8088),
      a.containers);
    const startRec = await waitFor('start action record', async () => {
      const x = await api('GET', '/api/deployments?limit=100');
      return x.json.deployments.find((d) => d.appId === 'test-app' && d.kind === 'action' && d.action === 'start');
    });
    check('start recorded as kind=action, success', startRec.result === 'success', startRec.result);
    check('lastDeployment ignores action records',
      a.lastDeployment === null || a.lastDeployment.kind === 'deploy',
      a.lastDeployment && a.lastDeployment.kind);
  } finally {
    await stopManager(mgr);
  }

  // Same end-to-end status parse with the newer array shape + a
  // leading warning line on stdout.
  mgr = startManager({
    configPath: psCfg,
    dataDir,
    extraEnv: { FAKE_DOCKER_PS_FORMAT: 'json', FAKE_DOCKER_PS_WARN: '1' },
  });
  try {
    await waitHealth();
    const a = await getApp();
    check('array shape + warning line still parses to running + port',
      a.state === 'running' && a.containers.length === 1
        && a.containers[0].ports.some((p) => p.published === 8088),
      { state: a.state, containers: a.containers });
  } finally {
    await stopManager(mgr);
  }

  // ---- Phase 7: activity tags + dynamic env layer + in-use view ----
  // Tag mapping unit checks (synthetic records for every trigger
  // kind, so poll/actions/manual-env are covered without another
  // manager phase).
  {
    const tagOf = (rec, type) => (tagsForRecord(rec).find((t) => t.type === type) || {}).label;
    check('tags: poll deploy -> Auto · Commit trigger',
      tagOf({ kind: 'deploy', trigger: 'poll', result: 'success', steps: [] }, 'trigger') === 'Auto · Commit');
    check('tags: actions deploy -> GitHub Actions + Update',
      tagOf({ kind: 'deploy', trigger: 'actions', result: 'success', steps: [] }, 'trigger') === 'GitHub Actions'
        && tagOf({ kind: 'deploy', trigger: 'actions', result: 'success', steps: [] }, 'action') === 'Update');
    check('tags: manual-env deploy -> Redeploy action',
      tagOf({ kind: 'deploy', trigger: 'manual-env', result: 'success', steps: [] }, 'action') === 'Redeploy');
    check('tags: action record -> capitalized action name + result',
      tagOf({ kind: 'action', action: 'restart', trigger: 'manual', result: 'success' }, 'action') === 'Restart'
        && tagOf({ kind: 'action', action: 'restart', trigger: 'manual', result: 'success' }, 'result') === 'Success');
    check('tags: env records name their layer',
      tagOf({ kind: 'env', layer: 'dynamic', trigger: 'manual' }, 'action') === 'Dynamic env save'
        && tagOf({ kind: 'env', layer: 'static', trigger: 'manual' }, 'action') === 'Static env save'
        && tagOf({ kind: 'env', trigger: 'manual' }, 'action') === 'Env save');
    const failedRec = {
      kind: 'deploy', trigger: 'manual', result: 'failed',
      steps: [{ name: 'git fetch', ok: true }, { name: 'docker compose up -d --build', ok: false }],
    };
    check('tags: failed deploy names the failed step',
      failedStepOf(failedRec) === 'docker compose up -d --build'
        && tagOf(failedRec, 'failedStep') === 'failed at: docker compose up -d --build'
        && tagOf(failedRec, 'result') === 'Failed');
    const merged = mergeEnvEntries(
      [{ key: 'FOO', value: 's1' }, { key: 'BAR', value: 's2' }],
      [{ key: 'FOO', value: 'd1' }, { key: 'NEW', value: 'd2' }],
    );
    check('merge: dynamic wins, order static-then-dynamic-only, overridden flagged',
      merged.entries.length === 3
        && merged.entries[0].source === 'dynamic' && merged.entries[0].value === 'd1' && merged.entries[0].overridden === true
        && merged.entries[1].source === 'static'
        && merged.entries[2].key === 'NEW' && merged.entries[2].source === 'dynamic'
        && JSON.stringify(merged.overriddenKeys) === '["FOO"]',
      merged);
  }

  // End to end: save a dynamic layer, deploy, and confirm the
  // override really reaches the compose invocation, the journal
  // stays value-free, the static file is untouched, and the
  // "currently in use" view reports the merge (persistently).
  const staticText = 'FOO=static-foo\nBAR=keep\n';
  fs.writeFileSync(path.join(workdir, '.env'), staticText);
  const putJson = async (p, body) => {
    const res = await fetch(BASE + p, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  mgr = startManager({ configPath: psCfg, dataDir });
  try {
    await waitHealth();
    let r = await api('GET', '/api/apps/test-app/env/dynamic');
    check('GET dynamic: nothing saved yet',
      r.status === 200 && r.json.exists === false && r.json.entries.length === 0, r.json);
    r = await api('GET', '/api/apps/test-app/env/current');
    check('current before any dynamic deploy: not applied, static-only note',
      r.status === 200 && r.json.applied === false
        && typeof r.json.note === 'string' && r.json.note.includes('Static values only'),
      r.json && { applied: r.json.applied, note: r.json.note });
    const fooEntry = (r.json.entries || []).find((e) => e.key === 'FOO');
    check('current before: FOO from the static layer',
      Boolean(fooEntry) && fooEntry.source === 'static' && fooEntry.value === 'static-foo', fooEntry);

    const putDyn = await putJson('/api/apps/test-app/env/dynamic', { text: 'FOO=dynamic-foo\nDYNONLY=dynamic-secret\n' });
    check('PUT dynamic -> 200 with key-name diff',
      putDyn.status === 200 && putDyn.json.ok === true
        && JSON.stringify(putDyn.json.added) === '["FOO","DYNONLY"]', putDyn.json);
    r = await api('GET', '/api/apps/test-app/env/dynamic');
    check('GET dynamic returns the saved entries',
      r.json.exists === true && r.json.entries.length === 2 && r.json.entries[0].key === 'FOO', r.json);
    const badDyn = await putJson('/api/apps/test-app/env/dynamic', { text: 'NOT VALID LINE\n' });
    check('PUT dynamic invalid line -> 400', badDyn.status === 400, badDyn.status);

    const journal1 = fs.readFileSync(path.join(dataDir, 'deployments.jsonl'), 'utf8');
    const dynRecord = journal1.split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .find((d) => d.kind === 'env' && d.layer === 'dynamic');
    check('dynamic save journaled as kind=env layer=dynamic (key names)',
      Boolean(dynRecord) && JSON.stringify(dynRecord.added) === '["FOO","DYNONLY"]', dynRecord);
    check('journal records the static layer too',
      journal1.split('\n').filter(Boolean).map((l) => JSON.parse(l))
        .some((d) => d.kind === 'env' && d.layer === 'static'));
    check('no dynamic VALUES anywhere in deployments.jsonl',
      !journal1.includes('dynamic-foo') && !journal1.includes('dynamic-secret'));

    const callsMark = fs.readFileSync(path.join(WORK, 'fake-calls.log'), 'utf8').length;
    const upd = await api('POST', '/api/apps/test-app/update');
    check('POST update -> 202 (dynamic phase)', upd.status === 202, upd.status);
    const dynDep = await waitFor('deployment with dynamic overrides', async () => {
      const x = await api('GET', '/api/deployments?limit=100');
      return x.json.deployments.find(
        (d) => d.appId === 'test-app' && d.kind === 'deploy' && d.trigger === 'manual' && Array.isArray(d.dynamicKeys) && d.dynamicKeys.length === 2,
      );
    }, 60_000);
    check('deployment succeeded with dynamicKeys recorded (names only)',
      dynDep.result === 'success' && JSON.stringify(dynDep.dynamicKeys) === '["FOO","DYNONLY"]',
      { result: dynDep.result, dynamicKeys: dynDep.dynamicKeys });
    check('deployment has an ok "apply dynamic env" step',
      dynDep.steps.some((s) => s.name === 'apply dynamic env' && s.ok),
      dynDep.steps.map((s) => s.name));
    const depTags = Object.fromEntries((dynDep.tags || []).map((t) => [t.type, t.label]));
    check('deployment tags: Deploy / Update / Manual / Success',
      depTags.kind === 'Deploy' && depTags.action === 'Update'
        && depTags.trigger === 'Manual' && depTags.result === 'Success' && dynDep.failedStep === null,
      dynDep.tags);
    const newCalls = fs.readFileSync(path.join(WORK, 'fake-calls.log'), 'utf8').slice(callsMark);
    check('compose was asked for its services (config --services)',
      newCalls.includes('"config","--services"'));
    check('the up call carried the generated override file',
      newCalls.split('\n').some((l) => l.includes('"up"') && l.includes('docker-compose.manager.json')),
      newCalls.trim().split('\n').slice(-4));
    const overrideFile = path.join(dataDir, 'overrides', 'test-app', 'docker-compose.manager.json');
    const overrideDoc = JSON.parse(fs.readFileSync(overrideFile, 'utf8'));
    check('override file sets the dynamic values on the web service',
      overrideDoc.services.web.environment.FOO === 'dynamic-foo'
        && overrideDoc.services.web.environment.DYNONLY === 'dynamic-secret',
      overrideDoc.services.web.environment);
    check('static .env file untouched by the deployment',
      fs.readFileSync(path.join(workdir, '.env'), 'utf8') === staticText);

    r = await api('GET', '/api/apps/test-app/env/current');
    check('current after deploy: applied, with deployment stamp',
      r.json.applied === true && typeof r.json.deployedAt === 'string' && r.json.trigger === 'manual',
      { applied: r.json.applied, deployedAt: r.json.deployedAt });
    const byKey = Object.fromEntries((r.json.entries || []).map((e) => [e.key, e]));
    check('current after: FOO is dynamic, wins over static, flagged overridden',
      Boolean(byKey.FOO) && byKey.FOO.source === 'dynamic' && byKey.FOO.value === 'dynamic-foo' && byKey.FOO.overridden === true,
      byKey.FOO);
    check('current after: BAR stays static, DYNONLY is dynamic-only',
      Boolean(byKey.BAR) && byKey.BAR.source === 'static' && byKey.BAR.value === 'keep'
        && Boolean(byKey.DYNONLY) && byKey.DYNONLY.source === 'dynamic' && byKey.DYNONLY.overridden === false,
      { BAR: byKey.BAR, DYNONLY: byKey.DYNONLY });
    check('current after: overriddenKeys lists FOO',
      JSON.stringify(r.json.overriddenKeys) === '["FOO"]', r.json.overriddenKeys);

    // Start/Restart must NOT re-apply dynamic overrides: the calls
    // for a restart carry no override file.
    const restartMark = fs.readFileSync(path.join(WORK, 'fake-calls.log'), 'utf8').length;
    await api('POST', '/api/apps/test-app/restart');
    await waitFor('busy cleared after restart', async () => (await getApp()).busy === null);
    const restartCalls = fs.readFileSync(path.join(WORK, 'fake-calls.log'), 'utf8').slice(restartMark);
    check('restart ran WITHOUT the override file',
      restartCalls.includes('"restart"') && !restartCalls.includes('docker-compose.manager.json'),
      restartCalls.trim());
  } finally {
    await stopManager(mgr);
  }

  // The in-use snapshot is on disk: a fresh manager process still
  // reports the deployed merge.
  mgr = startManager({ configPath: psCfg, dataDir });
  try {
    await waitHealth();
    const r = await api('GET', '/api/apps/test-app/env/current');
    check('current survives a manager restart (snapshot persisted)',
      r.json.applied === true
        && (r.json.entries || []).some((e) => e.key === 'FOO' && e.source === 'dynamic'),
      { applied: r.json.applied });
  } finally {
    await stopManager(mgr);
  }

  // A failed deployment names its failed step, in the record and in
  // its tags. FAKE_DOCKER_FAIL_UP makes compose up exit 1.
  mgr = startManager({ configPath: psCfg, dataDir, extraEnv: { FAKE_DOCKER_FAIL_UP: '1' } });
  try {
    await waitHealth();
    const before = (await api('GET', '/api/deployments?limit=100')).json.deployments
      .filter((d) => d.kind === 'deploy' && d.result === 'failed').length;
    await api('POST', '/api/apps/test-app/update');
    const failedDep = await waitFor('failed deployment record', async () => {
      const x = await api('GET', '/api/deployments?limit=100');
      const failed = x.json.deployments.filter((d) => d.kind === 'deploy' && d.result === 'failed');
      return failed.length > before ? failed[0] : false;
    }, 60_000);
    check('failed deployment: failedStep is the up step',
      failedDep.failedStep === 'docker compose up -d --build', failedDep.failedStep);
    const fTags = Object.fromEntries((failedDep.tags || []).map((t) => [t.type, t.label]));
    check('failed deployment tags: Failed + failed-at step',
      fTags.result === 'Failed' && fTags.failedStep === 'failed at: docker compose up -d --build',
      failedDep.tags);
  } finally {
    await stopManager(mgr);
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E ERROR:', e && e.message ? e.message : e);
  process.exit(2);
});
