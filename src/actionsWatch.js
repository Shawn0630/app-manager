// GitHub Actions watching: refresh the latest completed run into the
// runtime store, and decide whether a new successful run should
// start a deployment.
//
// Trigger state machine (per app, persisted via appstate.js):
//  - The first completed run ever seen becomes the baseline
//    (lastActionRunId) WITHOUT triggering — the manager never fires
//    a deploy for history that predates its watch.
//  - After that, when the latest completed run is newer than the
//    baseline, has conclusion "success", and its headSha differs
//    from the local HEAD, it triggers exactly one deployment
//    (trigger "actions"). The run id is consumed BEFORE the deploy
//    starts, so the same run can never trigger twice — not on the
//    next tick, not after a restart, even if the deploy fails.
//  - If autoDeploy is off, run ids are still consumed, so turning it
//    on later does not fire stale runs.
//  - If the app is busy, nothing is consumed; the next tick retries.
import { fetchWorkflowRuns, latestCompletedRun } from './github.js';
import { getLastActionRunId, setLastActionRunId } from './appstate.js';
import { appState } from './store.js';
import { tailText } from './run.js';
import * as git from './git.js';
import { runOp, BusyError } from './ops.js';
import { getProvider } from './providers/index.js';

// Refresh the Actions cache for one app. Never throws.
export async function refreshRuns(app) {
  const st = appState(app.id);
  st.lastActionsAt = new Date().toISOString();
  try {
    const runs = await fetchWorkflowRuns(app);
    st.lastActionRun = latestCompletedRun(runs);
    st.lastActionsError = null;
    return st.lastActionRun;
  } catch (e) {
    st.lastActionsError = tailText(e.message || String(e), 3, 300);
    return null;
  }
}

// Evaluate the trigger state machine for one app (call after
// refreshRuns). Starts a deployment via the app lock when warranted.
export async function evaluateActionsTrigger(app) {
  const st = appState(app.id);
  const run = st.lastActionRun;
  if (!run || typeof run.id !== 'number') return;
  const consumed = getLastActionRunId(app.id);
  if (consumed === null) {
    setLastActionRunId(app.id, run.id);
    console.log(`[actions] ${app.id}: baseline run #${run.id} recorded (no deploy)`);
    return;
  }
  if (run.id <= consumed) return;
  if (run.conclusion !== 'success') return;
  if (!app.autoDeploy) {
    setLastActionRunId(app.id, run.id);
    return;
  }
  if (st.busy) return; // retry on the next tick
  const local = await git.headOrNull(app.workdir);
  if (local && run.headSha && local.head === run.headSha) {
    setLastActionRunId(app.id, run.id); // already at that commit
    return;
  }
  setLastActionRunId(app.id, run.id); // consume before deploying: fire exactly once
  const provider = getProvider(app.provider);
  try {
    runOp(app, 'update', () => provider.deploy(app, 'actions', {
      workflowRunId: run.id,
      targetSha: run.headSha,
    }));
    console.log(`[actions] ${app.id}: run #${run.id} (${run.workflowName}) succeeded at ${run.headSha ? run.headSha.slice(0, 7) : '?'}, deploy started`);
  } catch (e) {
    if (!(e instanceof BusyError)) throw e;
  }
}
