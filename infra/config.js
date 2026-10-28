/**
 * Deployment configuration.
 *
 * Everything that used to be a constant in stack.js — domain, hosted zone,
 * certificate ARN, AWS profile, git identity — lives here and comes from a
 * config file or the environment. The stack no longer contains anyone's account
 * id, so the repository can be published and deployed by anyone.
 *
 * Precedence: environment variable > triplec.config.json > default.
 * Environment wins so CI can override a single value without editing a file.
 *
 * Validation is deliberately loud and specific. Someone deploying this for the
 * first time is one typo away from a CloudFormation error that names a resource
 * rather than the setting that was wrong, and an AI agent helping them needs the
 * message to say what to fix.
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

/**
 * The config file, under the current name and the one this project used to have.
 *
 * Both are honoured, and that is not tidiness — it is the difference between a
 * rename and an outage. A deployment's config file is gitignored, so it lives only
 * on the machines that deploy: the operator's checkout and whatever box is named in
 * `deployFrom`. A rename in this repository cannot reach either of them, so if this
 * function only knew the new name, the next deploy would find no config, fall back
 * to defaults, and either refuse on a missing domain or — far worse — synthesize a
 * *differently named stack* and start building a second copy of production
 * alongside the first.
 *
 * So: new deployments are told to use `triplec.config.json`, existing ones keep
 * working untouched, and nobody has to be told to go and rename a file.
 */
const CONFIG_NAMES = ['triplec.config.json', 'claude-web.config.json'];

/**
 * Resolved per call rather than once at import, so the path is read from the
 * environment as it is when the config is actually loaded — which is what makes
 * this testable and lets a caller point at an alternate file.
 *
 * `TRIPLEC_CONFIG` is the name to use; `CLAUDE_WEB_CONFIG` is still read because a
 * second deployment is selected with it (see "More than one deployment" in
 * docs/DEPLOY.md) and those invocations live in people's shell history, not here.
 */
export function configPath() {
  const fromEnv = process.env.TRIPLEC_CONFIG || process.env.CLAUDE_WEB_CONFIG;
  if (fromEnv) return fromEnv;
  const found = CONFIG_NAMES.map((name) => join(REPO_ROOT, name)).find((path) => existsSync(path));
  // Nothing on disk: return the current name, so the "no config" message names the
  // file someone should be creating rather than the one they should not.
  return found || join(REPO_ROOT, CONFIG_NAMES[0]);
}

const DEFAULTS = {
  // --- Required ------------------------------------------------------------
  /** Fully-qualified hostname the app is served at, e.g. "claude.example.com". */
  domainName: '',
  /** The Route53 zone that hostname belongs to, e.g. "example.com". */
  hostedZoneName: '',

  // --- Optional ------------------------------------------------------------
  /** Zone id. Looked up from hostedZoneName when omitted. */
  hostedZoneId: '',
  /** Existing certificate to reuse. A DNS-validated one is created when empty. */
  certificateArn: '',
  region: 'us-east-1',
  /**
   * The CloudFormation stack name, which is also this deployment's identity: change
   * it on a running deployment and CloudFormation does not rename anything, it
   * builds a second one. Deployments made before the rename pin the old name in
   * their own config file and are unaffected by this default.
   */
  stackName: 'TripleCStack',
  /** Named AWS profile for the CLI/CDK. Empty uses the default credential chain. */
  awsProfile: '',

  /** "password" (self-contained) or "oidc" (authenticate at the load balancer). */
  authMode: 'password',
  oidc: {
    issuer: '',
    authorizationEndpoint: '',
    tokenEndpoint: '',
    userInfoEndpoint: '',
    clientId: '',
    /** Read from Secrets Manager at deploy time; never commit the value. */
    clientSecretArn: '',

    /**
     * WHO IS ALLOWED IN. Not optional, and not the same question as which
     * provider to use.
     *
     * The load balancer's OIDC action authenticates — it proves the caller has an
     * account with the provider. It does not authorise. With Google that means
     * every Google account on earth satisfies it, and what is behind it here is a
     * shell running with `bypassPermissions`. So this list is what actually
     * defends the deployment, and both `config.js` and the chat service refuse to
     * start in oidc mode without it.
     *
     * Give the addresses you sign in with, e.g. ["you@gmail.com"]. Use
     * allowedDomain instead (or as well) only for a provider that owns a domain —
     * a Google Workspace or Cognito pool — never for a public provider, where a
     * domain you do not control is not a restriction at all.
     */
    allowedEmails: [],
    allowedDomain: '',

    /**
     * Requested scopes. "email" is load-bearing rather than cosmetic: without it
     * the provider returns no email claim, the allowlist above has nothing to
     * match on, and every login is refused.
     */
    scope: 'openid email',
  },

  /**
   * Restrict who can reach the load balancer at all. Defaulting to the whole
   * internet is what the password protects, but an allowlist is strictly better
   * when the deployment only ever needs to serve a known network.
   */
  allowedCidrs: ['0.0.0.0/0'],

  instanceType: 't4g.large',
  /** GiB. Holds every cloned repo plus all Claude Code session history. */
  workspaceVolumeSize: 100,
  rootVolumeSize: 40,

  /**
   * Attach AdministratorAccess to the instance role.
   *
   * Off by default, and that default is a security decision rather than a
   * preference: Claude runs on this box with permission to execute commands, so
   * whatever the role can do, a prompt can do. The narrow grants the stack adds
   * (Bedrock invoke, its own secrets, its own volume) are enough to run the
   * product. Turn this on only if you want the workspace to deploy other AWS
   * infrastructure, and understand that it makes the login password the only
   * thing standing between the internet and your whole account.
   */
  instanceAdminAccess: false,

  defaultModel: 'us.anthropic.claude-opus-5-5',
  /** "bypassPermissions" | "acceptEdits" | "plan". See docs/SECURITY.md. */
  permissionMode: 'bypassPermissions',
  /** "low" | "medium" | "high" | "xhigh" | "max" — max is the highest there is. */
  effortLevel: 'max',

  pwa: {
    /**
     * What this deployment calls itself, in front of every title the app shows.
     *
     * The icon below is how two deployments look different on a home screen; this
     * is how they read differently. Every title the app puts its name in becomes
     * "<name>: <project>" — the label under a project's icon, the browser tab, the
     * editor window — and the chat app's own icon becomes the name on its own. Set
     * it to what you call the deployment, e.g. "work".
     *
     * Empty is the default and means today's behaviour: a project's window is
     * titled with the project, and the chat app is "Claude". A single deployment
     * has nothing to tell apart, and prefixing every title there would only cost
     * room on a phone.
     *
     * Deliberately narrow: letters, digits, spaces, dot, dash, underscore, up to 24
     * characters. This value is substituted into UserData by sed, written into a
     * systemd Environment line, serialised into a web app manifest and interpolated
     * into an HTML <title>, and a label short enough to fit under an icon needs
     * none of those four to have an escaping rule of its own. Android truncates a
     * home-screen label at around 12 characters anyway, so shorter is better than
     * merely legal.
     */
    name: '',

    /**
     * Which set of installable-app icons ships with the chat UI.
     *
     * A second deployment is a second icon on the same phone's home screen — same
     * code, different product — so the icons cannot be a constant. This names a
     * directory in this repository holding the files pwa/manifest.webmanifest
     * asks for; the default set is `pwa-icons`, and a variant is a subdirectory of
     * it, e.g. "pwa-icons/ribbon". See pwa-icons/README.md.
     *
     * The icons are tracked in git even though the config that selects them is
     * not, because deploy.sh ships the tree the deploy box checked out from
     * origin/main: an untracked icon would quietly become the default one there,
     * and the deploy would report success over the wrong icon.
     */
    iconDir: 'pwa-icons',
  },

  gitUserName: 'TripleC',
  gitUserEmail: 'triplec@example.invalid',

  /**
   * The machine full deploys are driven from — `./deploy-remote.sh` reads this.
   *
   * A full deploy must not run on the instance this stack manages: CloudFormation
   * applies a UserData change by stopping that instance, so everything the deploy
   * does afterwards — pushing the app, checking it still requires a login — dies
   * with the box, and the stack goes green over an app that was never updated.
   * `deploy.sh` refuses outright when it detects it is running there.
   *
   * So deploys need a second machine. Anything works: a laptop, CI, or a small
   * instance kept for the purpose. Naming one here is what makes it a habit rather
   * than a thing someone has to remember — `deploy-remote.sh` resets its clone to
   * origin/main and runs the real deploy there, over SSM, so the deploy survives
   * the workspace being stopped, restarted or closed.
   *
   * `instanceId` empty means "no deploy box configured", and `deploy-remote.sh`
   * says so rather than guessing. It needs the SSM agent running and a role that
   * can deploy the stack.
   */
  deployFrom: {
    /** e.g. "i-0123456789abcdef0". Must not be this stack's own instance. */
    instanceId: '',
    /** Where the repository is checked out on that machine. */
    repoPath: '',
    /** The user that owns that checkout. Deploys run as them, not as root. */
    user: 'ec2-user',
  },

  /**
   * Optional marketing site, served from S3 behind CloudFront on its own
   * hostname. Entirely separate from the workspace: different stack, different
   * hostname, no shared resources, and nothing about it can reach the instance.
   *
   * Leave `domainName` empty and no landing resources are created at all.
   */
  /**
   * Account-level audit and threat detection, as its own opt-in stack.
   *
   * Separate from the workspace stack on purpose, and for a different reason than
   * the landing site: these are account-wide singletons, not app resources. A
   * CloudTrail trail records every API call made in the account — including the
   * ones made with the instance role, which is the only way to find out after the
   * fact what a compromised workspace did. GuardDuty is what notices while it is
   * happening.
   *
   * Worth understanding before enabling: `guardDuty` creates a detector, and AWS
   * permits exactly ONE per account per region. If the account already has one —
   * from another stack, another tool, or a click in the console — this deploy
   * fails on that resource. Hence the default of false, which is "leave my
   * account's detector alone" rather than "detection is optional".
   *
   * Leave `enabled` false and nothing here is created at all.
   */
  security: {
    enabled: false,
    stackName: 'TripleCSecurityStack',
    /** Multi-region trail with log file validation, into a private bucket. */
    cloudTrail: true,
    /** See the one-per-region warning above. */
    guardDuty: false,
    /** How long trail logs are kept. 0 keeps them forever. */
    logRetentionDays: 365,
  },

  landing: {
    /** e.g. "triplec.example.com". Empty disables the whole landing stack. */
    domainName: '',
    /**
     * The Route53 zone `domainName` belongs to, when that is not the zone the
     * workspace lives in. Empty means "the same zone", which is the common case.
     *
     * This exists because a marketing site and a private workspace are not usually
     * two names in one domain. The workspace is a machine someone reaches at a
     * hostname nobody else needs to know; the site is the product's name, bought
     * for the purpose. Before this setting the landing hostname had to sit inside
     * `hostedZoneName`, which meant the public page advertised a subdomain of the
     * same zone as the private box — and the only way to move it was to move the
     * workspace too.
     *
     * Give `hostedZoneId` as well to skip the lookup; a cross-zone deploy is
     * exactly when `fromLookup` is most likely to resolve the wrong thing, because
     * both zones answer to the same account.
     */
    hostedZoneName: '',
    hostedZoneId: '',
    /**
     * CloudFront requires its certificate in us-east-1, regardless of where the
     * rest of the deployment lives. Empty creates a DNS-validated one there.
     *
     * Leave it empty when the site is in a zone of its own: a certificate for the
     * workspace's domain does not cover a different domain, and CloudFront answers
     * a hostname its certificate does not name with a TLS error rather than a page.
     */
    certificateArn: '',
    stackName: 'TripleCLandingStack',

    /**
     * Visitor analytics for the landing page. Off unless a key is set.
     *
     * `posthogKey` is a PostHog *project* key — the `phc_…` one that is meant to
     * be public and sits in the page's JavaScript. It is still per-deployment
     * rather than committed, because it names someone's PostHog project: a fork
     * that inherited it would report its visitors into a stranger's account.
     *
     * With a key set, the landing distribution also proxies PostHog under a path
     * of its own so that no request leaves this origin (see
     * infra/landing-analytics.js), and the page's CSP is widened exactly far
     * enough to allow it. Session replay additionally has to be switched on in
     * the PostHog project itself; the client cannot turn it on from here.
     */
    analytics: {
      posthogKey: '',
      /** "us" or "eu" — which PostHog cloud the project lives in. */
      region: 'us',
    },
  },
};

/**
 * Environment overrides, flattened, without their prefix.
 *
 * Each is read as `TRIPLEC_<SUFFIX>` and, failing that, as `CLAUDE_WEB_<SUFFIX>`.
 * The old prefix is not deprecated-and-ignored but deprecated-and-honoured: these
 * variables are typed at a prompt and pasted into CI, so dropping one turns a
 * deliberate override into a silent fallback to the default — a deploy that goes
 * green having ignored the one value it was told to change.
 */
const ENV_SUFFIXES = {
  DOMAIN: 'domainName',
  HOSTED_ZONE: 'hostedZoneName',
  HOSTED_ZONE_ID: 'hostedZoneId',
  CERT_ARN: 'certificateArn',
  REGION: 'region',
  STACK_NAME: 'stackName',
  AUTH_MODE: 'authMode',
  INSTANCE_TYPE: 'instanceType',
  DEFAULT_MODEL: 'defaultModel',
  PERMISSION_MODE: 'permissionMode',
  GIT_USER_NAME: 'gitUserName',
  GIT_USER_EMAIL: 'gitUserEmail',
};

/** The prefixes, weakest first. Exported so a test can assert both still work. */
export const ENV_PREFIXES = ['CLAUDE_WEB_', 'TRIPLEC_'];

/**
 * Every variable name that maps to a setting, new prefix and old, plus the strays.
 *
 * Insertion order is load-bearing: `loadConfig` walks these in order and assigns as
 * it goes, so the last prefix to mention a key is the one that wins. Hence weakest
 * first — with both set, the current name decides.
 */
export const ENV_MAP = Object.fromEntries([
  ...ENV_PREFIXES.flatMap((prefix) =>
    Object.entries(ENV_SUFFIXES).map(([suffix, key]) => [`${prefix}${suffix}`, key]),
  ),
  // Not ours to prefix: this is the AWS CLI's own variable and reading it is how a
  // deployment inherits the profile the operator is already using.
  ['AWS_PROFILE', 'awsProfile'],
]);

/**
 * What a deployment may call itself, as one pattern both ends share.
 *
 * Exported because the chat service enforces the same thing again at runtime and
 * cannot import this file — it is deployed without `infra/` — so the two copies are
 * kept honest by a test instead (see chat-service/manifest-test.js). The shape:
 * starts with a letter or digit, then letters, digits, spaces, dots, dashes or
 * underscores, 24 characters at most.
 */
export const PWA_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,23}$/;

const VALID_AUTH_MODES = ['password', 'oidc'];
const VALID_PERMISSION_MODES = ['bypassPermissions', 'acceptEdits', 'plan', 'default'];

function fail(message) {
  throw new Error(`Invalid configuration: ${message}`);
}

/**
 * The icon files a deployment must ship, read out of the manifest rather than
 * listed here.
 *
 * pwa/manifest.webmanifest is the contract with the browser: it names each icon
 * by path, and an install whose icon 404s is not an install. Two lists of those
 * filenames — one in the manifest, one wherever the copy happens — drift the
 * moment a size is added, and the symptom is a home screen icon that is missing
 * on one deployment only. So there is one list, and this reads it.
 */
export function requiredPwaIcons() {
  const file = join(REPO_ROOT, 'pwa', 'manifest.webmanifest');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`${file} could not be read, so the icons a deployment needs are unknown — ${err.message}`);
  }
  const names = (manifest.icons || []).map((icon) => String(icon.src).split('/').pop());
  if (!names.length) fail(`${file} declares no icons, so nothing it installs would have one.`);
  return [...new Set(names)];
}

export function loadConfig() {
  const file = configPath();
  let fromFile = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      fail(`${file} is not valid JSON — ${err.message}`);
    }
    // JSON has no comments, so the example file documents itself with "$comment"
    // keys. Drop them rather than carrying them into the config object.
    fromFile = Object.fromEntries(
      Object.entries(fromFile).filter(([key]) => !key.startsWith('$')),
    );
  }

  const config = {
    ...DEFAULTS,
    ...fromFile,
    oidc: { ...DEFAULTS.oidc, ...(fromFile.oidc || {}) },
    landing: {
      ...DEFAULTS.landing,
      ...(fromFile.landing || {}),
      analytics: { ...DEFAULTS.landing.analytics, ...(fromFile.landing?.analytics || {}) },
    },
    pwa: { ...DEFAULTS.pwa, ...(fromFile.pwa || {}) },
    deployFrom: { ...DEFAULTS.deployFrom, ...(fromFile.deployFrom || {}) },
    security: { ...DEFAULTS.security, ...(fromFile.security || {}) },
  };

  for (const [envVar, key] of Object.entries(ENV_MAP)) {
    if (process.env[envVar]) config[key] = process.env[envVar];
  }

  // Booleans and numbers survive a round trip through the environment. Both
  // prefixes, for the reason given above ENV_SUFFIXES.
  const adminAccess = process.env.TRIPLEC_ADMIN_ACCESS ?? process.env.CLAUDE_WEB_ADMIN_ACCESS;
  if (adminAccess) config.instanceAdminAccess = adminAccess === 'true';

  // --- Validation ----------------------------------------------------------
  if (!config.domainName) {
    fail(
      'domainName is required. Set it in triplec.config.json (copy ' +
        'triplec.config.example.json) or pass TRIPLEC_DOMAIN. This is the ' +
        'hostname you will open in a browser, e.g. "code.example.com".',
    );
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(config.domainName)) {
    fail(`domainName "${config.domainName}" is not a hostname. Expected e.g. "claude.example.com".`);
  }
  if (!config.hostedZoneName) {
    fail(
      'hostedZoneName is required — the Route53 hosted zone that contains ' +
        `"${config.domainName}", e.g. "example.com". The deployment creates a DNS ` +
        'record and validates a TLS certificate in this zone, so it must already exist.',
    );
  }
  if (!config.domainName.endsWith(config.hostedZoneName)) {
    fail(
      `domainName "${config.domainName}" is not inside hostedZoneName ` +
        `"${config.hostedZoneName}". DNS validation and the alias record would both fail.`,
    );
  }

  if (!VALID_AUTH_MODES.includes(config.authMode)) {
    fail(`authMode "${config.authMode}" is not one of: ${VALID_AUTH_MODES.join(', ')}.`);
  }
  if (config.authMode === 'oidc') {
    const missing = ['issuer', 'authorizationEndpoint', 'tokenEndpoint', 'userInfoEndpoint',
      'clientId', 'clientSecretArn'].filter((k) => !config.oidc[k]);
    if (missing.length) {
      fail(
        `authMode is "oidc" but these oidc settings are missing: ${missing.join(', ')}. ` +
          'See docs/DEPLOY.md for where to find them for Google, GitHub or Cognito. ' +
          'Leave authMode as "password" if you do not want to configure a provider.',
      );
    }

    if (!Array.isArray(config.oidc.allowedEmails)) {
      fail('oidc.allowedEmails must be an array of addresses, e.g. ["you@gmail.com"].');
    }
    const emails = config.oidc.allowedEmails.map((e) => String(e).trim()).filter(Boolean);
    if (!emails.length && !String(config.oidc.allowedDomain || '').trim()) {
      fail(
        'authMode is "oidc" but oidc.allowedEmails is empty. The load balancer only ' +
          'checks that the caller has an account with your provider — with Google that ' +
          'is every Google account in existence, and this deployment hands whoever gets ' +
          'in a shell. Set the addresses you sign in with, e.g.\n' +
          '      "allowedEmails": ["you@gmail.com"]\n' +
          '  or, for a provider that owns a domain, "allowedDomain": "example.com".',
      );
    }
    for (const email of emails) {
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) {
        fail(`oidc.allowedEmails entry "${email}" is not an email address.`);
      }
    }
    if (!/\bemail\b/.test(config.oidc.scope || '')) {
      fail(
        `oidc.scope is "${config.oidc.scope}", which does not request "email". The ` +
          'allowlist matches on the email claim, so without that scope the provider ' +
          'returns nothing to match and every login is refused. Use "openid email".',
      );
    }
  }

  if (!VALID_PERMISSION_MODES.includes(config.permissionMode)) {
    fail(
      `permissionMode "${config.permissionMode}" is not one of: ` +
        `${VALID_PERMISSION_MODES.join(', ')}.`,
    );
  }

  if (!Array.isArray(config.allowedCidrs) || config.allowedCidrs.length === 0) {
    fail('allowedCidrs must be a non-empty array, e.g. ["0.0.0.0/0"] or ["203.0.113.4/32"].');
  }
  for (const cidr of config.allowedCidrs) {
    if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(cidr)) {
      fail(`allowedCidrs entry "${cidr}" is not an IPv4 CIDR block, e.g. "203.0.113.0/24".`);
    }
  }

  for (const [key, value] of Object.entries({
    workspaceVolumeSize: config.workspaceVolumeSize,
    rootVolumeSize: config.rootVolumeSize,
  })) {
    if (!Number.isInteger(value) || value < 8) {
      fail(`${key} must be a whole number of GiB, at least 8. Got ${JSON.stringify(value)}.`);
    }
  }

  // --- What this deployment is called --------------------------------------
  // The pattern is the whole safety story for this value. It travels through a sed
  // replacement in UserData, a systemd Environment line, a JSON manifest and an
  // HTML <title>, and rejecting anything that is not a plain short label here means
  // no link in that chain needs an escaping rule — see PWA_NAME_PATTERN and
  // deploymentName() in chat-service/manifest.js, which sanitises again rather than
  // trusting a box whose env file was edited by hand.
  const pwaName = String(config.pwa.name || '').trim();
  if (pwaName && !PWA_NAME_PATTERN.test(pwaName)) {
    fail(
      `pwa.name ${JSON.stringify(config.pwa.name)} is not a name this can use. Give a ` +
        'short label of letters, digits, spaces, dots, dashes or underscores — at most ' +
        '24 characters, starting with a letter or digit, e.g. "work". It is prefixed to ' +
        'every title the app shows ("work: my-project"), so it has to survive being put ' +
        'in a manifest, an HTML title and a systemd unit. Leave it empty for a single ' +
        'deployment, which titles windows with the project alone.',
    );
  }
  config.pwa.name = pwaName;

  // --- PWA icons -----------------------------------------------------------
  // Checked here rather than at the copy in deploy.sh because this is the error
  // worth having early: the alternative is a deploy that goes green and an icon
  // that is missing on a phone, where nobody is reading a log.
  const iconDir = String(config.pwa.iconDir || '').trim();
  if (!iconDir || iconDir.startsWith('/') || iconDir.split('/').includes('..')) {
    fail(
      `pwa.iconDir ${JSON.stringify(config.pwa.iconDir)} must be a directory inside this ` +
        'repository, relative to its root — "pwa-icons" for the default set, or a ' +
        'subdirectory of it for a deployment of your own, e.g. "pwa-icons/ribbon". ' +
        'See pwa-icons/README.md.',
    );
  }
  config.pwa.iconDir = iconDir;
  const missingIcons = requiredPwaIcons().filter((name) => !existsSync(join(REPO_ROOT, iconDir, name)));
  if (missingIcons.length) {
    fail(
      `pwa.iconDir "${iconDir}" is missing ${missingIcons.join(', ')}, which ` +
        'pwa/manifest.webmanifest names. A manifest whose icons 404 is not installable, ' +
        'so the app would stop being addable to a home screen. Add the files, or point ' +
        'pwa.iconDir at a set that has them.',
    );
  }

  // --- Landing site (optional) ---------------------------------------------
  if (config.landing.domainName) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(config.landing.domainName)) {
      fail(
        `landing.domainName "${config.landing.domainName}" is not a hostname. ` +
          'Expected e.g. "triplec.example.com", or leave it empty to skip the landing site.',
      );
    }
    // The zone the site's record goes into: its own if it has one, else the
    // workspace's. `landingZone` below is what the stack reads, so this check and
    // the resource it guards cannot end up looking at different zones.
    const landingZone = config.landing.hostedZoneName || config.hostedZoneName;
    if (!config.landing.domainName.endsWith(landingZone)) {
      fail(
        `landing.domainName "${config.landing.domainName}" is not inside ` +
          `"${landingZone}". The alias record and certificate validation both need ` +
          'it to be. Either set landing.hostedZoneName to the zone that owns the ' +
          'marketing domain, or use a hostname inside the workspace zone.',
      );
    }
    if (config.landing.hostedZoneId && !config.landing.hostedZoneName) {
      fail(
        'landing.hostedZoneId is set but landing.hostedZoneName is empty. The id ' +
          'alone is not enough: a Route53 record needs the zone name too, and ' +
          'taking it from the workspace zone would build the record in the right ' +
          'zone under the wrong name.',
      );
    }
    // A certificate names the hostnames it covers, and CloudFront serves a name its
    // certificate does not name as a TLS error rather than a page — which looks
    // like DNS or like CloudFront still deploying, not like the wrong ARN.
    if (config.landing.certificateArn && config.landing.hostedZoneName &&
        config.landing.hostedZoneName !== config.hostedZoneName) {
      console.warn(
        `[config] landing.domainName "${config.landing.domainName}" is in a zone of ` +
          'its own, but landing.certificateArn reuses an existing certificate. Make ' +
          'sure that certificate actually covers this hostname — if it was issued ' +
          `for "${config.hostedZoneName}" it does not, and the site will answer with ` +
          'a TLS error. Leaving certificateArn empty issues a matching one.',
      );
    }
    if (config.landing.domainName === config.domainName) {
      fail(
        `landing.domainName and domainName are both "${config.domainName}". They ` +
          'cannot share a hostname — one DNS record cannot point at both ' +
          'CloudFront and the load balancer. Give the workspace its own subdomain.',
      );
    }
    // Analytics, if it is switched on. Checked here rather than discovered in the
    // browser: a mistyped key is a page that loads, looks right, and records
    // nothing anywhere, which is the one failure nobody notices.
    const analytics = config.landing.analytics;
    if (analytics.posthogKey && !/^phc_[A-Za-z0-9]{20,}$/.test(analytics.posthogKey)) {
      fail(
        `landing.analytics.posthogKey "${analytics.posthogKey}" is not a PostHog project ` +
          'key. Expected the public "phc_…" key from Project settings → Project API key ' +
          '— not a personal API key (phx_…), and not the project id.',
      );
    }
    if (!['us', 'eu'].includes(analytics.region)) {
      fail(
        `landing.analytics.region "${analytics.region}" is not a PostHog cloud. Use "us" ` +
          'or "eu" — whichever your project lives in. The wrong one accepts the events ' +
          'and shows them in no project you can see.',
      );
    }
    // The workspace certificate is only reusable when it happens to live in
    // us-east-1, which is the only region CloudFront reads certificates from.
    if (!config.landing.certificateArn && config.region !== 'us-east-1') {
      console.warn(
        '[config] landing.certificateArn is empty and region is not us-east-1, ' +
          'so a certificate will be created in us-east-1 for CloudFront. This is ' +
          'correct, just worth knowing: the landing stack is always us-east-1.',
      );
    }
  }

  // --- Security stack (optional) -------------------------------------------
  if (config.security.enabled) {
    if (!config.security.cloudTrail && !config.security.guardDuty) {
      fail(
        'security.enabled is true but both security.cloudTrail and security.guardDuty ' +
          'are false, so the stack would create nothing. Enable at least one, or set ' +
          'security.enabled to false.',
      );
    }
    const days = config.security.logRetentionDays;
    if (!Number.isInteger(days) || days < 0) {
      fail(
        'security.logRetentionDays must be a whole number of days, or 0 to keep trail ' +
          `logs forever. Got ${JSON.stringify(days)}.`,
      );
    }
  }

  // --- Deploy box (optional) -----------------------------------------------
  // Only shape is checked here. Whether the machine exists, answers SSM, or is
  // this stack's own instance are all questions for deploy-remote.sh, which can
  // ask AWS; this file must stay usable with no credentials at all.
  if (config.deployFrom.instanceId) {
    if (!/^i-[0-9a-f]{8,17}$/.test(config.deployFrom.instanceId)) {
      fail(
        `deployFrom.instanceId "${config.deployFrom.instanceId}" is not an EC2 instance ` +
          'id, e.g. "i-0123456789abcdef0". It names the machine ./deploy-remote.sh ' +
          'drives a full deploy from — see docs/DEPLOY.md.',
      );
    }
    if (!String(config.deployFrom.repoPath).startsWith('/')) {
      fail(
        'deployFrom.repoPath must be the absolute path of the repository checkout on ' +
          `${config.deployFrom.instanceId}, e.g. "/home/ec2-user/triplec". Got ` +
          `${JSON.stringify(config.deployFrom.repoPath)}.`,
      );
    }
    if (!config.deployFrom.user) {
      fail(
        'deployFrom.user must be the user that owns the checkout on ' +
          `${config.deployFrom.instanceId}, e.g. "ec2-user". Deploys run as that user ` +
          'rather than as root, so the checkout keeps one owner.',
      );
    }
  }

  if (config.gitUserEmail === DEFAULTS.gitUserEmail) {
    // Not fatal: commits still work, they just carry a placeholder author.
    console.warn(
      '[config] gitUserEmail is unset, so commits Claude makes on the workspace ' +
        `will be authored as <${DEFAULTS.gitUserEmail}>. Set gitUserName and ` +
        'gitUserEmail to your own.',
    );
  }

  return config;
}
