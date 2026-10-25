// App Manager dashboard. Plain fetch + innerHTML rendering, no framework.
//
// Three views in one page, switched by hash routing:
//   #/apps (default) — the app card grid
//   #/activity       — the activity stream (with an app filter)
//   #/add            — Add Project (from GitHub / from a local folder)
//
// Refresh design (this used to be the "status never updates" bug
// surface, so it is deliberately defensive):
//  - apps and deployments are fetched independently; one failing
//    must not freeze the other panel;
//  - a render error in one card degrades to an error card for that
//    app instead of stopping the whole grid;
//  - polling adapts: 2 s while any app is busy, 10 s when idle, plus
//    an immediate refresh right after an action is posted — so the
//    busy -> done transition appears without waiting out a cycle.
//  - the activity stream is only fetched while its view is active
//    (and immediately when the view is entered).
const $ = (id) => document.getElementById(id);
const appsEl = $('apps');
const historyEl = $('history');
const updatedEl = $('updated');

const STATE_LABEL = {
  running: 'Running',
  stopped: 'Stopped',
  partial: 'Partially running',
  unknown: 'Unknown',
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

function fmtClock(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  return `${(ms / 1000).toFixed(1)}s`;
}

function shortHash(h) {
  return h ? h.slice(0, 7) : '—';
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function triggerLabel(trigger) {
  if (trigger === 'poll') return 'auto (commit)';
  if (trigger === 'actions') return 'GitHub Actions';
  if (trigger === 'manual-env') return 'manual (env)';
  return 'manual';
}

function deploymentValue(dep) {
  if (!dep) return 'never';
  const badge = dep.result === 'success'
    ? '<span class="badge ok no-dot">success</span>'
    : '<span class="badge fail no-dot">failed</span>';
  return `${esc(fmtTime(dep.ts))} · ${esc(triggerLabel(dep.trigger))} · ${badge} · ${esc(fmtDuration(dep.durationMs))}`;
}

function remoteValue(a) {
  if (!a.repoUrl) return '<span class="muted">no GitHub remote</span>';
  if (a.lastPollError && !a.remote) {
    return `<span class="err">check failed: ${esc(a.lastPollError)}</span>`;
  }
  if (!a.remote) return 'not checked yet';
  if (a.behind) {
    return `<span class="badge update no-dot">update available</span> <span class="hash">${esc(a.remote.short)}</span>`;
  }
  return `up to date <span class="hash">${esc(a.remote.short)}</span>`;
}

function containersHtml(a) {
  if (!a.containers || !a.containers.length) return '';
  const items = a.containers.map((c) => {
    const ports = (c.ports || []).map((p) =>
      `<span class="port-chip">${esc(p.published)} → ${esc(p.target)}/${esc(p.protocol || 'tcp')}</span>`).join(' ');
    const health = c.health && c.health !== 'none' ? `<span class="chealth">${esc(c.health)}</span>` : '';
    return `<div class="container-row">
      <span class="cdot ${esc(c.state)}"></span>
      <span class="cname">${esc(c.name || c.service || '')}</span>
      <span class="muted">${esc(c.status || c.state || '')}</span>${health}${ports}
    </div>`;
  });
  return `<div class="containers">${items.join('')}</div>`;
}

// The Port row follows the effective port the API computed:
// the actual published port while the app runs (a plain link),
// the registered port as the expected port when stopped (muted,
// "(expected)"), and — when the two disagree — a note naming the
// stale registered value.
function portValue(a) {
  const eff = a.effectivePort != null ? a.effectivePort : a.port;
  if (!eff) return '—';
  const cls = a.portSource === 'configured' && !a.portMismatch ? ' class="port-expected"' : '';
  const link = `<a${cls} href="http://${esc(location.hostname)}:${eff}" target="_blank" rel="noopener">${eff}</a>`;
  if (a.portMismatch) {
    return `${link} <span class="port-note">⚠ registered: ${esc(a.port)}</span>`;
  }
  if (a.portSource === 'configured') {
    return `${link} <span class="muted">(expected)</span>`;
  }
  return link;
}

function actionsValue(a) {
  if (a.trigger !== 'actions' && a.trigger !== 'both') return '';
  if (a.lastActionsError) {
    return `<span class="err">check failed: ${esc(a.lastActionsError)}</span>`;
  }
  const r = a.lastActionRun;
  if (!r) return 'no completed runs seen yet';
  const label = `${r.workflowName} · ${r.conclusion || r.status} · ${fmtTime(r.updatedAt)}`;
  return r.htmlUrl
    ? `<a href="${esc(r.htmlUrl)}" target="_blank" rel="noopener">${esc(label)}</a>`
    : esc(label);
}

function statePill(a) {
  if (a.busy) return `<span class="badge busy">${esc(`Working: ${a.busy.op}`)}</span>`;
  return `<span class="badge ${esc(a.state)}">${esc(STATE_LABEL[a.state] || a.state)}</span>`;
}

function cardHtml(a) {
  const busy = a.busy ? a.busy.op : null;
  const disabled = busy ? 'disabled' : '';
  const portLink = portValue(a);
  const commitLine = a.commit
    ? `<span class="hash">${esc(a.commit.short)}</span> <span class="subject">${esc(a.commit.subject || '')}</span>`
    : a.source === 'local' && !a.repoUrl
      ? '<span class="muted">not a git repository</span>'
      : `<span class="err">${esc(a.commitError || 'unavailable')}</span>`;
  const btn = (action, label, cls = '') =>
    `<button type="button" class="${cls}" data-action="${action}" data-id="${esc(a.id)}" ${disabled}>${label}</button>`;
  const buttons = [
    btn('update', 'Update', 'primary'),
    btn('start', 'Start', 'btn-start'),
    btn('stop', 'Stop', 'btn-danger'),
    btn('restart', 'Restart'),
    btn('check', 'Check now'),
    btn('logs', 'Logs'),
    btn('env', 'Environment'),
    btn('remove', 'Remove', 'btn-ghost-danger'),
  ].join('');
  return `
  <div class="card">
    <div class="card-head">
      <span class="dot ${esc(a.state)}"></span>
      <span class="name">${esc(a.name)}</span>
      ${statePill(a)}
      ${a.source === 'local' ? '<span class="badge local no-dot">local folder</span>' : ''}
      ${a.autoDeploy ? '<span class="badge auto no-dot">auto-deploy on</span>' : '<span class="badge no-dot">auto-deploy off</span>'}
      ${a.trigger && a.trigger !== 'commit' ? `<span class="badge no-dot">trigger: ${esc(a.trigger)}</span>` : ''}
      <span class="checked">checked ${esc(fmtClock(a.statusCheckedAt))}</span>
    </div>
    ${a.warning ? `<div class="alert warn">⚠ ${esc(a.warning)}</div>` : ''}
    ${a.statusError ? `<div class="alert error">Status check failed: ${esc(a.statusError)}</div>` : ''}
    ${busy ? `<div class="busy-note"><span class="spinner"></span>Working: ${esc(busy)}…</div>` : ''}
    <div class="rows">
      <div class="row"><span class="k">Port</span><span class="v">${portLink}</span></div>
      ${a.source === 'local' ? `<div class="row"><span class="k">Folder</span><span class="v"><span class="mono">${esc(a.workdir)}</span></span></div>` : ''}
      <div class="row"><span class="k">Commit</span><span class="v">${commitLine}</span></div>
      <div class="row"><span class="k">Remote</span><span class="v">${remoteValue(a)}</span></div>
      ${actionsValue(a) ? `<div class="row"><span class="k">Actions</span><span class="v">${actionsValue(a)}</span></div>` : ''}
      <div class="row"><span class="k">Last deploy</span><span class="v">${deploymentValue(a.lastDeployment)}</span></div>
    </div>
    ${containersHtml(a)}
    <div class="buttons">${buttons}</div>
  </div>`;
}

function errorCardHtml(a, err) {
  return `<div class="card">
    <div class="card-head"><span class="dot unknown"></span><span class="name">${esc(a && a.name ? a.name : 'App')}</span>
    <span class="badge unknown">Render error</span></div>
    <div class="alert error">This card failed to render: ${esc(err && err.message ? err.message : err)}. The rest of the dashboard keeps updating.</div>
  </div>`;
}

function renderApps(apps) {
  appsEl.innerHTML = apps.length
    ? apps.map((a) => {
      try {
        return cardHtml(a);
      } catch (e) {
        return errorCardHtml(a, e);
      }
    }).join('')
    : '<div class="empty">No apps configured.</div>';
}

function renderSummary(apps) {
  const counts = { running: 0, stopped: 0, other: 0, busy: 0 };
  for (const a of apps) {
    if (a.busy) counts.busy += 1;
    if (a.state === 'running') counts.running += 1;
    else if (a.state === 'stopped') counts.stopped += 1;
    else counts.other += 1;
  }
  $('summary').innerHTML =
    `<span class="chip"><b>${counts.running}</b> running</span>` +
    `<span class="chip"><b>${counts.stopped}</b> stopped</span>` +
    (counts.other ? `<span class="chip"><b>${counts.other}</b> partial/unknown</span>` : '') +
    (counts.busy ? `<span class="chip working"><b>${counts.busy}</b> working</span>` : '');
}

// Activity rows are rendered from TAGS: the server attaches a
// `tags` array (kind / action / trigger / result / failed step) to
// every record served by /api/deployments. deriveTags mirrors that
// logic as a fallback so a record without tags (old cache, partial
// response) still renders as chips instead of raw text.
function deriveTags(d) {
  const tags = [];
  const kind = d.kind || 'deploy';
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  if (kind === 'deploy') tags.push({ type: 'kind', label: 'Deploy', cls: 'kind-deploy' });
  else if (kind === 'action') tags.push({ type: 'kind', label: 'Action', cls: 'kind-action' });
  else if (kind === 'env') tags.push({ type: 'kind', label: 'Env', cls: 'kind-env' });
  if (kind === 'action' && d.action) tags.push({ type: 'action', label: cap(d.action), cls: 'tag-action' });
  else if (kind === 'deploy') tags.push({ type: 'action', label: d.trigger === 'manual-env' ? 'Redeploy' : 'Update', cls: 'tag-action' });
  else if (kind === 'env') {
    tags.push({
      type: 'action',
      label: d.layer === 'dynamic' ? 'Dynamic env save' : d.layer === 'static' ? 'Static env save' : 'Env save',
      cls: 'tag-action',
    });
  }
  if (d.trigger === 'poll') tags.push({ type: 'trigger', label: 'Auto · Commit', cls: 'trig-auto' });
  else if (d.trigger === 'actions') tags.push({ type: 'trigger', label: 'GitHub Actions', cls: 'trig-actions' });
  else tags.push({ type: 'trigger', label: 'Manual', cls: 'trig-manual' });
  if (d.result === 'success') tags.push({ type: 'result', label: 'Success', cls: 'ok' });
  else if (d.result === 'failed') tags.push({ type: 'result', label: 'Failed', cls: 'fail' });
  if (d.failedStep) tags.push({ type: 'failedStep', label: `failed at: ${d.failedStep}`, cls: 'fail-step' });
  else if (kind === 'deploy' && d.result === 'failed') {
    const bad = (d.steps || []).find((s) => !s.ok);
    if (bad) tags.push({ type: 'failedStep', label: `failed at: ${bad.name}`, cls: 'fail-step' });
  }
  return tags;
}

function tagsHtml(d) {
  const tags = (d.tags && d.tags.length) ? d.tags : deriveTags(d);
  return `<span class="tags">${tags.map((t) => `<span class="badge ${esc(t.cls || '')} no-dot">${esc(t.label)}</span>`).join(' ')}</span>`;
}

function historyRow(d) {
  const when = esc(fmtTime(d.ts));
  const head = `<span class="when">${when}</span> · <span class="app-name">${esc(d.appId)}</span> ${tagsHtml(d)}`;
  const dur = ` <span class="note">· ${esc(fmtDuration(d.durationMs))}</span>`;

  if (d.kind === 'action') {
    return `
    <div class="hist-row kind-action">
      ${head}${dur}
      ${d.output ? `<details><summary>Output</summary><pre class="output">${esc(d.output)}</pre></details>` : ''}
    </div>`;
  }
  if (d.kind === 'env') {
    const parts = [];
    if ((d.added || []).length) parts.push(`added: ${d.added.map(esc).join(', ')}`);
    if ((d.changed || []).length) parts.push(`changed: ${d.changed.map(esc).join(', ')}`);
    if ((d.removed || []).length) parts.push(`removed: ${d.removed.map(esc).join(', ')}`);
    return `
    <div class="hist-row kind-env">
      ${head}
      ${parts.length ? `<span class="note">· ${parts.join(' · ')}</span>` : ''}
    </div>`;
  }
  const runRef = d.workflowRunId != null ? ` <span class="note">· run #${esc(String(d.workflowRunId))}</span>` : '';
  const note = d.note ? `<div class="note">${esc(d.note)}</div>` : '';
  const dynLine = (d.dynamicKeys || []).length
    ? `<div class="dyn-line">Dynamic overrides applied: ${d.dynamicKeys.map(esc).join(', ')}</div>`
    : '';
  const steps = (d.steps || []).map((s) => `
    <div class="step">
      <span class="badge ${s.ok ? 'ok' : 'fail'} no-dot">${s.ok ? 'ok' : `failed (exit ${s.code == null ? '?' : s.code})`}</span>
      <b>${esc(s.name)}</b> <span class="note">${esc(fmtDuration(s.durationMs))}</span>
      ${s.output ? `<pre>${esc(s.output)}</pre>` : ''}
    </div>`).join('');
  return `
  <div class="hist-row kind-deploy">
    ${head}${runRef}${dur}
    <span class="note">· <span class="hash">${esc(shortHash(d.fromCommit))} → ${esc(shortHash(d.toCommit))}</span></span>
    ${note}
    ${steps || dynLine ? `<details><summary>Steps (${(d.steps || []).length})</summary>${dynLine}${steps}</details>` : ''}
  </div>`;
}

let lastDeployments = [];

function renderHistory(deployments) {
  lastDeployments = deployments || lastDeployments;
  const filterEl = $('historyFilter');
  const filter = filterEl ? filterEl.value : '';
  const rows = filter
    ? lastDeployments.filter((d) => d.appId === filter)
    : lastDeployments;
  historyEl.innerHTML = rows.length
    ? `<div class="hist-list">${rows.map(historyRow).join('')}</div>`
    : '<div class="empty">No activity yet.</div>';
}

// Keep the Activity app filter's options in sync with the registry,
// preserving the current selection across refreshes.
function syncHistoryFilter(apps) {
  const filterEl = $('historyFilter');
  if (!filterEl) return;
  const current = filterEl.value;
  const ids = [...new Set(apps.map((a) => a.id))].sort();
  const wanted = `<option value="">All apps</option>${ids.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('')}`;
  if (filterEl.innerHTML !== wanted) filterEl.innerHTML = wanted;
  if (ids.includes(current) || current === '') filterEl.value = current;
}

let pollTimer = null;
let refreshInFlight = false;

function schedulePoll(ms) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(refresh, ms);
}

async function refresh() {
  if (refreshInFlight) {
    schedulePoll(1000);
    return;
  }
  refreshInFlight = true;
  try {
    // The activity stream is only fetched while the Activity view
    // is active (entering the view triggers a refresh of its own).
    const jobs = [api('/api/apps')];
    if (currentRoute() === 'activity') jobs.push(api('/api/deployments?limit=100'));
    const [appsRes, depsRes] = await Promise.allSettled(jobs);
    let anyBusy = false;
    if (appsRes.status === 'fulfilled') {
      const apps = appsRes.value.apps || [];
      anyBusy = apps.some((a) => a.busy);
      renderSummary(apps);
      renderApps(apps);
      syncHistoryFilter(apps);
    }
    if (depsRes && depsRes.status === 'fulfilled') {
      renderHistory(depsRes.value.deployments || []);
    }
    if (appsRes.status === 'fulfilled' || (depsRes && depsRes.status === 'fulfilled')) {
      updatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } else {
      updatedEl.textContent = `Refresh failed: ${appsRes.reason ? appsRes.reason.message : 'unknown error'}`;
    }
    schedulePoll(anyBusy ? 2000 : 10000);
  } finally {
    refreshInFlight = false;
  }
}

async function doAction(id, action) {
  if (action === 'remove') {
    if (!confirm(`Remove app "${id}" from the registry? Its files on disk are kept.`)) return;
    try {
      await api(`/api/apps/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (e) {
      alert(e.message);
    }
    refresh();
    return;
  }
  if (action === 'env') {
    openEnv(id);
    return;
  }
  if (action === 'logs') {
    const logModal = $('logModal');
    $('logTitle').textContent = `Logs — ${id}`;
    $('logBody').textContent = 'Loading…';
    logModal.classList.remove('hidden');
    try {
      const { logs } = await api(`/api/apps/${encodeURIComponent(id)}/logs?tail=200`);
      $('logBody').textContent = logs || '(no logs)';
    } catch (e) {
      $('logBody').textContent = `Failed to load logs: ${e.message}`;
    }
    return;
  }
  try {
    await api(`/api/apps/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
  } catch (e) {
    alert(e.message);
  }
  // Refresh immediately (the busy state shows at once); the adaptive
  // poller then tracks the operation until it completes.
  refresh();
}

appsEl.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-action]');
  if (!btn || btn.disabled) return;
  doAction(btn.dataset.id, btn.dataset.action);
});
$('refreshBtn').addEventListener('click', refresh);
$('logClose').addEventListener('click', () => $('logModal').classList.add('hidden'));
$('logModal').addEventListener('click', (ev) => {
  if (ev.target === $('logModal')) $('logModal').classList.add('hidden');
});
$('historyFilter').addEventListener('change', () => renderHistory());

// ---------- View routing (hash based) ----------
const ROUTES = ['apps', 'activity', 'add'];

function currentRoute() {
  const m = String(location.hash || '').match(/^#\/([a-z]+)/);
  return m && ROUTES.includes(m[1]) ? m[1] : 'apps';
}

function applyRoute() {
  const route = currentRoute();
  for (const r of ROUTES) {
    const view = $(`view-${r}`);
    if (view) view.classList.toggle('hidden', r !== route);
  }
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.classList.toggle('active', link.dataset.route === route);
  });
  // Entering the Activity view loads the stream right away instead
  // of waiting for the next poll cycle.
  if (route === 'activity') refresh();
}

window.addEventListener('hashchange', applyRoute);
applyRoute();
refresh();

// ---------- Environment (.env) editor ----------
// Two modes over one document:
//  - Table mode edits values in place; serializing walks the original
//    text so comments and blank lines survive, removed keys drop out,
//    and new keys are appended at the end.
//  - Raw mode edits the whole file text (comments included).
// Values are masked (password inputs) unless "Show values" is on.
const envModal = document.getElementById('envModal');
const envTitle = document.getElementById('envTitle');
const envNote = document.getElementById('envNote');
const envMsg = document.getElementById('envMsg');
const envRows = document.getElementById('envRows');
const envRaw = document.getElementById('envRaw');
const envTableWrap = document.getElementById('envTableWrap');
const envShowValues = document.getElementById('envShowValues');
const envModeTableBtn = document.getElementById('envModeTable');
const envModeRawBtn = document.getElementById('envModeRaw');
const inUseMeta = document.getElementById('inUseMeta');
const inUseRows = document.getElementById('inUseRows');
const inUseEmpty = document.getElementById('inUseEmpty');
const dynRows = document.getElementById('dynRows');
const dynMsg = document.getElementById('dynMsg');
let envCtx = null; // { id, envFile, originalText, mode, inUse }

function envRowHtml(key, value, isNew) {
  return `<td><input class="env-key" value="${esc(key)}" ${isNew ? '' : 'readonly'} spellcheck="false"></td>
    <td><input class="env-val" type="${envShowValues.checked ? 'text' : 'password'}" value="${esc(value)}" spellcheck="false"></td>
    <td><button type="button" class="env-del">Remove</button></td>`;
}

function renderEnvRows(entries) {
  envRows.innerHTML = entries.map((e) => `<tr>${envRowHtml(e.key, e.value, false)}</tr>`).join('');
}

function readTableRows() {
  const rows = [];
  envRows.querySelectorAll('tr').forEach((tr) => {
    const key = tr.querySelector('.env-key').value.trim();
    const value = tr.querySelector('.env-val').value;
    if (key) rows.push({ key, value });
  });
  return rows;
}

function serializeTable() {
  const rows = readTableRows();
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const emitted = new Set();
  const out = [];
  for (const line of envCtx.originalText.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const isEntry = m && !line.trim().startsWith('#');
    if (isEntry) {
      const key = m[1];
      if (byKey.has(key) && !emitted.has(key)) {
        out.push(`${key}=${byKey.get(key)}`);
        emitted.add(key);
      }
      // removed keys and later duplicates are dropped
    } else {
      out.push(line);
    }
  }
  for (const r of rows) {
    if (!emitted.has(r.key)) {
      out.push(`${r.key}=${r.value}`);
      emitted.add(r.key);
    }
  }
  return out.join('\n');
}

function parseEntries(text) {
  const entries = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.replace(/\r$/, '');
    if (!t.trim() || t.trim().startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) entries.push({ key: t.slice(0, eq).trim(), value: t.slice(eq + 1) });
  }
  return entries;
}

function setEnvMode(mode) {
  if (!envCtx) return;
  if (mode === envCtx.mode) return;
  if (mode === 'raw') {
    envRaw.value = serializeTable();
  } else {
    envCtx.originalText = envRaw.value;
    renderEnvRows(parseEntries(envRaw.value));
  }
  envCtx.mode = mode;
  envTableWrap.classList.toggle('hidden', mode !== 'table');
  envRaw.classList.toggle('hidden', mode !== 'raw');
  envModeTableBtn.classList.toggle('active', mode === 'table');
  envModeRawBtn.classList.toggle('active', mode === 'raw');
}

function envCurrentText() {
  return envCtx.mode === 'raw' ? envRaw.value : serializeTable();
}

// "Currently in use": the effective env of the last deployment.
// Values are masked unless "Show values" is on (same toggle as the
// editors). Each row carries its source tag; a dynamic row that
// shadowed a static key says so.
function renderInUse(data) {
  if (!envCtx) return;
  envCtx.inUse = data;
  if (!data) {
    inUseMeta.textContent = 'Failed to load.';
    inUseRows.innerHTML = '';
    inUseEmpty.classList.add('hidden');
    return;
  }
  if (data.applied) {
    inUseMeta.textContent = `In effect since the deployment at ${fmtTime(data.deployedAt)} · ${triggerLabel(data.trigger)}.`;
  } else if (data.deployedAt) {
    inUseMeta.textContent = `Last deployment at ${fmtTime(data.deployedAt)} · ${triggerLabel(data.trigger)}. ${data.note || ''}`;
  } else {
    inUseMeta.textContent = data.note || '';
  }
  const show = envShowValues.checked;
  inUseRows.innerHTML = (data.entries || []).map((e) => {
    const src = e.source === 'dynamic'
      ? '<span class="badge src-dynamic no-dot">dynamic</span>'
      : '<span class="badge src-static no-dot">static</span>';
    const over = e.overridden ? ' <span class="note">overrides the static value</span>' : '';
    const val = e.stale
      ? '<span class="note">(value no longer set)</span>'
      : show
        ? `<span class="mono">${esc(e.value)}</span>`
        : '<span class="masked">••••••••</span>';
    return `<tr><td><span class="mono">${esc(e.key)}</span></td><td>${val}</td><td>${src}${over}</td></tr>`;
  }).join('');
  inUseEmpty.classList.toggle('hidden', (data.entries || []).length > 0);
}

// ---------- Dynamic layer editor (table mode over the saved
// overrides; keys are always editable because they are new) ----------
function dynRowHtml(key, value, isNew) {
  return `<td><input class="dyn-key" value="${esc(key)}" spellcheck="false" placeholder="KEY"></td>
    <td><input class="dyn-val" type="${envShowValues.checked ? 'text' : 'password'}" value="${esc(value)}" spellcheck="false"></td>
    <td><button type="button" class="env-del dyn-del">Remove</button></td>`;
}

function renderDynRows(entries) {
  dynRows.innerHTML = entries.map((e) => `<tr>${dynRowHtml(e.key, e.value, false)}</tr>`).join('');
}

function readDynRows() {
  const rows = [];
  dynRows.querySelectorAll('tr').forEach((tr) => {
    const key = tr.querySelector('.dyn-key').value.trim();
    const value = tr.querySelector('.dyn-val').value;
    if (key) rows.push({ key, value });
  });
  return rows;
}

async function saveDyn() {
  if (!envCtx) return;
  const text = readDynRows().map((r) => `${r.key}=${r.value}`).join('\n');
  dynMsg.textContent = 'Saving…';
  try {
    const res = await fetch(`/api/apps/${encodeURIComponent(envCtx.id)}/env/dynamic`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const parts = [];
    if ((data.added || []).length) parts.push(`added ${data.added.join(', ')}`);
    if ((data.changed || []).length) parts.push(`changed ${data.changed.join(', ')}`);
    if ((data.removed || []).length) parts.push(`removed ${data.removed.join(', ')}`);
    dynMsg.textContent = (parts.length ? `Saved (${parts.join('; ')}).` : 'Saved. No changes.')
      + ' Applies at the next deployment.';
  } catch (e) {
    dynMsg.innerHTML = `<span class="err">${esc(e.message)} — keys must look like KEY_NAME.</span>`;
  }
  refresh();
}

async function openEnv(id) {
  envMsg.textContent = '';
  dynMsg.textContent = '';
  envNote.textContent = 'Loading…';
  inUseMeta.textContent = 'Loading…';
  inUseRows.innerHTML = '';
  envCtx = { id, envFile: '.env', originalText: '', mode: 'table', inUse: null };
  envTitle.textContent = `Environment — ${id}`;
  envModal.classList.remove('hidden');
  const enc = encodeURIComponent(id);
  // The three layers load independently: one failing must not
  // blank the others.
  const [staticRes, dynRes, currentRes] = await Promise.allSettled([
    api(`/api/apps/${enc}/env`),
    api(`/api/apps/${enc}/env/dynamic`),
    api(`/api/apps/${enc}/env/current`),
  ]);
  if (staticRes.status === 'fulfilled') {
    const data = staticRes.value;
    envCtx.envFile = data.envFile || '.env';
    envCtx.originalText = data.text || '';
    envTitle.textContent = `Environment — ${id} (${envCtx.envFile})`;
    envNote.textContent = data.exists ? '' : 'File does not exist yet — saving will create it.';
    envRaw.value = data.text || '';
    renderEnvRows(data.entries || []);
    envCtx.mode = 'table';
    envTableWrap.classList.remove('hidden');
    envRaw.classList.add('hidden');
    envModeTableBtn.classList.add('active');
    envModeRawBtn.classList.remove('active');
  } else {
    envNote.textContent = '';
    envMsg.innerHTML = `<span class="err">Failed to load static layer: ${esc(staticRes.reason.message)}</span>`;
  }
  if (dynRes.status === 'fulfilled') {
    renderDynRows(dynRes.value.entries || []);
    if (!dynRes.value.exists) dynMsg.textContent = 'No dynamic overrides yet — they are optional.';
  } else {
    dynMsg.innerHTML = `<span class="err">Failed to load dynamic layer: ${esc(dynRes.reason.message)}</span>`;
  }
  renderInUse(currentRes.status === 'fulfilled' ? currentRes.value : null);
}

async function saveEnv(redeploy) {
  if (!envCtx) return;
  const text = envCurrentText();
  envMsg.textContent = 'Saving…';
  let data;
  try {
    const res = await fetch(`/api/apps/${encodeURIComponent(envCtx.id)}/env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (e) {
    envMsg.innerHTML = `<span class="err">${esc(e.message)} — every line must be KEY=VALUE, a # comment, or blank.</span>`;
    return;
  }
  envCtx.originalText = text;
  const parts = [];
  if ((data.added || []).length) parts.push(`added ${data.added.join(', ')}`);
  if ((data.changed || []).length) parts.push(`changed ${data.changed.join(', ')}`);
  if ((data.removed || []).length) parts.push(`removed ${data.removed.join(', ')}`);
  envMsg.textContent = parts.length ? `Saved (${parts.join('; ')}).` : 'Saved. No changes.';
  if (redeploy) {
    try {
      await api(`/api/apps/${encodeURIComponent(envCtx.id)}/redeploy`, { method: 'POST' });
      envMsg.textContent += ' Redeploy started.';
    } catch (e) {
      envMsg.innerHTML = `<span class="err">Saved, but redeploy failed to start: ${esc(e.message)}</span>`;
    }
  }
  refresh();
  // The redeploy (once it finishes) changes what is in use; reload
  // that section after a short delay so the panel stays truthful.
  if (redeploy && envCtx) {
    const ctx = envCtx;
    setTimeout(async () => {
      if (envCtx !== ctx) return;
      try {
        renderInUse(await api(`/api/apps/${encodeURIComponent(ctx.id)}/env/current`));
      } catch { /* keep the old view on failure */ }
    }, 3000);
  }
}

envRows.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.env-del');
  if (btn) btn.closest('tr').remove();
});
document.getElementById('envAddRow').addEventListener('click', () => {
  const tr = document.createElement('tr');
  tr.innerHTML = envRowHtml('', '', true);
  envRows.appendChild(tr);
  tr.querySelector('.env-key').focus();
});
envShowValues.addEventListener('change', () => {
  envRows.querySelectorAll('.env-val').forEach((input) => {
    input.type = envShowValues.checked ? 'text' : 'password';
  });
  dynRows.querySelectorAll('.dyn-val').forEach((input) => {
    input.type = envShowValues.checked ? 'text' : 'password';
  });
  if (envCtx) renderInUse(envCtx.inUse);
});
dynRows.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.dyn-del');
  if (btn) btn.closest('tr').remove();
});
document.getElementById('dynAddRow').addEventListener('click', () => {
  const tr = document.createElement('tr');
  tr.innerHTML = dynRowHtml('', '', true);
  dynRows.appendChild(tr);
  tr.querySelector('.dyn-key').focus();
});
document.getElementById('dynSave').addEventListener('click', saveDyn);
envModeTableBtn.addEventListener('click', () => setEnvMode('table'));
envModeRawBtn.addEventListener('click', () => setEnvMode('raw'));
document.getElementById('envSave').addEventListener('click', () => saveEnv(false));
document.getElementById('envSaveRedeploy').addEventListener('click', () => saveEnv(true));
document.getElementById('envClose').addEventListener('click', () => envModal.classList.add('hidden'));
envModal.addEventListener('click', (ev) => {
  if (ev.target === envModal) envModal.classList.add('hidden');
});

// ---------- Add Project (from GitHub / from a local folder) ----------
function formExtras(fd) {
  const body = {
    trigger: String(fd.get('trigger') || 'commit'),
    autoDeploy: fd.get('autoDeploy') === 'on',
  };
  const name = String(fd.get('name') || '').trim();
  if (name) body.name = name;
  const branch = String(fd.get('branch') || '').trim();
  if (branch) body.branch = branch;
  const port = String(fd.get('port') || '').trim();
  if (port) body.port = Number(port);
  const workflow = String(fd.get('workflow') || '').trim();
  if (workflow) body.workflow = workflow;
  return body;
}

// After a successful add, jump back to the Apps view where the new
// card is already visible.
async function submitAdd(body, msgEl, form, busyText) {
  msgEl.textContent = busyText;
  try {
    const data = await api('/api/apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    msgEl.textContent = data.warning
      ? `Added ${data.app.id} with a warning: ${data.warning}`
      : `Added ${data.app.id}.`;
    form.reset();
    location.hash = '#/apps';
  } catch (e) {
    msgEl.textContent = `Failed: ${e.message}`;
  }
  refresh();
}

const addForm = document.getElementById('addForm');
const addMsg = document.getElementById('addMsg');
addForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(addForm);
  const body = { ...formExtras(fd), repoUrl: String(fd.get('repoUrl') || '').trim() };
  submitAdd(body, addMsg, addForm, 'Cloning…');
});

const localForm = document.getElementById('localForm');
const localMsg = document.getElementById('localMsg');
localForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(localForm);
  const body = { ...formExtras(fd), source: 'local', path: String(fd.get('path') || '').trim() };
  submitAdd(body, localMsg, localForm, 'Registering…');
});

// ---------- Port detection for the local-folder form ----------
// The scan is advisory: it prefills the Port field with the main
// detected port, but only while the field is empty or still holds
// the value a previous scan put there — a value the user typed is
// never overwritten. Candidate chips can be clicked to pick a
// different detected port.
const portInput = localForm.querySelector('input[name="port"]');
const detectPortBtn = $('detectPortBtn');
const portCandidatesEl = $('portCandidates');
let portAutoValue = null; // last value the scan itself filled in

function renderPortScan(scan) {
  const chips = (scan.candidates || []).map((c) =>
    `<button type="button" class="port-cand" data-port="${esc(c.port)}" title="${esc(c.detail || '')}">${esc(c.port)} <span class="muted">· ${esc(c.source)}</span></button>`);
  let note = '';
  if (scan.aiUsed && scan.aiNote) {
    note = `<div class="muted">AI check: ${esc(scan.aiNote)}</div>`;
  } else if (!scan.aiConfigured) {
    note = '<div class="muted">Deterministic scan only — add LLM_API_KEY / LLM_MODEL to the manager\'s .env to enable the AI check.</div>';
  } else if (scan.aiNote) {
    note = `<div class="muted">${esc(scan.aiNote)}</div>`;
  }
  portCandidatesEl.innerHTML = (chips.length
    ? chips.join('')
    : '<span class="muted">No ports detected in this folder.</span>') + note;
  if (scan.primaryPort && (!portInput.value || portInput.value === String(portAutoValue))) {
    portInput.value = scan.primaryPort;
    portAutoValue = scan.primaryPort;
  }
}

async function scanLocalPort() {
  const p = localPathInput.value.trim();
  if (!p) {
    portCandidatesEl.innerHTML = '<span class="muted">Enter or pick a folder first.</span>';
    return;
  }
  portCandidatesEl.innerHTML = '<span class="muted">Scanning…</span>';
  try {
    const scan = await api('/api/apps/scan-port', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p }),
    });
    renderPortScan(scan);
  } catch (e) {
    portCandidatesEl.innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
}

detectPortBtn.addEventListener('click', scanLocalPort);
portCandidatesEl.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-port]');
  if (btn) {
    portInput.value = btn.dataset.port;
    portAutoValue = null; // an explicit pick is the user's value now
  }
});

// ---------- Folder browser (server-side directory picker) ----------
// A web page cannot open the OS file dialog, so the manager lists
// its OWN filesystem instead: the picker walks the directories the
// manager process can see, one level at a time. A folder that was
// never mounted into the manager container never appears — the
// same-path mount requirement becomes visible instead of an error.
// The probe line mirrors what registration would detect for the
// folder (git repo root? GitHub remote? compose file?).
const browseModal = $('browseModal');
const browseRootsEl = $('browseRoots');
const browsePathEl = $('browsePath');
const browseProbeEl = $('browseProbe');
const browseListEl = $('browseList');
const browseErrEl = $('browseErr');
const browseUpBtn = $('browseUp');
const localPathInput = localForm.querySelector('input[name="path"]');
const localNameInput = localForm.querySelector('input[name="name"]');
let browseState = null; // last /api/browse response

function renderBrowse() {
  if (!browseState) return;
  // Quick-jump chips from the server's roots list (filesystem root,
  // plus the configured projects root when there is one). A chip is
  // highlighted while the picker is at — or inside — that root.
  const roots = browseState.roots || [];
  browseRootsEl.innerHTML = roots.map((r) => {
    const active = browseState.path === r.path
      || (r.path !== '/' && browseState.path.startsWith(`${r.path}/`));
    return `<button type="button" class="browse-chip${active ? ' browse-chip-active' : ''}" data-root="${esc(r.path)}" title="${esc(r.path)}">${esc(r.label)}</button>`;
  }).join('');
  browsePathEl.textContent = browseState.path;
  browseUpBtn.disabled = !browseState.parent;
  const parts = [];
  if (browseState.isGitRepo) {
    parts.push(browseState.githubRepo
      ? `Git repository · GitHub: ${browseState.githubRepo}`
      : 'Git repository');
    if (browseState.branch) parts.push(`branch ${browseState.branch}`);
  } else {
    parts.push('Not a git repository');
  }
  parts.push(browseState.composeFile
    ? `${browseState.composeFile} found`
    : 'No compose file here');
  browseProbeEl.textContent = parts.join(' · ');
  browseListEl.innerHTML = (browseState.dirs || []).length
    ? browseState.dirs.map((d) =>
      `<button type="button" class="browse-item" data-dir="${esc(d.path)}"><span class="browse-icon">📁</span><span class="browse-name">${esc(d.name)}</span></button>`).join('')
    : '<div class="empty">No subfolders here.</div>';
}

async function browseTo(dir) {
  browseErrEl.textContent = '';
  try {
    const q = dir ? `?path=${encodeURIComponent(dir)}` : '';
    browseState = await api(`/api/browse${q}`);
    renderBrowse();
    return true;
  } catch (e) {
    browseErrEl.textContent = e.message;
    return false;
  }
}

async function openBrowse() {
  browseModal.classList.remove('hidden');
  browseState = null;
  browseRootsEl.innerHTML = '';
  browsePathEl.textContent = 'Loading…';
  browseProbeEl.textContent = '';
  browseListEl.innerHTML = '';
  browseErrEl.textContent = '';
  // Start where the user already typed (when it looks like an
  // absolute path); otherwise the server decides (its configured
  // projects root, else the filesystem root). If the typed folder
  // cannot be shown, retry at the server start and keep the error
  // visible.
  const typed = localPathInput.value.trim();
  const ok = await browseTo(typed.startsWith('/') ? typed : null);
  if (!ok && typed.startsWith('/')) browseTo(null);
}

$('browseBtn').addEventListener('click', openBrowse);
$('browseClose').addEventListener('click', () => browseModal.classList.add('hidden'));
browseModal.addEventListener('click', (ev) => {
  if (ev.target === browseModal) browseModal.classList.add('hidden');
});
browseListEl.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-dir]');
  if (btn) browseTo(btn.dataset.dir);
});
browseRootsEl.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-root]');
  if (btn) browseTo(btn.dataset.root);
});
browseUpBtn.addEventListener('click', () => {
  if (browseState && browseState.parent) browseTo(browseState.parent);
});
$('browseUse').addEventListener('click', () => {
  if (!browseState) return;
  localPathInput.value = browseState.path;
  // Prefill the name from the folder, unless the user typed one.
  if (!localNameInput.value.trim()) {
    const base = browseState.path.replace(/\/+$/, '').split('/').pop();
    if (base) localNameInput.value = base;
  }
  browseModal.classList.add('hidden');
  localMsg.textContent = '';
  scanLocalPort();
});
localPathInput.addEventListener('change', () => {
  if (localPathInput.value.trim().startsWith('/')) scanLocalPort();
});
