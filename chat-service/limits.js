/**
 * How much of the Mux this deployment offers: slots per project, panes, and
 * workspaces per repository. The `mux` key of the deployment's config, whose
 * defaults and bounds are scripts/mux-config.mjs; it reaches this service as
 * TRIPLEC_MUX_SLOTS, TRIPLEC_MUX_PANES and TRIPLEC_MUX_WORKSPACES (bootstrap.sh on
 * AWS, deploy/host/config.mjs on a host install).
 *
 * The bounds are repeated here rather than imported, because this directory is what
 * ships as the service and scripts/ is not always beside it. mux-test.js asserts the
 * two agree. A value out of range or not a number falls back to the default with a
 * line in the journal: the config's own validation is where a bad value is refused,
 * and a service that would not start over a slot count is worse than one with ten.
 */

export const DEFAULTS = { slots: 10, panes: 8, workspaces: 5 };
export const BOUNDS = { slots: [1, 32], panes: [1, 16], workspaces: [1, 20] };

const ENV = { slots: 'TRIPLEC_MUX_SLOTS', panes: 'TRIPLEC_MUX_PANES', workspaces: 'TRIPLEC_MUX_WORKSPACES' };

export function readLimits(env = process.env, log = console.warn) {
  const out = {};
  for (const [key, name] of Object.entries(ENV)) {
    const raw = env[name];
    const [lo, hi] = BOUNDS[key];
    if (raw === undefined || raw === '') {
      out[key] = DEFAULTS[key];
      continue;
    }
    const n = Number(raw);
    if (Number.isInteger(n) && n >= lo && n <= hi) {
      out[key] = n;
    } else {
      log(`${name}=${JSON.stringify(raw)} is not a whole number from ${lo} to ${hi}; using ${DEFAULTS[key]}`);
      out[key] = DEFAULTS[key];
    }
  }
  return out;
}

export const LIMITS = readLimits();

/** The Mux page's <meta name="limits">, filled in when the page is served. */
export function applyLimits(html, limits = LIMITS) {
  const value = `slots=${limits.slots} panes=${limits.panes} workspaces=${limits.workspaces}`;
  return html.replace(/(<meta name="limits" content=")([^"]*)(")/i, (_, before, _c, after) => `${before}${value}${after}`);
}
