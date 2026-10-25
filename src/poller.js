// Per-app polling. Each tick depends on the app's trigger mode:
//   commit / both — ls-remote into the remote HEAD cache; with
//                   autoDeploy on and a moved remote, run a deploy
//                   (trigger "poll").
//   actions / both — refresh the latest GitHub Actions run and let
//                   the trigger state machine decide (see
//                   actionsWatch.js).
//   manual        — ticks do nothing; state moves only via the API.
// Poll failures are recorded on the app state (lastPollError /
// lastActionsError), never thrown.
import { getProvider } from './providers/index.js';
import { appState } from './store.js';
import { runOp, BusyError } from './ops.js';
import { refreshRuns, evaluateActionsTrigger } from './actionsWatch.js';
import { hasGitHubRemote } from './github.js';
import * as git from './git.js';

const watchers = new Map(); // appId -> { timers: [...] }

async function tick(app) {
  const st = appState(app.id);
  const trigger = app.trigger || 'commit';
  const provider = getProvider(app.provider);

  // Nothing to watch without a remote: a local folder with no
  // repoUrl can only be driven manually. (Actions additionally
  // requires the remote to be a GitHub URL; commit polling works
  // with any remote, including a local folder whose origin is
  // GitHub.)
  if (!app.repoUrl) return;

  if (trigger === 'commit' || trigger === 'both') {
    await provider.checkRemote(app);
    if (app.autoDeploy && !st.busy && st.remoteHead) {
      const local = await git.headOrNull(app.workdir);
      if (local && local.head !== st.remoteHead) {
        try {
          runOp(app, 'update', () => provider.deploy(app, 'poll'));
          console.log(`[poll] ${app.id}: new commit ${st.remoteHead.slice(0, 7)}, auto-deploy started`);
        } catch (e) {
          if (!(e instanceof BusyError)) throw e;
        }
      }
    }
  }
  if ((trigger === 'actions' || trigger === 'both') && hasGitHubRemote(app)) {
    await refreshRuns(app);
    await evaluateActionsTrigger(app);
  }
}

export function watchApp(app) {
  if (watchers.has(app.id)) return;
  const entry = { timers: [] };
  watchers.set(app.id, entry);
  const safeTick = () => tick(app).catch((e) => console.error('[poll]', app.id, e && e.message ? e.message : e));
  // First check shortly after startup so the dashboard has remote
  // info without waiting a full interval.
  const first = setTimeout(safeTick, 1000);
  first.unref?.();
  const timer = setInterval(safeTick, app.pollIntervalSec * 1000);
  timer.unref?.();
  entry.timers.push(first, timer);
}

export function unwatchApp(appId) {
  const entry = watchers.get(appId);
  if (!entry) return;
  for (const t of entry.timers) {
    clearTimeout(t);
    clearInterval(t);
  }
  watchers.delete(appId);
}

export function startPollers(apps) {
  for (const app of apps) watchApp(app);
}

export function stopPollers() {
  for (const id of [...watchers.keys()]) unwatchApp(id);
}
