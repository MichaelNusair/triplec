/**
 * The `mux` setting: how much of the Mux a deployment offers. Its defaults and its
 * rules, shared by both deployment types.
 *
 * Imported by infra/config.js (an AWS deployment's triplec.config.json) and by
 * deploy/host/config.mjs (a host install's config.json). The chat service reads the
 * resolved numbers from its environment (chat-service/limits.js), and
 * chat-service/mux-test.js checks that its bounds are these.
 *
 *   slots       worktree slots per project: <project>/.claude/worktrees/slot-1 … slot-N
 *   panes       panes in the Mux, shared between every window that shows it
 *   workspaces  full clones of one repository, counting the original
 *
 * Each is a ceiling, not a quota to fill: slots are made on first use and a
 * workspace only when asked for. Lowering one hides what is above it and deletes
 * nothing: a slot past the new count keeps its worktree, its branch and its work,
 * and comes back when the number goes up again.
 *
 * No dependencies and no filesystem: deploy/host/config.mjs runs before
 * `npm install`, on whatever node the developer had.
 */

export const MUX_DEFAULTS = { slots: 10, panes: 8, workspaces: 5 };

/** The range each may be set to. Above these a box runs out of memory, not features. */
export const MUX_LIMITS = {
  slots: [1, 32],
  panes: [1, 16],
  workspaces: [1, 20],
};

/**
 * What is wrong with a `mux` value, as [dotted key, message] pairs. Empty when it
 * is fine. An unknown key is an error, because a typo here is a limit that silently
 * stays at its default.
 */
export function muxErrors(mux, at = 'mux') {
  if (mux === undefined) return [];
  if (!mux || typeof mux !== 'object' || Array.isArray(mux)) return [[at, 'must be an object']];
  const errors = [];
  for (const key of Object.keys(mux)) {
    if (!(key in MUX_DEFAULTS)) {
      errors.push([`${at}.${key}`, `unknown key (known: ${Object.keys(MUX_DEFAULTS).join(', ')})`]);
    }
  }
  for (const [key, [lo, hi]] of Object.entries(MUX_LIMITS)) {
    if (mux[key] === undefined) continue;
    if (!Number.isInteger(mux[key]) || mux[key] < lo || mux[key] > hi) {
      errors.push([`${at}.${key}`, `must be a whole number from ${lo} to ${hi}. Got ${JSON.stringify(mux[key])}`]);
    }
  }
  return errors;
}

/** The config's value over the defaults. */
export function resolveMux(mux) {
  return { ...MUX_DEFAULTS, ...(mux && typeof mux === 'object' ? mux : {}) };
}
