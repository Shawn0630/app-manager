// Assemble the per-app status object served by GET /api/apps.
import { composePs } from './docker.js';
import * as git from './git.js';
import { lastDeploymentFor } from './deployments.js';
import { appState } from './store.js';

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
  return {
    id: app.id,
    name: app.name,
    repoUrl: app.repoUrl,
    branch: app.branch,
    workdir: app.workdir,
    port: app.port,
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
