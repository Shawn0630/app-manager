// Assemble the per-app status object served by GET /api/apps.
import { composePs } from './docker.js';
import * as git from './git.js';
import { lastDeploymentFor } from './deployments.js';
import { appState } from './store.js';

// The port story has two sources: the port registered for the
// app (app.port, from Add Project / config) and the port the app
// actually publishes at runtime (compose ps Publishers, decided by
// the app's own compose file and .env). While a container is
// running, the ACTUAL published port is the truth — the registered
// value is only the expected port, shown when nothing is running
// (or ps failed). portMismatch flags a stale registration so the
// dashboard can say so instead of linking to a dead port.
export function effectivePortOf(app, containers) {
  let actual = null;
  for (const c of containers || []) {
    if (!c || c.state !== 'running') continue;
    const pub = (c.ports || []).find((p) => p && p.published);
    if (pub) {
      actual = Number(pub.published);
      break;
    }
  }
  const registered = app.port != null && app.port !== '' ? Number(app.port) : null;
  if (actual != null) {
    return {
      effectivePort: actual,
      portSource: 'actual',
      portMismatch: registered != null && registered !== actual,
    };
  }
  if (registered != null) {
    return { effectivePort: registered, portSource: 'configured', portMismatch: false };
  }
  return { effectivePort: null, portSource: null, portMismatch: false };
}

export async function appStatus(app) {
  const st = appState(app.id);
  const [ps, localResult] = await Promise.all([
    composePs(app),
    git.localHead(app.workdir).then(
      (v) => ({ ok: true, v }),
      (e) => ({ ok: false, error: e.message }),
    ),
  ]);
  const commit = localResult.ok
    ? {
        head: localResult.v.head,
        short: localResult.v.short,
        time: localResult.v.time,
        subject: localResult.v.subject,
      }
    : null;
  const behind = Boolean(st.remoteHead && commit && st.remoteHead !== commit.head);
  const { effectivePort, portSource, portMismatch } = effectivePortOf(app, ps.containers);
  return {
    id: app.id,
    name: app.name,
    source: app.source,
    repoUrl: app.repoUrl,
    branch: app.branch,
    workdir: app.workdir,
    port: app.port,
    // Effective port (actual published port while running, else
    // the registered one), where it came from, and whether the
    // registration disagrees with reality. See effectivePortOf.
    effectivePort,
    portSource,
    portMismatch,
    envFile: app.envFile,
    autoDeploy: app.autoDeploy,
    pollIntervalSec: app.pollIntervalSec,
    provider: app.provider,
    trigger: app.trigger,
    workflow: app.workflow || null,
    warning: app.warning || null,
    state: ps.state,
    containers: ps.containers,
    // The most recent status-collection problem for this app (docker
    // compose ps failing), or null when the last check succeeded.
    // dockerError is kept as a backwards-compatible alias.
    statusError: ps.error,
    dockerError: ps.error,
    statusCheckedAt: ps.checkedAt,
    commit,
    commitError: localResult.ok ? null : localResult.error,
    remote: st.remoteHead ? { head: st.remoteHead, short: st.remoteHead.slice(0, 7) } : null,
    behind,
    lastDeployment: lastDeploymentFor(app.id),
    busy: st.busy,
    lastPollAt: st.lastPollAt,
    lastPollError: st.lastPollError,
    lastActionRun: st.lastActionRun,
    lastActionsAt: st.lastActionsAt,
    lastActionsError: st.lastActionsError,
  };
}
