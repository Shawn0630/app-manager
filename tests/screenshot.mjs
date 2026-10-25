// Dashboard screenshots for eyeball verification, on a machine whose
// Chrome blocks direct loopback navigation: the page is loaded via
// the fake origin http://mgr.local:9000 and a CDP Fetch bridge
// forwards every request to the real server on 127.0.0.1:19092
// (same pattern as the ~/workspace/av-verify probes).
// Run: NODE_PATH=/tmp/pptr/node_modules node tests/screenshot.mjs
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire('/tmp/pptr/package.json');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, 'tests', '.work-shot');
const PORT = 19092;
const REAL = `http://127.0.0.1:${PORT}`;
const BASE = 'http://mgr.local:9000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')}: ${stdout}${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}
const gitC = (dir, args) => sh('git', ['-C', dir, ...args]);

function fetchReal(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function bridge(page) {
  const client = await page.createCDPSession();
  await client.send('Fetch.enable', { patterns: [{ urlPattern: `${BASE}/*`, requestStage: 'Request' }] });
  client.on('Fetch.requestPaused', async ({ requestId, request }) => {
    try {
      const u = new URL(request.url);
      const headers = { ...request.headers };
      delete headers.Host;
      delete headers.host;
      headers['accept-encoding'] = 'identity';
      const res = await fetchReal(REAL + u.pathname + u.search, request.method, headers, request.postData || null);
      const responseHeaders = [];
      for (const [name, value] of Object.entries(res.headers)) {
        if (name === 'content-length' || name === 'transfer-encoding' || name === 'connection') continue;
        responseHeaders.push({ name, value: String(value) });
      }
      await client.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: res.status,
        responseHeaders,
        body: res.body.toString('base64'),
      });
    } catch {
      await client.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
    }
  });
}

async function api(method, p) {
  const res = await fetch(REAL + p, { method });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function apiJson(method, p, body) {
  const res = await fetch(REAL + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const remote = path.join(WORK, 'remote.git');
  const seed = path.join(WORK, 'seed');
  const workdir = path.join(WORK, 'app');
  await sh('git', ['init', '--bare', '-b', 'main', remote]);
  await sh('git', ['init', '-b', 'main', seed]);
  await gitC(seed, ['config', 'user.name', 'Shot Bot']);
  await gitC(seed, ['config', 'user.email', 'shot@example.com']);
  fs.writeFileSync(path.join(seed, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "8088:80"\n');
  fs.writeFileSync(path.join(seed, 'app.txt'), 'v1\n');
  await gitC(seed, ['add', '.']);
  await gitC(seed, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'v1 initial']);
  await gitC(seed, ['remote', 'add', 'origin', remote]);
  await gitC(seed, ['push', 'origin', 'main']);
  await sh('git', ['clone', remote, workdir]);
  fs.writeFileSync(path.join(workdir, '.env'), '# demo app settings\nAPP_NAME=demo\nAPI_KEY=sk-demo-123456\nDEBUG=false\n');
  const { stdout: headOut } = await gitC(workdir, ['rev-parse', 'HEAD']);
  const head = headOut.trim();

  // Mock GitHub API with one completed, successful run at HEAD so
  // the card's Actions badge has something real to render.
  const mockServer = http.createServer((req, res) => {
    if (/^\/repos\/[^/]+\/[^/]+\/actions\/runs$/.test(new URL(req.url, 'http://mock').pathname)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        total_count: 1,
        workflow_runs: [{
          id: 42, name: 'CI', path: '.github/workflows/ci.yml', status: 'completed',
          conclusion: 'success', head_sha: head, head_branch: 'main', event: 'push',
          html_url: 'https://github.com/test-owner/test-repo/actions/runs/42',
          updated_at: new Date().toISOString(),
        }],
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
  });
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const ghApi = `http://127.0.0.1:${mockServer.address().port}`;

  const cfg = path.join(WORK, 'apps.json');
  fs.writeFileSync(cfg, JSON.stringify({
    apps: [{
      id: 'demo-app', name: 'Demo App', repoUrl: 'https://github.com/test-owner/test-repo.git', workdir, branch: 'main',
      composeFile: 'docker-compose.yml', projectName: 'demoapp', port: 8088,
      autoDeploy: true, pollIntervalSec: 2, provider: 'builtin', envFile: '.env', trigger: 'actions',
    }],
  }, null, 1));

  const mgr = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
    env: {
      ...process.env,
      PATH: `${path.join(ROOT, 'tests', 'fake-bin')}:${process.env.PATH}`,
      PORT: String(PORT),
      CONFIG_PATH: cfg,
      DATA_DIR: path.join(WORK, 'data'),
      FAKE_DOCKER_STATE: path.join(WORK, 'fake-state.json'),
      FAKE_DOCKER_CALLS: path.join(WORK, 'fake-calls.log'),
      GITHUB_API_URL: ghApi,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  mgr.stdout.on('data', (d) => process.stdout.write(`[mgr] ${d}`));
  mgr.stderr.on('data', (d) => process.stdout.write(`[mgr:err] ${d}`));

  let browser;
  try {
    // Wait for health, start the app, run one update so the history
    // section has a deployment to show.
    for (let i = 0; i < 40; i += 1) {
      try {
        const h = await api('GET', '/api/health');
        if (h.status === 200) break;
      } catch { /* not up yet */ }
      await sleep(400);
    }
    await api('POST', '/api/apps/demo-app/start');
    // Wait until start has fully finished (busy cleared) before
    // triggering the update, otherwise the update is rejected (409).
    for (let i = 0; i < 60; i += 1) {
      const s = await api('GET', '/api/apps');
      const a = s.json && s.json.apps[0];
      if (a && a.state === 'running' && !a.busy) break;
      await sleep(300);
    }
    // Save a dynamic layer: DEBUG overrides the static value,
    // EXTRA_FLAG exists only dynamically. The update below then
    // deploys WITH the overrides, so the Activity row gains tags and
    // a dynamic-keys line, and the env panel's "Currently in use"
    // section shows the merged result.
    const dyn = await apiJson('PUT', '/api/apps/demo-app/env/dynamic', { text: 'DEBUG=true\nEXTRA_FLAG=from-dynamic\n' });
    if (dyn.status !== 200) throw new Error(`dynamic save failed: HTTP ${dyn.status}`);
    const upd = await api('POST', '/api/apps/demo-app/update');
    if (upd.status !== 202) throw new Error(`update not accepted: HTTP ${upd.status}`);
    let depOk = false;
    for (let i = 0; i < 60; i += 1) {
      const d = await api('GET', '/api/deployments?limit=5');
      if (d.json && d.json.deployments.length) { depOk = true; break; }
      await sleep(400);
    }
    if (!depOk) throw new Error('deployment record never appeared');
    // Let the app settle (busy cleared, Actions badge populated)
    // before screenshotting.
    for (let i = 0; i < 60; i += 1) {
      const s = await api('GET', '/api/apps');
      const a = s.json && s.json.apps[0];
      if (a && !a.busy && a.lastDeployment && a.lastActionRun) break;
      await sleep(300);
    }

    browser = await puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,1250', '--no-proxy-server'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1250 });
    await bridge(page);
    // Apps view (default route): app cards only.
    await page.goto(`${BASE}/#/apps`, { waitUntil: 'networkidle0', timeout: 60_000 });
    await page.waitForSelector('.card', { timeout: 20_000 });
    await sleep(800);
    await page.screenshot({ path: path.join(WORK, 'dashboard.png'), fullPage: true });
    console.log('saved dashboard.png (Apps view)');

    // Open the Environment editor and screenshot it (all three
    // sections populated, values masked by default).
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button[data-action="env"]')][0];
      if (btn) btn.click();
    });
    await page.waitForSelector('#envModal:not(.hidden) #inUseRows tr', { timeout: 20_000 });
    await page.waitForSelector('#envModal:not(.hidden) #dynRows tr', { timeout: 20_000 });
    await sleep(600);
    await page.screenshot({ path: path.join(WORK, 'dashboard-env.png') });
    console.log('saved dashboard-env.png');
    await page.evaluate(() => document.getElementById('envClose').click());

    // Activity view: the tag-based stream on its own page.
    await page.evaluate(() => { location.hash = '#/activity'; });
    await page.waitForSelector('#view-activity:not(.hidden) .hist-row', { timeout: 20_000 });
    await sleep(600);
    await page.screenshot({ path: path.join(WORK, 'dashboard-activity.png'), fullPage: true });
    console.log('saved dashboard-activity.png (Activity view)');

    // Add Project view: both forms.
    await page.evaluate(() => { location.hash = '#/add'; });
    await page.waitForSelector('#view-add:not(.hidden) #localForm', { timeout: 20_000 });
    await sleep(600);
    await page.screenshot({ path: path.join(WORK, 'dashboard-add.png'), fullPage: true });
    console.log('saved dashboard-add.png (Add Project view)');

    // Narrow viewport on the Apps view: cards must collapse to a
    // single column without horizontal overflow.
    await page.evaluate(() => { location.hash = '#/apps'; });
    await page.setViewport({ width: 420, height: 900 });
    await sleep(600);
    await page.screenshot({ path: path.join(WORK, 'dashboard-mobile.png'), fullPage: true });
    console.log('saved dashboard-mobile.png');
  } finally {
    if (browser) await browser.close();
    mgr.kill('SIGTERM');
    mockServer.close();
  }
}

main().catch((e) => {
  console.error('SCREENSHOT ERROR:', e && e.message ? e.message : e);
  process.exit(2);
});
