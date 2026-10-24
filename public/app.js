// App Manager dashboard. Plain fetch + innerHTML rendering, no framework.
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
  const portLink = a.port
    ? `<a href="http://${esc(location.hostname)}:${a.port}" target="_blank" rel="noopener">${a.port}</a>`
    : '—';
  const commitLine = a.commit
    ? `<span class="hash">${esc(a.commit.short)}</span> <span class="subject">${esc(a.commit.subject || '')}</span>`
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
      ${a.autoDeploy ? '<span class="badge auto no-dot">auto-deploy on</span>' : '<span class="badge no-dot">auto-deploy off</span>'}
      ${a.trigger && a.trigger !== 'commit' ? `<span class="badge no-dot">trigger: ${esc(a.trigger)}</span>` : ''}
      <span class="checked">checked ${esc(fmtClock(a.statusCheckedAt))}</span>
    </div>
    ${a.warning ? `<div class="alert warn">⚠ ${esc(a.warning)}</div>` : ''}
    ${a.statusError ? `<div class="alert error">Status check failed: ${esc(a.statusError)}</div>` : ''}
    ${busy ? `<div class="busy-note"><span class="spinner"></span>Working: ${esc(busy)}…</div>` : ''}
    <div class="rows">
      <div class="row"><span class="k">Port</span><span class="v">${portLink}</span></div>
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

function historyRow(d) {
  const when = esc(fmtTime(d.ts));
  if (d.kind === 'action') {
    const badge = d.result === 'success'
      ? '<span class="badge ok no-dot">success</span>'
      : '<span class="badge fail no-dot">failed</span>';
    return `
    <div class="hist-row kind-action">
      <span class="when">${when}</span> · <span class="app-name">${esc(d.appId)}</span>
      <span class="badge kind-action no-dot">Action</span> <b>${esc(d.action)}</b> · ${badge} · ${esc(fmtDuration(d.durationMs))}
      ${d.output ? `<details><summary>Output</summary><pre class="output">${esc(d.output)}</pre></details>` : ''}
    </div>`;
  }
  if (d.kind === 'env') {
    const parts = [];
    if ((d.added || []).length) parts.push(`added: ${d.added.map(esc).join(', ')}`);
    if ((d.changed || []).length) parts.push(`changed: ${d.changed.map(esc).join(', ')}`);
    if ((d.removed || []).length) parts.push(`removed: ${d.removed.map(esc).join(', ')}`);
    const result = d.result
      ? ` · ${d.result === 'success'
        ? '<span class="badge ok no-dot">success</span>'
        : '<span class="badge fail no-dot">failed</span>'}`
      : '';
    const what = d.trigger === 'manual-env' ? 'redeployed after environment update' : 'environment updated';
    return `
    <div class="hist-row kind-env">
      <span class="when">${when}</span> · <span class="app-name">${esc(d.appId)}</span>
      <span class="badge kind-env no-dot">Env</span> ${what}${result}
      ${parts.length ? ` · ${parts.join(' · ')}` : ''}
    </div>`;
  }
  const badge = d.result === 'success'
    ? '<span class="badge ok no-dot">success</span>'
    : '<span class="badge fail no-dot">failed</span>';
  const runRef = d.workflowRunId != null ? ` · run #${esc(String(d.workflowRunId))}` : '';
  const note = d.note ? `<div class="note">${esc(d.note)}</div>` : '';
  const steps = (d.steps || []).map((s) => `
    <div class="step">
      <span class="badge ${s.ok ? 'ok' : 'fail'} no-dot">${s.ok ? 'ok' : `failed (exit ${s.code == null ? '?' : s.code})`}</span>
      <b>${esc(s.name)}</b> <span class="note">${esc(fmtDuration(s.durationMs))}</span>
      ${s.output ? `<pre>${esc(s.output)}</pre>` : ''}
    </div>`).join('');
  return `
  <div class="hist-row kind-deploy">
    <span class="when">${when}</span> · <span class="app-name">${esc(d.appId)}</span>
    <span class="badge kind-deploy no-dot">Deploy</span> ${esc(triggerLabel(d.trigger))}${runRef} · ${badge}
    · <span class="hash">${esc(shortHash(d.fromCommit))} → ${esc(shortHash(d.toCommit))}</span>
    · ${esc(fmtDuration(d.durationMs))}
    ${note}
    ${steps ? `<details><summary>Steps (${d.steps.length})</summary>${steps}</details>` : ''}
  </div>`;
}

function renderHistory(deployments) {
  historyEl.innerHTML = deployments.length
    ? `<div class="hist-list">${deployments.map(historyRow).join('')}</div>`
    : '<div class="empty">No activity yet.</div>';
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
    const [appsRes, depsRes] = await Promise.allSettled([
      api('/api/apps'),
      api('/api/deployments?limit=30'),
    ]);
    let anyBusy = false;
    if (appsRes.status === 'fulfilled') {
      const apps = appsRes.value.apps || [];
      anyBusy = apps.some((a) => a.busy);
      renderSummary(apps);
      renderApps(apps);
    }
    if (depsRes.status === 'fulfilled') {
      renderHistory(depsRes.value.deployments || []);
    }
    if (appsRes.status === 'fulfilled' || depsRes.status === 'fulfilled') {
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
let envCtx = null; // { id, envFile, originalText, mode }

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

async function openEnv(id) {
  envMsg.textContent = '';
  envNote.textContent = 'Loading…';
  envCtx = { id, envFile: '.env', originalText: '', mode: 'table' };
  envTitle.textContent = `Environment — ${id}`;
  envModal.classList.remove('hidden');
  try {
    const data = await api(`/api/apps/${encodeURIComponent(id)}/env`);
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
  } catch (e) {
    envNote.textContent = '';
    envMsg.innerHTML = `<span class="err">Failed to load: ${esc(e.message)}</span>`;
  }
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
});
envModeTableBtn.addEventListener('click', () => setEnvMode('table'));
envModeRawBtn.addEventListener('click', () => setEnvMode('raw'));
document.getElementById('envSave').addEventListener('click', () => saveEnv(false));
document.getElementById('envSaveRedeploy').addEventListener('click', () => saveEnv(true));
document.getElementById('envClose').addEventListener('click', () => envModal.classList.add('hidden'));
envModal.addEventListener('click', (ev) => {
  if (ev.target === envModal) envModal.classList.add('hidden');
});

// ---------- Add App ----------
const addForm = document.getElementById('addForm');
const addMsg = document.getElementById('addMsg');
addForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(addForm);
  const body = {
    repoUrl: String(fd.get('repoUrl') || '').trim(),
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
  addMsg.textContent = 'Cloning…';
  try {
    const data = await api('/api/apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    addMsg.textContent = data.warning
      ? `Added ${data.app.id} with a warning: ${data.warning}`
      : `Added ${data.app.id}.`;
    if (!data.warning) addForm.reset();
  } catch (e) {
    addMsg.textContent = `Failed: ${e.message}`;
  }
  refresh();
});
