// What the Codex buddy and the independent reviewer share: process liveness and the Codex options
// a model, a reasoning effort and the platform call for.

/** Whether a process ID names a live process; one another user owns is still live. */
export function alive(pid) {
  if (!/^\d+$/.test(pid)) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Codex options for a model and an effort from the environment, checked before use; `label`
 * names whose model it is in the error (buddy, review). On Windows,
 * Codex's elevated sandbox refuses every command since 0.162 ("setup refresh had errors", its
 * setups racing over the same ACLs); the unelevated sandbox runs them and still keeps Codex out of
 * everything else.
 */
export function codexOptions(model, effort, fail, label) {
  if (/[^a-zA-Z0-9._-]/.test(model)) fail(`Invalid ${label} model: ${model}`);
  if (/[^a-z]/.test(effort)) fail(`Invalid reasoning effort: ${effort}`);
  return [
    ...(model ? ['--model', model] : []),
    ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []),
    ...(process.platform === 'win32' ? ['-c', 'windows.sandbox="unelevated"'] : []),
  ];
}
