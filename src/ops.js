// One mutex per app: only one operation per app runs at a time.
// Long operations run in the background — runOp returns immediately,
// the HTTP layer does not wait; progress shows up via the store's
// busy field and via deployment records.
import { appState } from './store.js';

export class BusyError extends Error {
  constructor(app, op) {
    super(`app ${app.id} is busy running ${op}, try again later`);
    this.code = 'BUSY';
    this.op = op;
  }
}

// If the app is idle: mark it busy and run fn in the background,
// return true. If busy: throw BusyError.
export function runOp(app, opName, fn) {
  const st = appState(app.id);
  if (st.busy) throw new BusyError(app, st.busy.op);
  st.busy = { op: opName, since: new Date().toISOString() };
  (async () => {
    try {
      await fn();
    } catch (e) {
      // Background operation errors are not rethrown: deploy-type
      // operations persist their own records; this catch-all just
      // keeps an unhandled rejection from killing the process.
      console.error(`[op ${opName}] ${app.id}:`, e && e.message ? e.message : e);
    } finally {
      st.busy = null;
    }
  })();
  return true;
}

export function isBusy(app) {
  return Boolean(appState(app.id).busy);
}
