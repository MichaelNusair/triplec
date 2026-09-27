/**
 * One manifest per project, because that is what a second window costs on Android.
 *
 * The platform fact this rests on: Chrome gives an installed web app exactly one
 * window on a phone, and no API opens a second. App *identity* is the only lever —
 * a manifest with an unfamiliar `id` is a distinct application even when served
 * from the same URL, and a distinct application on Android is a distinct icon with
 * its own task. If the id ever stops differing per project the symptom is silent:
 * adding a second project to the home screen quietly replaces the first icon
 * instead of joining it.
 *
 * The id is not sufficient, only necessary, which is the lesson that cost a release.
 * An installed app claims URLs by *scope*, a path prefix compared without the query
 * string, so projects differing only in `?folder=` were one app to Android and only
 * the first could be installed — "already installed" for the rest. Hence a path per
 * project, `/p/<name>/`, and hence the last section of this file: that path is a
 * promise only nginx can keep, and it is written in another language in another
 * directory.
 *
 * The other thing checked here is drift. The fields that are not project-specific
 * are written out in manifest.js rather than read from pwa/manifest.webmanifest,
 * because that file lives somewhere else at runtime. This test is what keeps the
 * duplicate honest.
 *
 * Run: node chat-service/manifest-test.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
const PROJECTS = path.join(TMP, 'projects');
fs.mkdirSync(path.join(PROJECTS, 'demo'), { recursive: true });
fs.mkdirSync(path.join(PROJECTS, 'other'), { recursive: true });

// Read at import time by session-manager.js, which manifest.js validates through.
process.env.PROJECTS_ROOT = PROJECTS;

const {
  projectManifest,
  projectStartUrl,
  projectWindowPath,
  manifestForProject,
  deploymentName,
  appTitle,
  chatManifest,
  applyDeploymentName,
  APP_NAME,
} = await import('./manifest.js');
const { PWA_NAME_PATTERN } = await import('../infra/config.js');

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}`);
  }
};
const section = (name) => console.log(`\n${name}`);

section('A project is a distinct app, which is the entire point:');
const demo = await manifestForProject('demo');
const other = await manifestForProject('other');
ok(demo.id !== other.id, 'two projects share an id, so the second icon replaces the first');
ok(demo.id === '/p/demo/', 'the id is not the project’s own path');
ok(
  demo.start_url.startsWith(demo.id),
  'the icon opens outside the app it identifies, so the first launch is a browser tab',
);
ok(
  demo.start_url === projectStartUrl('demo', path.join(PROJECTS, 'demo')),
  'the manifest and the switcher disagree about where a project opens',
);
ok(
  demo.start_url === `/p/demo/?folder=${encodeURIComponent(path.join(PROJECTS, 'demo'))}`,
  'a project window opens somewhere other than its own path with its folder named — ' +
    'the path is what makes it installable, the query is what opens the folder',
);

/*
 * The check the original version of this file was missing, and the reason a second
 * project would not install on Android at all.
 *
 * A manifest's scope is a path prefix and scope matching *ignores the query string*.
 * Every project used to declare `scope: '/'` with a start_url differing only in
 * `?folder=`, so to Android every project — and the chat app — was one installed web
 * app claiming the whole origin, and Chrome refused each install after the first as
 * "already installed". A differing `id` does not help: the installed WebAPK claims
 * URLs by scope. If these two ever share a scope again, that returns.
 */
ok(
  demo.scope !== other.scope,
  'two projects share a scope, so Android treats them as one app and only the first ' +
    'one installs — "already installed" is the symptom',
);
ok(demo.scope === '/p/demo/', 'a project’s scope is not its own path');
ok(
  demo.start_url.startsWith(demo.scope) && demo.id.startsWith(demo.scope),
  'the start_url or the id falls outside the scope, which makes the manifest invalid',
);
ok(
  demo.scope !== '/',
  'the scope is the whole origin again, which is exactly the collision this shape ' +
    'exists to avoid',
);

section('What the icon says, and how far the window reaches:');
ok(demo.short_name === 'demo', 'the home-screen label is not the bare project name');
ok(/demo/.test(demo.name), 'the installer label does not name the project');
ok(demo.name !== other.name, 'two projects install under the same name');
/*
 * The accepted cost of a narrow scope: /login is outside it, so the first launch
 * after a lapsed session shows Chrome's toolbar until the redirect lands. A scope
 * wide enough to contain the login page is wide enough to collide with every other
 * project, and a login that looks like a browser beats a project that cannot be
 * installed.
 */
ok(!'/login'.startsWith(demo.scope), 'the scope covers /login, which means it is too wide to be unique');
ok(demo.display === 'standalone', 'the project window is not standalone, so it is a tab');
ok(
  demo.orientation === undefined,
  'the project window is locked to an orientation — a workbench is used in both',
);
ok(
  demo.launch_handler === undefined,
  'launch_handler is pinned, which would stop a desktop opening a second window later',
);

section('The chat app is declared, so a phone can be asked what is installed:');
/*
 * getInstalledRelatedApps() only answers about applications the page's manifest
 * declares as related, and on Android the one question worth asking is which
 * installed app Chrome thinks a /p/<name>/ URL belongs to — the chat app's scope is
 * the whole origin, so it is the first suspect when a project install is refused
 * as "already installed". Both members are load-bearing in opposite directions:
 * without the declaration the check can say nothing, and with
 * prefer_related_applications true the browser would offer that app instead of
 * installing this one.
 */
ok(
  demo.related_applications?.[0]?.platform === 'webapp',
  'the chat app is not declared as a related web app, so the editor’s install check ' +
    'can never name what Chrome thinks is already installed',
);
ok(
  demo.related_applications?.[0]?.url === '/chat/manifest.webmanifest',
  'the declared related app does not point at the chat manifest that index.html links',
);
ok(
  demo.prefer_related_applications === false,
  'prefer_related_applications is not explicitly false — true would make the browser ' +
    'offer the chat app instead of installing this project',
);

section('Everything shared with the chat app still agrees with it:');
const base = JSON.parse(fs.readFileSync(path.join(root, 'pwa', 'manifest.webmanifest'), 'utf8'));
ok(
  JSON.stringify(demo.icons) === JSON.stringify(base.icons),
  'the icons drifted from pwa/manifest.webmanifest — an install with no icon is not installable',
);
ok(demo.theme_color === base.theme_color, 'the theme colour drifted from the chat app');
ok(demo.background_color === base.background_color, 'the background colour drifted from the chat app');

section('Every icon set on disk can answer that manifest, whichever one a deployment picks:');
/*
 * The icons are the one asset that differs per deployment — two deployments of this
 * repository are two apps on the same phone, and `pwa.iconDir` in the config is
 * which set ships (see pwa-icons/README.md). The config that picks a set is
 * gitignored, so no test can check the choice; what a test can check is that every
 * set present is complete, because the alternative is finding out from a phone. An
 * install whose icon 404s is not an install, and the deploy that shipped it says
 * nothing.
 *
 * Sizes are read from the PNG header rather than trusted: a 512 declared and 192
 * delivered is the same broken install, arriving more quietly.
 */
const ICON_ROOT = path.join(root, 'pwa-icons');
const iconSets = [
  ICON_ROOT,
  ...fs.readdirSync(ICON_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(ICON_ROOT, e.name)),
];
/** Width and height out of a PNG's IHDR, which is always the first chunk. */
const pngSize = (file) => {
  const head = fs.readFileSync(file).subarray(0, 24);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
};
for (const set of iconSets) {
  const setName = path.relative(root, set);
  for (const icon of base.icons) {
    const file = path.join(set, icon.src.split('/').pop());
    const present = fs.existsSync(file);
    ok(present, `${setName} is missing ${icon.src.split('/').pop()}, so a deployment using it installs without an icon`);
    if (!present) continue;
    const { width, height } = pngSize(file);
    ok(
      `${width}x${height}` === icon.sizes,
      `${setName}/${path.basename(file)} is ${width}x${height} but the manifest promises ${icon.sizes}`,
    );
  }
}

section('A named deployment says so in every title, and changes nothing else:');
/*
 * The words half of telling two deployments apart. `pwa.iconDir` above is how they
 * look different on a home screen; `pwa.name` is how they read — "<name>: <project>"
 * under a project's icon, in its browser tab and in its editor title bar, and the
 * name on its own for the chat app.
 *
 * What these checks are really defending is the *unnamed* deployment, which is
 * everyone who deploys this repository once: with no name set, every title has to be
 * exactly what it was before this existed. And on the named side, identity: `id` and
 * `scope` are how a phone recognises an app it already installed, so renaming a
 * deployment must not orphan an icon.
 */
const shells = Object.fromEntries(
  ['index.html', 'login.html', 'admin.html'].map((f) => [
    f,
    fs.readFileSync(path.join(here, 'public', f), 'utf8'),
  ]),
);

/*
 * The rename is a text substitution, so it can only find a name the page actually
 * spells. Every shell has to write APP_NAME where it means "this app", and the
 * manifest has to agree with it — otherwise a named deployment comes out named on
 * two pages out of three, or its icon keeps the product's name while its tab does
 * not. Neither is visible from the deployment that has no name, which is the one
 * every test above this line is about.
 */
for (const [file, html] of Object.entries(shells)) {
  ok(
    html.includes(APP_NAME),
    `public/${file} never writes "${APP_NAME}", so applyDeploymentName has nothing to ` +
      'replace there and a named deployment keeps the product name on that page',
  );
}
ok(
  base.name === APP_NAME && base.short_name === APP_NAME,
  `pwa/manifest.webmanifest calls the app "${base.name}" while manifest.js calls it ` +
    `"${APP_NAME}" — the installed icon and the browser tab would disagree`,
);

delete process.env.PWA_NAME;
ok(deploymentName() === '', 'a deployment with no name reports one anyway');
ok(appTitle('demo') === 'demo', 'an unnamed deployment prefixes titles with something');
const plain = await manifestForProject('demo');
ok(plain.short_name === 'demo', 'the home-screen label changed for a deployment with no name');
ok(plain.name === `demo — ${APP_NAME}`, 'the installer label changed for a deployment with no name');
ok(chatManifest(base) === base, 'the chat manifest is rebuilt when there is no name to put in it');
ok(
  Object.values(shells).every((html) => applyDeploymentName(html) === html),
  'an unnamed deployment still has its HTML shells rewritten, so a single deployment ' +
    'pays for a feature it is not using',
);

process.env.PWA_NAME = 'work';
const named = await manifestForProject('demo');
ok(deploymentName() === 'work', 'the deployment name is not read from the environment');
ok(appTitle('demo') === 'work: demo', 'a project title is not "<name>: <project>"');
ok(named.short_name === 'work: demo', 'the label under the icon does not say which deployment it opens');
ok(
  named.name === `work: demo — ${APP_NAME}`,
  'the installer label does not name the deployment, so two deployments offer the same install',
);
ok(
  named.id === plain.id && named.scope === plain.scope && named.start_url === plain.start_url,
  'naming a deployment changed a project app’s identity or scope — every icon already ' +
    'installed from it is orphaned, and the next install is a second copy',
);
ok(
  JSON.stringify(named.icons) === JSON.stringify(plain.icons),
  'the name changed which icons a project installs with',
);

const chat = chatManifest(base);
ok(chat.name === 'work' && chat.short_name === 'work', 'the chat app is not named after its deployment');
ok(
  chat.id === base.id && chat.scope === base.scope && chat.start_url === base.start_url,
  'renaming the chat app moved its identity or scope, which orphans the installed icon',
);
ok(
  JSON.stringify(chat.icons) === JSON.stringify(base.icons) && chat.display === base.display,
  'the chat manifest lost fields on the way through the rename',
);

/*
 * Each shell writes APP_NAME where it means "this deployment's app", so the word is
 * what gets replaced and each page keeps its own phrasing. The meta tag is the one
 * addition: it is how app.js learns the name, so a tab can read "<name>: <project>"
 * once a project is on screen (setTabTitle in public/app.js).
 */
const titleOf = (html) => /<title>([^<]*)<\/title>/.exec(html)?.[1];
const metaOf = (html, name) =>
  new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(html)?.[1];
const renamed = Object.fromEntries(
  Object.entries(shells).map(([f, html]) => [f, applyDeploymentName(html)]),
);
ok(titleOf(renamed['index.html']) === 'work', 'the chat app’s tab does not say which deployment it is');
ok(
  titleOf(renamed['login.html']) === 'Sign in — work',
  'the login page does not say which deployment you are signing in to — with two of them ' +
    'that is the one page where it matters most',
);
ok(
  titleOf(renamed['admin.html']) === 'work · box',
  'the box page lost its own phrasing, or was not renamed at all',
);
ok(
  metaOf(renamed['index.html'], 'deployment') === 'work',
  'the shell does not carry the deployment name, so the client cannot title a tab with it',
);
ok(
  metaOf(renamed['index.html'], 'apple-mobile-web-app-title') === 'work',
  `the iOS home-screen label still says ${APP_NAME} on a named deployment`,
);
ok(
  metaOf(shells['index.html'], 'deployment') === '',
  'public/index.html no longer ships an empty deployment meta tag for the server to fill, ' +
    'so the client reads whatever was committed',
);
ok(
  renamed['index.html'].includes('<script src="/chat/app.js"></script>'),
  'the rewrite disturbed something other than the titles',
);

/*
 * A name this cannot use is treated as no name at all, and that is a security
 * property rather than tidiness: these values are interpolated into an HTML <title>
 * and serialised into a manifest, and what arrives here is an environment variable,
 * so a box whose unit file was hand-edited must not be able to put markup in a page.
 * Mangling it into something legal would be worse than ignoring it — a name nobody
 * chose, under every icon.
 */
process.env.PWA_NAME = '<script>alert(1)</script>';
ok(deploymentName() === '', 'a name that is not a name is used anyway');
ok(appTitle('demo') === 'demo', 'a rejected name still reached a title');
ok(
  applyDeploymentName(shells['index.html']) === shells['index.html'],
  'a rejected name still rewrote the shell — which is script injection into the chat app',
);
process.env.PWA_NAME = 'x'.repeat(25);
ok(deploymentName() === '', 'a name past the length limit is used anyway');
delete process.env.PWA_NAME;

/*
 * Two copies of one pattern, in two files that cannot import each other: the service
 * is deployed without `infra/`, so manifest.js carries its own. A drift here is a
 * name the config accepts and the app silently drops, or the reverse.
 */
const manifestSrc = fs.readFileSync(path.join(here, 'manifest.js'), 'utf8');
const declared = /const NAME_PATTERN = (\/.*\/);/.exec(manifestSrc)?.[1];
ok(declared, 'manifest.js no longer declares NAME_PATTERN, so this drift check is blind');
ok(
  declared === String(PWA_NAME_PATTERN),
  `the deployment name pattern drifted: infra/config.js has ${PWA_NAME_PATTERN}, ` +
    `chat-service/manifest.js has ${declared} — one of them accepts a name the other refuses`,
);

section('And the name actually reaches the box, which is three files away:');
/*
 * The name is the only thing in this feature that cannot be shipped by
 * `deploy.sh --app-only`: it travels config → UserData (a sed in stack.js) → a shell
 * variable in bootstrap.sh → the chat service's unit → PWA_NAME in the process. Every
 * link is in a different language, and a broken one is silent — a deployment that
 * deploys green and is still called Claude.
 *
 * So the placeholders are checked as a set rather than one by one: anything of the
 * form __NAME__ in bootstrap.sh needs a substitution rule in stack.js, or the deploy
 * ships a script with a literal placeholder in it (deploy.sh refuses at that point,
 * which is the good failure — this check is the earlier one).
 */
const bootstrapSrc = fs.readFileSync(path.join(root, 'infra', 'userdata', 'bootstrap.sh'), 'utf8');
const stackSrc = fs.readFileSync(path.join(root, 'infra', 'lib', 'stack.js'), 'utf8');
const placeholders = new Set(bootstrapSrc.match(/__[A-Z0-9_]+__/g) || []);
ok(placeholders.has('__PWA_NAME__'), 'bootstrap.sh does not take a deployment name at all');
for (const placeholder of placeholders) {
  ok(
    stackSrc.includes(`-e 's|${placeholder}|`),
    `bootstrap.sh uses ${placeholder} but stack.js has no sed rule for it, so the boot ` +
      'script reaches the instance with a literal placeholder where a value belongs',
  );
}
const chatUnit = /cat > \/etc\/systemd\/system\/claude-chat\.service <<SVC\n([\s\S]*?)\nSVC\n/
  .exec(bootstrapSrc)?.[1];
ok(chatUnit, 'the chat service’s unit is no longer written by the heredoc this checks');
ok(
  /^Environment="PWA_NAME=\$PWA_NAME"$/m.test(chatUnit ?? ''),
  'the chat service’s unit does not pass PWA_NAME, so the service cannot know what this ' +
    'deployment is called and every title falls back to Claude — quoted, because a name ' +
    'may contain a space',
);
/*
 * The last link, which is an ordering rather than a value: the unit above is written
 * by the reprovision, and bootstrap.sh never restarts anything (`enable --now` leaves
 * a running unit alone, on purpose — restarting it kills live sessions). So the
 * deploy's own restart has to come after the reprovision, or the process keeps the
 * environment of the previous unit while the file on disk says otherwise. That is
 * what happened on 2026-09-20: restart 12:49:44, unit rewritten 12:50:11, deploy
 * green, every title still "Claude".
 */
const deploySrc = fs.readFileSync(path.join(root, 'deploy.sh'), 'utf8');
const reprovisionAt = deploySrc.indexOf('bash /opt/bootstrap.sh > /var/log/reprovision.log');
const chatRestartAt = deploySrc.indexOf('"systemctl restart claude-chat"');
ok(reprovisionAt > 0 && chatRestartAt > 0, 'deploy.sh no longer reprovisions and restarts the way this checks');
ok(
  chatRestartAt > reprovisionAt,
  'deploy.sh restarts claude-chat before the reprovision that writes its unit, so anything ' +
    'the deploy adds to that unit reaches the running process one deploy late',
);
/*
 * The editor half. code-server writes document.title from `window.title` and rewrites
 * it on every editor change, so this is a setting rather than something the overlay
 * could do — and it is assigned rather than defaulted because that settings file lives
 * on the persistent volume and outlives every deploy (the same trap effortLevel fell
 * into: see "Let the config decide the effort level, every deploy").
 */
ok(
  /WINDOW_TITLE="\$PWA_NAME"': \$\{rootName\}/.test(bootstrapSrc),
  'the editor window title no longer leads with the deployment name and the open folder',
);
ok(
  /merged\['window\.title'\] = window_title/.test(bootstrapSrc) &&
    /merged\.pop\('window\.title', None\)/.test(bootstrapSrc),
  'window.title is not assigned-or-removed from the config, so a name the config no longer ' +
    'asks for is permanent on a box whose settings file survived the deploy',
);

section('And the workspace user can install software, which takes root:');
/*
 * Agents work on this box as `coder`, and for a long time that account was not in
 * sudoers, so anything needing a package failed outright — a headless browser most
 * visibly, since Playwright downloads its own browser but not the RPMs it links
 * against. The grant is provisioning, not application code, which means nothing at
 * runtime would notice it going missing: the account keeps working, and the next
 * agent that needs to install something hits the old wall and has no way to tell
 * whether this was removed on purpose. Hence a test.
 *
 * Three things, because two of them are the ways this silently does nothing:
 * validating a sudoers file before installing it (an unparseable one takes sudo down
 * with it, repair path included), and asking sudo afterwards whether the grant is
 * real — dropping a file into /etc/sudoers.d only works if /etc/sudoers includes
 * that directory.
 */
ok(
  /^\s*visudo -cf "\$SUDOERS_STAGE"$/m.test(bootstrapSrc),
  'bootstrap.sh installs a sudoers file without running visudo over it first, so a typo ' +
    'there disables sudo on the whole box, including the way back',
);
ok(
  /NOPASSWD:ALL/.test(bootstrapSrc) &&
    /install -o root -g root -m 0440 "\$SUDOERS_STAGE" "\/etc\/sudoers\.d\/90-\$USER_NAME"/
      .test(bootstrapSrc),
  'bootstrap.sh no longer grants the workspace user passwordless sudo, so agents on this ' +
    'box cannot install a browser, a compiler, or anything else that lives in a package — ' +
    'see AGENTS.md "The box you are on" before deciding that is what you want',
);
ok(
  /^sudo -l -U "\$USER_NAME" \| grep -q 'NOPASSWD: ALL'$/m.test(bootstrapSrc),
  'bootstrap.sh does not verify the grant took effect, so a deploy would report success ' +
    'over an account that still cannot install anything',
);
/*
 * Sudo was necessary and not sufficient for the case that prompted it. Playwright's
 * `install-deps` only knows apt and exits 127 on AL2023, and `chromium` is not in the
 * repos, so the RPM names had to be recovered from `ldd` one NOT_FOUND at a time —
 * which is a wall with a door in it rather than no door, and still not something to
 * make every agent walk. These are in the optional `|| echo` group, so a rename in the
 * repos cannot fail provisioning; this checks they are asked for at all.
 */
for (const lib of ['nss', 'mesa-libgbm', 'libXdamage', 'libxkbcommon', 'at-spi2-atk']) {
  ok(
    new RegExp(`(^|\\s)${lib}(\\s|\\\\)`).test(bootstrapSrc),
    `bootstrap.sh no longer installs ${lib}, so a headless browser on a fresh instance ` +
      'fails to start and the error names a shared object rather than a package',
  );
}

section('And the chat app leaves the projects alone, which is the other half of it:');
/*
 * A path per project was necessary and still not sufficient, because the chat app
 * scoped itself to `/` and a path under `/` is inside it. An installed web app claims
 * every URL in its scope, so one chat icon on the home screen claimed every project,
 * and Chrome answered each project install after it with "already installed" — the
 * same symptom the per-project paths were meant to end, arriving from the other
 * direction. Hence /chat/, and hence this: the two scopes must not overlap, and
 * nothing here can tell that they do by looking at either file alone.
 */
ok(base.scope !== '/', 'the chat app claims the whole origin again, so no project can be installed beside it');
ok(
  !projectWindowPath('demo').startsWith(base.scope),
  'a project path falls inside the chat app’s scope, so the chat icon claims it and ' +
    'Chrome refuses the install as "already installed"',
);
ok(
  !base.scope.startsWith(projectWindowPath('demo')),
  'the chat app falls inside a project’s scope, which is the same collision upside down',
);
ok(
  base.start_url.startsWith(base.scope),
  'the chat app starts outside its own scope, so the browser discards that scope and ' +
    'falls back to one derived from start_url',
);
/*
 * `id` is explicit for one reason: absent, it defaults to start_url, and start_url
 * just moved. A changed id is a different application, so every phone with the chat
 * icon already on it would keep a dead one and install a second beside it rather than
 * updating the one it has.
 */
ok(base.id === '/', 'the chat app’s id is not pinned to where it used to start, so moving it orphans every installed icon');
/*
 * Shortcut URLs have to be inside the scope too. A browser drops an out-of-scope
 * shortcut without saying so, so the failure is a menu item that quietly stops
 * existing — which is why /chat/editor/ exists as a route at all.
 */
for (const s of base.shortcuts ?? []) {
  ok(
    s.url.startsWith(base.scope),
    `the "${s.name}" shortcut points outside the chat app’s scope, so the browser drops it`,
  );
}

section('A name that cannot be a directory cannot be a manifest:');
for (const bad of ['../etc', 'a/b', '.hidden', '', 'has space']) {
  let refused = false;
  try {
    await manifestForProject(bad);
  } catch {
    refused = true;
  }
  ok(refused, `"${bad}" was accepted as a project name`);
}

section('A manifest is only minted for a project that exists:');
let code = null;
try {
  await manifestForProject('never-created');
} catch (err) {
  code = err.code;
}
ok(
  code === 'ENOPROJECT',
  'a missing project did not report itself as missing, so the route cannot answer 404',
);

section('The builder needs no filesystem, so the route can be reasoned about:');
const pure = projectManifest({ project: 'p', path: '/workspace/projects/p' });
ok(pure.id === '/p/p/', 'the project name is not the id');
ok(
  pure.start_url === '/p/p/?folder=%2Fworkspace%2Fprojects%2Fp',
  'the folder is not encoded into the start_url',
);

section('The path a manifest hands out is a real route, gated like the editor it is:');
/*
 * This file mints URLs that only nginx can answer, and the two live in different
 * languages in different directories: change `projectWindowPath` and every icon on
 * every phone points at a path the server does not route, which lands on the
 * catch-all as a path code-server has never heard of. An installed icon that opens
 * an error page is not something a test suite should be able to miss.
 *
 * The upstream is compared against /editor/'s rather than named, because that is the
 * property that matters: a project path that reached anything else, or reached
 * code-server by some other door, would be a shell on this box for whoever found it.
 *
 * What gates that door depends on the mode. In password mode it is code-server's own
 * password check and nothing in nginx. In oidc mode nginx additionally asks auth.js
 * who the caller is, through `auth_request` — still a delegation, never a decision
 * taken in the proxy. The check for that is at the bottom of this file, and it is
 * written over every route that reaches code-server rather than over a list, because
 * the bug it exists for was a route nobody remembered to add to a list.
 */
const nginx = fs.readFileSync(path.join(root, 'infra', 'userdata', 'bootstrap.sh'), 'utf8');
const blockFor = (pattern) =>
  new RegExp(`\\n\\s*location\\s+(${pattern})\\s*\\{\\n([\\s\\S]*?)\\n    \\}\\n`).exec(nginx);
const route = blockFor('[^\\n{]*/p/[^\\n{]*?');
ok(
  route,
  'nginx routes nothing under /p/, so every project icon opens on a path the server ' +
    'does not serve',
);
// bootstrap.sh writes the config through a shell heredoc, so every nginx `$` is
// escaped for the shell and has to be put back before the pattern means anything.
const unescapeConf = (text) => text.replace(/\\\$/g, '$');
const matcher = new RegExp(unescapeConf(route?.[1] ?? '$.^').replace(/^~\s*/, ''));
const body = route?.[2] ?? '';
ok(
  matcher.test(projectWindowPath('demo')),
  'the route does not match the path this file hands out — the manifest and nginx have drifted',
);
ok(
  matcher.test(projectWindowPath('demo').replace(/\/$/, '')),
  'the route needs the trailing slash, so the same app has two addresses and one of them 404s',
);
/*
 * And that redirect has to be path-only. nginx listens on the app port behind the
 * load balancer that terminates TLS, so left to build an absolute Location it names
 * what it can see: http://<your-host>:8080/p/<name>/ — a scheme and a port
 * that are not reachable from a phone. Found in production, on the live route, by
 * following the slashless form through the domain rather than through localhost.
 */
ok(
  /absolute_redirect\s+off;/.test(body) && /port_in_redirect\s+off;/.test(body),
  'the project route builds absolute redirects, so the slashless form sends a phone to ' +
    'the port nginx listens on instead of the one the world speaks to',
);
ok(!matcher.test('/p/../etc/'), 'the route accepts a name that is not a name');
/*
 * Below a project, too, and that is not tidiness. code-server answers a request it
 * has no password cookie for with a *relative* redirect — `Location: ./login?…` —
 * which the browser resolves against this path and asks for /p/<name>/login. A route
 * that only matched the project's own path would answer that with the catch-all, and
 * code-server does not know its own login page under that name: 404 on the first
 * launch of an icon whose session has lapsed, which is the whole feature failing on
 * the one day it is used.
 *
 * So the prefix has to be stripped, exactly as /editor/ strips its own, and what
 * comes out the other side is what code-server sees. The rewrite is read out of the
 * config and applied here rather than eyeballed, because "it forwards *something*"
 * is not the property that matters.
 */
ok(
  matcher.test('/p/demo/login'),
  'the route stops at a project’s own path, so code-server’s relative redirect to ' +
    './login lands on the catch-all as a path it has never heard of',
);
const rewrite = /(?:^|\n)\s*rewrite\s+(\S+)\s+(\S+)\s+break;/.exec(body);
ok(rewrite, 'the project route does not strip its prefix, so code-server sees /p/<name>/ as a path');
const strip = (url) =>
  rewrite ? url.replace(new RegExp(unescapeConf(rewrite[1])), unescapeConf(rewrite[2])) : url;
ok(strip('/p/demo/login') === '/login', 'code-server is asked for a login page at a path it does not serve');
ok(strip('/p/demo/') === '/' && strip('/p/demo') === '/', 'a project window does not open the workbench root');
const upstreamOf = (block) => /proxy_pass\s+http:\/\/([^;/\s]+)/.exec(block)?.[1] ?? '';
ok(
  upstreamOf(body) !== '' && upstreamOf(body) === upstreamOf(blockFor('/editor/')?.[2] ?? ''),
  'a project path does not reach the same code-server /editor/ does, so it is gated by ' +
    'whatever that other upstream happens to check, which is not the same question',
);
ok(
  /cmo_head/.test(body),
  'the project window gets no overlay injected, so it opens with no switcher, no mic ' +
    'and no way back',
);

section('And no page serves code-server’s own manifest in a project’s place:');
/*
 * The bug this exists for, and the one the report "it says it's already installed"
 * turned out to be.
 *
 * code-server links a manifest of its own in the head of every page it serves. That
 * file names no `id` and no `scope` — see the route in its own source, which builds
 * it from `start_url: "."` and nothing else — so a browser defaults both to the
 * directory the link resolves in. Which means the identity it describes is decided by
 * the address it is read at, and it is read at the addresses this feature uses:
 *
 *   - on /p/<name>/ it is *this project's* identity, under the name "code-server". An
 *     install accepted there takes the identity the project's own manifest asks for,
 *     so the project can never be installed again — the icon on the home screen is
 *     holding its name, and Android answers every later attempt "already installed"
 *     until it is removed.
 *   - on /editor/ the identity is /editor/, which is the same for every project,
 *     because a scope is a path prefix and the ?folder= that tells them apart is not
 *     part of one. So the first project installed from the editor's own address takes
 *     it and every project after that collides with it. That is the whole of "I
 *     installed the main app and now nothing else will install".
 *
 * The overlay does replace the link (pwa/mobile-overlay.js, linkProjectManifest), and
 * that is not enough on its own: it is a script racing the browser's install check,
 * and it cannot run at all before it loads. So the tag is rewritten in the proxy, and
 * this reads the rule out of the config and applies it to the real HTML rather than
 * trusting that a directive spelled somewhere near the right place matches anything.
 *
 * The literal below is what code-server 4.x emits — from
 * lib/vscode/out/vs/code/browser/workbench/workbench.html, confirmed against the
 * build on the box by fetching a project window through nginx. If a code-server
 * upgrade changes it, this check fails rather than the feature silently regressing.
 */
const codeServerManifestLink =
  '<link rel="manifest" href="./manifest.json" crossorigin="use-credentials" />';
/** The sub_filter rules of a location block, in order, as [search, replace] pairs. */
const subFiltersOf = (block) =>
  [...block.matchAll(/\n\s*sub_filter\s+'([^']*)'\s+'([^']*)'\s*;/g)].map((m) => [
    unescapeConf(m[1]),
    unescapeConf(m[2]),
  ]);
/*
 * `sub_filter_once on` everywhere, so each rule replaces its first match and no more.
 * The location's own captures are filled in from the route regex itself — naming
 * `demo` twice would let the config and the pattern disagree about which group holds
 * the project.
 */
const routeCaptures = matcher.exec(projectWindowPath('demo'))?.groups ?? {};
const applySubFilters = (block, html) =>
  subFiltersOf(block).reduce(
    (text, [search, replace]) =>
      text.replace(
        search,
        replace.replace(/\$\{?(\w+)\}?/g, (whole, name) => routeCaptures[name] ?? whole),
      ),
    html,
  );
for (const [name, block] of [
  ['the project route', body],
  ['/editor/', blockFor('/editor/')?.[2] ?? ''],
  ['the catch-all', blockFor('/')?.[2] ?? ''],
]) {
  ok(
    applySubFilters(block, codeServerManifestLink) !== codeServerManifestLink,
    `${name} passes code-server’s own manifest link through untouched, so a phone can ` +
      'install an app that holds a project’s identity under code-server’s name',
  );
}
const projectLink = applySubFilters(body, codeServerManifestLink);
ok(
  /rel="manifest"/.test(projectLink),
  'the project route strips the manifest link instead of pointing it at the project, ' +
    'so a project window has nothing to install',
);
ok(
  /href="([^"]*)"/.exec(projectLink)?.[1] === '/chat/manifest.webmanifest?project=demo',
  'the project route points the manifest link somewhere other than this project’s ' +
    'manifest — the route serving it is in chat-service/server.js and the same URL is ' +
    'built in pwa/mobile-overlay.js',
);
ok(
  /crossorigin="use-credentials"/.test(projectLink),
  'the rewritten link lost use-credentials, so the manifest is fetched without the ' +
    'session cookie and the server answers 401 to the one request that decides ' +
    'whether this is installable',
);
for (const [name, block] of [
  ['/editor/', blockFor('/editor/')?.[2] ?? ''],
  ['the catch-all', blockFor('/')?.[2] ?? ''],
]) {
  ok(
    !/rel="manifest"/.test(applySubFilters(block, codeServerManifestLink)),
    `${name} still offers an installable app, and it is not a project’s: every project ` +
      'reached through it shares one identity, so only the first of them installs',
  );
}

section('And the two addresses the chat app’s move depends on:');
/*
 * Moving the chat app to /chat/ left the bare domain with nothing to serve, and a
 * bare domain is what people type and what every old bookmark and installed icon
 * points at. It also cannot simply serve the shell in place: an install is only
 * offered from a page inside the scope of the manifest it links, so a chat app served
 * at `/` while scoped to /chat/ is one nobody can add to a home screen. The redirect
 * is what makes the move survive contact with a phone, and it lives in another
 * language in another directory from the manifest that needs it.
 */
const rootRoute = blockFor('= /');
ok(rootRoute, 'nginx no longer routes the bare domain, so / falls through to code-server’s catch-all');
const rootBody = rootRoute?.[2] ?? '';
const rootRedirect = /return\s+30[12]\s+(\S+);/.exec(rootBody);
ok(
  rootRedirect && rootRedirect[1].startsWith(base.scope),
  'the bare domain does not send you into the chat app’s scope, so the app it links ' +
    'cannot be installed from the page most people arrive on',
);
ok(
  /absolute_redirect\s+off;/.test(rootBody) && /port_in_redirect\s+off;/.test(rootBody),
  'the bare domain builds an absolute redirect, so it names the port nginx listens on ' +
    'behind the load balancer instead of the one the world speaks to',
);
/*
 * And the shortcut target. /chat/editor/ is inside the scope so the browser keeps the
 * shortcut; without an exact-match route of its own it would fall to the /chat/ prefix
 * and be asked of the chat service, which has never served an editor.
 */
const shortcutRoutes = (base.shortcuts ?? [])
  .map((s) => s.url.split('?')[0])
  .filter((url) => url !== base.start_url);
for (const url of shortcutRoutes) {
  const exact = blockFor(`= ${url}`);
  ok(
    exact && /return\s+30[12]\s+\S+;/.test(exact[2]),
    `nginx has no route for the ${url} shortcut, so the menu item opens a page the chat ` +
      'service does not serve',
  );
}

/*
 * One trap in writing that config, met twice while writing this route: the nginx
 * block is a *shell* heredoc with no quoting on the delimiter, so an unescaped
 * backtick in it is command substitution — run as root, at boot, on the instance,
 * with its output pasted into the config. The two that were there ate the words out
 * of an nginx comment and printed "command not found" into the userdata log, which is
 * harmless and is also the benign version of it.
 */
const heredoc = /cat > \/etc\/nginx\/conf\.d\/claude-web\.conf <<NGINXCONF\n([\s\S]*?)\nNGINXCONF\n/.exec(
  nginx,
)?.[1];
ok(heredoc, 'the nginx config is no longer written by the heredoc this checks');
ok(
  !/(^|[^\\])`/.test(heredoc ?? '`'),
  'an unescaped backtick in the nginx heredoc: the shell will run it as root at boot ' +
    'and paste the output into the config',
);

/*
 * And every door into the workbench asks who is knocking.
 *
 * This is the check that was missing on 2026-09-19, when the deployment moved to
 * oidc and the editor did not move with it. code-server's password proves someone
 * knows a shared secret; it says nothing about which identity holds it. The load
 * balancer in front authenticates any account the provider will vouch for — with
 * Google, every account that exists — so "any Google account plus the code-server
 * password" was a full IDE with a terminal, held by an identity that was never on
 * oidc.allowedEmails. The chat was never exposed, because every chat request goes
 * through auth.js. The editor simply never went through auth.js at all.
 *
 * So the invariant is about *coverage*, not about any one route: anything that can
 * reach code-server has to carry the gate. Written this way on purpose — it fails
 * for a location added later, which is the case a list of three known paths would
 * quietly miss.
 */
const locationBlocks = [
  ...(heredoc ?? '').matchAll(/\n    location\s+([^\n{]+?)\s*\{\n([\s\S]*?)\n    \}/g),
].map(([, where, body]) => ({ where: where.trim(), body }));
ok(locationBlocks.length > 0, 'no nginx location blocks parsed, so the checks below prove nothing');

const workbenchRoutes = locationBlocks.filter((l) => /127\.0\.0\.1:9999/.test(l.body));
ok(
  workbenchRoutes.length > 0,
  'no route reaches code-server, so either the editor is unreachable or this check has ' +
    'stopped looking at the right thing',
);
for (const { where, body } of workbenchRoutes) {
  ok(
    body.includes('$IDENTITY_GATE'),
    `nginx location "${where}" reaches code-server without $IDENTITY_GATE — in oidc mode ` +
      'that is a shell on this box for any identity the provider will authenticate',
  );
}

// And the gate has to be the delegation it claims to be: a 2xx/401 answer from
// auth.js, not a second opinion formed in the proxy.
ok(
  /IDENTITY_GATE="auth_request \/__identity;"/.test(nginx),
  'the identity gate is no longer auth_request /__identity, so the locations above carry ' +
    'a directive that does nothing',
);
ok(
  /if \[ "\$AUTH_MODE" = "oidc" \]/.test(nginx),
  'the gate is no longer conditional on oidc mode: in password mode this locks out anyone ' +
    'who uses the editor and never opens the chat',
);
const identity = blockFor('= /__identity');
ok(identity, 'no /__identity location, so auth_request has nothing to ask and every gated route 500s');
ok(
  /\binternal;/.test(identity?.[2] ?? ''),
  '/__identity is not internal, so a client can call the gate directly',
);
ok(
  /proxy_pass http:\/\/127\.0\.0\.1:9997\/api\/auth-check;/.test(identity?.[2] ?? ''),
  'the gate does not ask chat-service/auth.js, which is the only thing here that knows who ' +
    'is allowed',
);

// The health check must stay outside the gate, or the ALB marks its own target
// unhealthy and serves 503 to everyone — including the allowlisted caller.
const health = blockFor('= /healthz');
ok(
  health && !health[2].includes('$IDENTITY_GATE'),
  'the health check is behind the identity gate, so the load balancer will fail its own ' +
    'target and take the whole site down',
);

/*
 * And guessing the password is slowed down on every spelling of the login, not
 * just the one the limit was written next to.
 *
 * `limit_req` used to hang off `location = /api/login`, which meant
 * /chat/api/login was not limited at all: the /chat/ prefix strips to the same
 * handler through a location that had no limit, so twenty rapid guesses reached
 * Node where /api/login stopped at six. Same shape as the editor bug above — a
 * control attached to a location, and a second location reaching the same thing.
 * So the key is the path now, and this checks the key covers every prefix that
 * strips, derived from the config rather than listed.
 */
const conf = unescapeConf(nginx);
const loginMap = /map \$uri \$login_attempt \{\n([\s\S]*?)\n\}/.exec(conf);
ok(
  loginMap,
  'the login throttle is no longer keyed on a map over $uri, so it is back to being ' +
    'scoped to whichever location happens to carry it',
);
ok(
  /^\s*default\s+"";/m.test(loginMap?.[1] ?? ''),
  'the login throttle map has a non-empty default, so nginx now counts ordinary chat ' +
    'traffic against the login rate and a busy session will 429 itself',
);
const mapped = new Set(
  [...(loginMap?.[1] ?? '').matchAll(/^\s*(\S+)\s+\$binary_remote_addr;/gm)].map((m) => m[1]),
);
ok(mapped.has('/api/login'), 'the login endpoint itself is not in the throttle map');

/*
 * Applied at the server, so every location inherits it. A location that declares
 * its own limit_req replaces the inherited one rather than adding to it, which is
 * how a route silently stops being throttled.
 *
 * The zone name is read from the declaration rather than written here twice. It has
 * to change whenever the key changes — nginx refuses a reload that redefines a
 * shared memory zone's key under the same name, keeps serving the old config and
 * reports success (see the gotcha in AGENTS.md) — so the rename is a step someone
 * will do in one place and forget in the other.
 */
const zoneName = /limit_req_zone \$login_attempt zone=([A-Za-z0-9_]+):/.exec(conf)?.[1];
ok(zoneName, 'the login throttle zone is not declared against the $login_attempt key');
ok(
  new RegExp(`\\n    limit_req zone=${zoneName ?? '$.^'} `).test(unescapeConf(heredoc ?? '')),
  `limit_req zone=${zoneName} is not applied at the server level, so either nothing ` +
    'inherits the throttle or it names a zone that is not the one keyed on the path',
);
const ownLimit = locationBlocks.filter((l) => /limit_req\s/.test(l.body)).map((l) => l.where);
ok(
  ownLimit.length === 0,
  `nginx location(s) ${ownLimit.join(', ')} declare their own limit_req, which replaces ` +
    "the server's rather than adding to it — the login throttle stops applying there",
);

/*
 * Any location that proxies to the chat service with a bare trailing slash strips
 * its prefix, so the path the world asks for and the path auth.js sees differ —
 * and the throttle is keyed on the former. Each such prefix therefore needs its
 * own spelling of the login in the map. Today that is /chat/; the point of
 * deriving it is the next one.
 */
const stripping = locationBlocks.filter((l) =>
  /proxy_pass\s+http:\/\/127\.0\.0\.1:9997\/;/.test(l.body),
);
ok(
  stripping.length > 0,
  'no location strips a prefix to the chat service, so either the routing changed or ' +
    'this check has stopped finding it',
);
for (const { where } of stripping) {
  ok(
    /^\/[^\s{}]*\/$/.test(where),
    `nginx location "${where}" strips a prefix to the chat service but is not a plain ` +
      'prefix, so the login path behind it cannot be derived — add it to the map by hand',
  );
  const alias = `${where}api/login`;
  ok(
    mapped.has(alias),
    `${alias} reaches the login handler but is not in the throttle map, so password ` +
      'guessing through that prefix is unlimited at the edge',
  );
}

// The backtick check above covers the nginx heredoc; this one is written the same
// way and is the same trap, so it gets the same check. Both are unquoted heredocs
// run as root at boot.
const realip = /cat > \/etc\/nginx\/conf\.d\/00-realip\.conf <<REALIP\n([\s\S]*?)\nREALIP\n/.exec(
  nginx,
)?.[1];
ok(realip, 'the realip/limit config is no longer written by the heredoc this checks');
ok(
  !/(^|[^\\])`/.test(realip ?? '`'),
  'an unescaped backtick in the realip heredoc: the shell will run it as root at boot ' +
    'and paste the output into the config',
);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
