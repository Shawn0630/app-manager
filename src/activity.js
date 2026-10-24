// Activity feed presentation: turn a raw journal record
// (data/deployments.jsonl) into a small set of display tags, so the
// dashboard can render chips instead of a cryptic one-liner.
//
// Tag groups, in order:
//   kind      Deploy / Action / Env            (what sort of record)
//   action    Update / Redeploy / Start / Stop / Restart /
//             Static env save / Dynamic env save / Env save
//   trigger   Manual / Auto · Commit / GitHub Actions
//   result    Success / Failed                 (when the record has one)
//   failedStep  "failed at: <step name>"       (failed deploys only)
//
// Old records degrade gracefully: missing layer/result fields just
// produce fewer (or plainer) tags, never an error.

// First failed step name of a deployment record, or null.
export function failedStepOf(record) {
  if (!record || record.kind !== 'deploy' || record.result !== 'failed') return null;
  const step = (record.steps || []).find((s) => s && !s.ok);
  return step ? step.name : null;
}

function capitalize(s) {
  const t = String(s || '');
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

export function tagsForRecord(record) {
  const d = record || {};
  const kind = d.kind || 'deploy';
  const tags = [];

  if (kind === 'deploy') tags.push({ type: 'kind', label: 'Deploy', cls: 'kind-deploy' });
  else if (kind === 'action') tags.push({ type: 'kind', label: 'Action', cls: 'kind-action' });
  else if (kind === 'env') tags.push({ type: 'kind', label: 'Env', cls: 'kind-env' });
  else tags.push({ type: 'kind', label: capitalize(kind), cls: 'kind-action' });

  let actionLabel = null;
  if (kind === 'action') actionLabel = capitalize(d.action || 'action');
  else if (kind === 'deploy') actionLabel = d.trigger === 'manual-env' ? 'Redeploy' : 'Update';
  else if (kind === 'env') {
    actionLabel = d.layer === 'dynamic'
      ? 'Dynamic env save'
      : d.layer === 'static'
        ? 'Static env save'
        : 'Env save';
  }
  if (actionLabel) tags.push({ type: 'action', label: actionLabel, cls: 'tag-action' });

  const trigger = d.trigger || 'manual';
  if (trigger === 'poll') tags.push({ type: 'trigger', label: 'Auto · Commit', cls: 'trig-auto' });
  else if (trigger === 'actions') tags.push({ type: 'trigger', label: 'GitHub Actions', cls: 'trig-actions' });
  else if (trigger === 'manual' || trigger === 'manual-env') tags.push({ type: 'trigger', label: 'Manual', cls: 'trig-manual' });
  else tags.push({ type: 'trigger', label: String(trigger), cls: 'trig-manual' });

  if (d.result === 'success') tags.push({ type: 'result', label: 'Success', cls: 'ok' });
  else if (d.result === 'failed') tags.push({ type: 'result', label: 'Failed', cls: 'fail' });

  const failedStep = failedStepOf(d);
  if (failedStep) tags.push({ type: 'failedStep', label: `failed at: ${failedStep}`, cls: 'fail-step' });

  return tags;
}
