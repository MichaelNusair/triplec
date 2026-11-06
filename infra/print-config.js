#!/usr/bin/env node
/**
 * Print the validated configuration as shell assignments, for `eval` in
 * deploy.sh and migrate.sh.
 *
 * Exists so the shell scripts never parse triplec.config.json themselves.
 * Two parsers for one file drift, and the one in a shell script would skip the
 * validation in config.js — which is where the useful error messages live.
 *
 * On invalid config it prints a shell snippet that reports the error and exits
 * non-zero, so `eval "$(node infra/print-config.js)"` fails loudly.
 */
import { loadConfig, requiredPwaIcons } from './config.js';
import { PROXY_PATH } from './landing-analytics.js';

/** Single-quote for the shell, escaping embedded single quotes safely. */
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

let config;
try {
  config = loadConfig();
} catch (err) {
  process.stdout.write(`printf '%s\\n' ${shellQuote(err.message)} >&2\nexit 1\n`);
  process.exit(0);
}

// `--json`: the whole resolved config, for the payload. scripts/build-payload.sh
// ships it to the box so the on-box updater can build the next payload with the
// configuration this one was built with, defaults and environment overrides
// already applied.
if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  process.exit(0);
}

const exported = {
  CFG_DOMAIN: config.domainName,
  CFG_REGION: config.region,
  CFG_PROFILE: config.awsProfile,
  CFG_STACK: config.stackName,
  CFG_AUTH_MODE: config.authMode,
  // Empty in password mode. Exported so the deploy summary can name the provider
  // it just put in front of the app, rather than telling you to sign in with a
  // password that no longer gates the chat.
  CFG_OIDC_ISSUER: config.oidc?.issuer ?? '',
  CFG_PERMISSION_MODE: config.permissionMode,
  CFG_ADMIN: config.instanceAdminAccess,
  CFG_INSTANCE_TYPE: config.instanceType,
  CFG_LANDING_DOMAIN: config.landing.domainName,
  CFG_LANDING_STACK: config.landing.stackName,
  // The landing page's PostHog project key, which is public by design — it ships
  // in the page's JavaScript. Exported so deploy-landing.sh can check that the
  // copy it is about to upload actually carries it, rather than the placeholder.
  CFG_LANDING_PH_KEY: config.landing.analytics.posthogKey,
  // And the path the distribution proxies PostHog under, so the shell verifies
  // the same path CloudFront was configured with rather than a second copy of it.
  CFG_LANDING_PH_PATH: PROXY_PATH,
  CFG_SECURITY_ENABLED: config.security.enabled,
  CFG_SECURITY_STACK: config.security.stackName,
  CFG_SECURITY_CLOUDTRAIL: config.security.cloudTrail,
  CFG_SECURITY_GUARDDUTY: config.security.guardDuty,
  // What this deployment calls itself, in front of every title the app shows.
  // Exported so the deploy says which deployment it is shipping — with two of them
  // in one account, the hostname is the only other thing that distinguishes the
  // output. It reaches the box through UserData (see stack.js), not the payload, so
  // --app-only cannot change it.
  CFG_PWA_NAME: config.pwa.name,
  // Which icon set this deployment installs on a home screen, and the files it
  // owes — both exported so deploy.sh copies a named list rather than a glob, and
  // the list lives only in pwa/manifest.webmanifest. loadConfig has already
  // checked they are all there.
  CFG_PWA_ICON_DIR: config.pwa.iconDir,
  CFG_PWA_ICON_FILES: requiredPwaIcons().join(' '),
  // How this deployment takes updates, so the deploy summary can say so.
  CFG_AUTO_UPDATE: config.autoUpdate.mode,
  CFG_DEPLOY_INSTANCE: config.deployFrom.instanceId,
  CFG_DEPLOY_PATH: config.deployFrom.repoPath,
  CFG_DEPLOY_USER: config.deployFrom.user,
};

for (const [key, value] of Object.entries(exported)) {
  process.stdout.write(`${key}=${shellQuote(value)}\n`);
}
