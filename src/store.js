// Per-app runtime state (not persisted): remote HEAD cache, poll info,
// and the operation currently running.
const states = new Map();

export function appState(id) {
  if (!states.has(id)) {
    states.set(id, {
      remoteHead: null, // latest remote HEAD seen by ls-remote (full hash)
      lastPollAt: null, // ISO timestamp
      lastPollError: null, // most recent poll failure message
      lastActionRun: null, // latest completed GitHub Actions run seen
      lastActionsAt: null, // ISO timestamp of the last Actions poll
      lastActionsError: null, // most recent Actions poll failure message
      busy: null, // { op, since } | null — an operation is running
    });
  }
  return states.get(id);
}
