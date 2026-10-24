// Dashboard logic: fetch status, render app cards + deployment
// history, wire the action buttons. Plain JS + fetch, no framework.
const appsEl = document.getElementById('apps');
const historyEl = document.getElementById('history');
const updatedEl = document.getElementById('updated');
const logModal = document.getElementById('logModal');
const logTitle = document.getElementById('logTitle');
const logBody = document.getElementById('logBody');

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

function deploymentLine(dep) {
  if (!dep) return '<span class="k">Last deploy</span> never';
  const badge = dep.result === 'success'
    ? '<span class="badge ok">success</span>'
    : '<span class="badge fail">failed</span>';
  const trigger = triggerLabel(dep.trigger);
  return `<span class="k">Last deploy</span> ${esc(fmtTime(dep.ts))} · ${esc(trigger)} · ${badge} · ${esc(fmtDuration(dep.durationMs))}`;
}

function remoteLine(a) {
  if (a.lastPollError && !a.remote) {
    return `<span class="k">Remote</span> <span class="err">check failed: ${esc(a.lastPollError)}</span>`;
  }
  if (!a.remote) return '<span class="k">Remote</span> not checked yet';
  if (a.behind) {
    return `<span class="k">Remote</span> <span class="badge update">update available ${esc(a.remote.short)}</span>`;
  }
  return `<span class="k">Remote</span> up to date (${esc(a.remote.short)})`;
}

function containersLine(a) {
  if (!a.containers || !a.containers.length) return '';
  const items = a.containers.map((c) => {
    const ports = (c.ports || []).map((p) => `${p.published}->${p.target}/${p.protocol}`).join(', ');
    const health = c.health ? ` · health: ${esc(c.health)}` : '';
    return `${esc(c.name)} — ${esc(c.state)}${health}${ports ? ` · ${esc(ports)}` : ''}`;
  });
  return `<div class="containers">${items.join('<br>')}</div>`;
}

function actionsLine(a) {
  if (a.trigger !== 'actions' && a.trigger !== 'both') return '';
  if (a.lastActionsError) {
    return `<div><span class="k">Actions</span> <span class="err">check failed: ${esc(a.lastActionsError)}</span></div>`;
  }
  const r = a.lastActionRun;
  if (!r) return '<div><span class="k">Actions</span> no completed runs seen yet</div>';
  const label = `${r.workflowName} · ${r.conclusion || r.status} · ${fmtTime(r.updatedAt)}`;
  const link = r.htmlUrl
    ? `<a href="${esc(r.htmlUrl)}" target="_blank" rel="noopener">${esc(label)}</a>`
    : esc(label);
  return `<div><span class="k">Actions</span> ${link}</div>`;
}

function cardHtml(a) {
  const busy = a.busy ? a.busy.op : null;
  const disabled = busy ? 'disabled' : '';
  const portLink = a.port
    ? `<a href="http://${esc(location.hostname)}:${a.port}" target="_blank" rel="noopener">${a.port}</a>`
    : '—';
  const commitLine = a.commit
    ? `<span class="mono">${esc(a.commit.short)}</span> ${esc(a.commit.subject || '')}`
    : `<span class="err">${esc(a.commitError || 'unavailable')}</span>`;
  const buttons = [
    ['start', 'Start'],
    ['stop', 'Stop'],
    ['restart', 'Restart'],
    ['update', 'Update'],
    ['logs', 'Logs'],
    ['env', 'Environment'],
    ['check', 'Check now'],
    ['remove', 'Remove'],
  ].map(([action, label]) => {
    const cls = action === 'update' ? ' class="primary"' : '';
    return `<button type="button"${cls} data-action="${action}" data-id="${esc(a.id)}" ${disabled}>${label}</button>`;
  }).join('');
  return `
  <div class="card">
    <div class="card-head">
      <span class="dot ${esc(a.state)}"></span>
      <span class="name">${esc(a.name)}</span>
      <span class="badge">${esc(STATE_LABEL[a.state] || a.state)}</span>
      ${a.autoDeploy ? '<span class="badge auto">auto-deploy on</span>' : '<span class="badge">auto-deploy off</span>'}
      ${a.trigger && a.trigger !== 'commit' ? `<span class="badge">trigger: ${esc(a.trigger)}</span>` : ''}
    </div>
    ${a.warning ? `<div class="warn">⚠ ${esc(a.warning)}</div>` : ''}
    <div class="rows">
      <div><span class="k">Port</span> ${portLink}</div>
      <div><span class="k">Commit</span> ${commitLine}</div>
      <div>${remoteLine(a)}</div>
      ${actionsLine(a)}
      <div>${deploymentLine(a.lastDeployment)}</div>
      ${a.dockerError ? `<div class="err">docker: ${esc(a.dockerError)}</div>` : ''}
      ${busy ? `<div class="busy-note">Working: ${esc(busy)}…</div>` : ''}
    </div>
    ${containersLine(a)}
    <div class="buttons">${buttons}</div>
  </div>`;
}

function triggerLabel(trigger) {
  if (trigger === 'poll') return 'auto (commit)';
  if (trigger === 'actions') return 'GitHub Actions';
  if (trigger === 'manual-env') return 'manual (env)';
  return 'manual';
}

function historyHtml(deployments) {
  if (!deployments.length) return '<div class="empty">No deployments yet.</div>';
  return deployments.map((d) => {
    if (d.kind === 'env') {
      const parts = [];
      if ((d.added || []).length) parts.push(`added: ${d.added.map(esc).join(', ')}`);
      if ((d.changed || []).length) parts.push(`changed: ${d.changed.map(esc).join(', ')}`);
      if ((d.removed || []).length) parts.push(`removed: ${d.removed.map(esc).join(', ')}`);
      return `
    <div class="hist-row">
      <span class="mono">${esc(fmtTime(d.ts))}</span> · <b>${esc(d.appId)}</b> · environment updated
      · ${parts.length ? parts.join(' · ') : 'no changes'}
    </div>`;
    }
    const badge = d.result === 'success'
      ? '<span class="badge ok">success</span>'
      : '<span class="badge fail">failed</span>';
    const trigger = triggerLabel(d.trigger);
    const runRef = d.workflowRunId != null ? ` · run #${esc(String(d.workflowRunId))}` : '';
    const note = d.note ? `<div class="note">${esc(d.note)}</div>` : '';
    const steps = (d.steps || []).map((s) => `
      <div class="step">
        <span class="mono">${esc(s.name)}</span> — ${s.ok ? 'ok' : `failed (exit ${s.code == null ? '?' : s.code})`}
        ${s.output ? `<pre>${esc(s.output)}</pre>` : ''}
      </div>`).join('');
    return `
    <div class="hist-row">
      <span class="mono">${esc(fmtTime(d.ts))}</span> · <b>${esc(d.appId)}</b> · ${esc(trigger)}${runRef} · ${badge}
      · <span class="mono">${esc(shortHash(d.fromCommit))} → ${esc(shortHash(d.toCommit))}</span>
      · ${esc(fmtDuration(d.durationMs))}
      ${note}
      ${steps ? `<details><summary>Steps (${d.steps.length})</summary>${steps}</details>` : ''}
    </div>`;
  }).join('');
}

async function refresh() {
  try {
    const [{ apps }, { deployments }] = await Promise.all([
      api('/api/apps'),
      api('/api/deployments?limit=20'),
    ]);
    appsEl.innerHTML = apps.length
      ? apps.map(cardHtml).join('')
      : '<div class="empty">No apps configured.</div>';
    historyEl.innerHTML = historyHtml(deployments);
    updatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    updatedEl.textContent = `Refresh failed: ${e.message}`;
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
    logTitle.textContent = `Logs — ${id}`;
    logBody.textContent = 'Loading…';
    logModal.classList.remove('hidden');
    try {
      const { logs } = await api(`/api/apps/${encodeURIComponent(id)}/logs?tail=200`);
      logBody.textContent = logs || '(no logs)';
    } catch (e) {
      logBody.textContent = `Failed to load logs: ${e.message}`;
    }
    return;
  }
  try {
    await api(`/api/apps/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
  } catch (e) {
    alert(e.message);
  }
  setTimeout(refresh, 600);
}

appsEl.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-action]');
  if (!btn || btn.disabled) return;
  doAction(btn.dataset.id, btn.dataset.action);
});
document.getElementById('refreshBtn').addEventListener('click', refresh);
document.getElementById('logClose').addEventListener('click', () => logModal.classList.add('hidden'));
logModal.addEventListener('click', (ev) => {
  if (ev.target === logModal) logModal.classList.add('hidden');
});

refresh();
setInterval(refresh, 10_000);

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
