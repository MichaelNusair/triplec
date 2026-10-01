/**
 * A web app manifest per project, so a project can be its own window.
 *
 * The problem it solves is an Android one. Chrome gives an installed web app
 * exactly one window — its own documentation says so, in the course of explaining
 * why `launch_handler` defaults differ by platform: "mobile devices only support
 * single clients", while "desktop devices support multiple windows". So on a
 * laptop you can have a window per project and on a phone you cannot, and no
 * amount of JavaScript changes that: there is no API that opens a second window
 * of an installed app.
 *
 * What there *is* is app identity. Per the manifest spec, a manifest whose `id`
 * does not match an installed app "is a description of a distinct application,
 * even if it is served from the same URL as another application" — and a distinct
 * application on Android is a distinct home-screen icon with a task of its own in
 * the recents switcher. Which is the thing that was actually wanted: another
 * window, that looks like another app on the home screen.
 *
 * Identity alone turned out not to be enough, though, and the missing half is
 * `scope`: it is a *path prefix*, matched without the query string, so a set of
 * projects that differ only in `?folder=` are one app to Android whatever their ids
 * say — see projectWindowPath below, which is why /p/<name>/ exists.
 *
 * Nor was a path per project enough on its own, because the chat app's scope was `/`
 * and a path under `/` is still inside it. An installed app claims every URL in its
 * scope, so the chat icon claimed every project, and Chrome answered each project
 * install after it with "already installed". That is why the chat app now starts at
 * /chat/ and scopes itself there — see pwa/manifest.webmanifest, and the redirect
 * from `/` in infra/userdata/bootstrap.sh that keeps the bare domain working.
 *
 * So this hands out one manifest per project, differing in `id`, `start_url`, `scope`
 * and the name on the icon. Same origin, same code, same login, same push
 * subscription — one install per project, once.
 *
 * Everything not project-specific is duplicated from pwa/manifest.webmanifest
 * rather than read out of it, because that file is not in this directory at
 * runtime (deploy.sh copies it into public/) and reaching for it through two
 * different relative paths is worse than one assertion. manifest-test.js compares
 * the two and fails if they drift.
 */
import { stat } from 'fs/promises';
import { projectPathFor } from './session-manager.js';

/** Where the icons live, as the served manifest sees them: nginx puts the chat's assets under /chat/. */
const ICONS = [
  { src: '/chat/pwa-icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/chat/pwa-icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/chat/pwa-icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

const THEME_COLOR = '#141413';

/**
 * What the app calls itself when a deployment has not been given a name of its own.
 *
 * The product's name, and the word every HTML shell writes where it means "this
 * app" — so it is also the word `applyDeploymentName` substitutes. That is the
 * reason it is a constant rather than four string literals: a shell that spells the
 * app's name any other way is a shell the rename silently skips, and the symptom is
 * a deployment that is named everywhere except one page.
 *
 * It must stay in step with `name` in pwa/manifest.webmanifest, which is the base
 * the chat app's manifest is served from; manifest-test.js asserts that it does.
 */
export const APP_NAME = 'TripleC';

/*
 * ---------------------------------------------------------------------------
 * What this deployment calls itself
 * ---------------------------------------------------------------------------
 *
 * One account can run this repository twice — two stacks, two hostnames, two
 * phones' worth of icons that are the same code and not the same workspace. The
 * icons differ (pwa.iconDir, see pwa-icons/README.md); this is the other half, the
 * words. With `pwa.name` set, every title the app puts its own name in becomes
 * "<name>: <project>": the label under a project's home screen icon, the browser
 * tab, the editor's title bar. The chat app, which is not in a project, becomes the
 * name on its own.
 *
 * Empty is the default and means today's behaviour exactly — a project is titled
 * with the project, the chat app is "TripleC". A single deployment has nothing to
 * tell apart, and a prefix would only spend the twelve characters a phone gives a
 * label under an icon.
 */

/**
 * What a name may be, duplicated from PWA_NAME_PATTERN in infra/config.js.
 *
 * Duplicated rather than imported because this process is deployed without
 * `infra/` — and re-checked rather than trusted because what arrives here is an
 * environment variable, not that file. The values below are interpolated into an
 * HTML <title> and serialised into a manifest, so a name from a hand-edited
 * /etc/systemd unit must not be able to carry markup or a quote into either.
 * manifest-test.js compares the two patterns and fails if they drift.
 */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,23}$/;

/** Said once rather than per request: this is a misconfiguration, not an event. */
let warnedAboutName = false;

/**
 * This deployment's name, or '' for a deployment that has not been given one.
 *
 * Read per call rather than at import so the service picks up its environment as
 * the unit sets it, and so a test can name a deployment and un-name it again.
 *
 * A value that does not match NAME_PATTERN is treated as no name at all. Mangling
 * it into something legal would put a name nobody chose under every icon on a
 * phone, which is worse than the default of the app being called what it has always
 * been called.
 */
export function deploymentName() {
  const raw = String(process.env.PWA_NAME || '').trim();
  if (!raw) return '';
  if (NAME_PATTERN.test(raw)) return raw;
  if (!warnedAboutName) {
    warnedAboutName = true;
    console.warn(
      `[manifest] ignoring PWA_NAME ${JSON.stringify(raw)} — a deployment name must be ` +
        'at most 24 characters of letters, digits, spaces, dots, dashes or underscores. ' +
        'Titles will name the project alone. Fix pwa.name in the deployment config.',
    );
  }
  return '';
}

/** A project's title: "<deployment>: <project>", or the project alone when unnamed. */
export function appTitle(project) {
  const name = deploymentName();
  return name ? `${name}: ${project}` : project;
}

/**
 * The label a phone writes under the icon, which is a different job from a title.
 *
 * A tab has room for "<deployment>: <project>" and reads better with the deployment
 * first. `short_name` has no room at all: Android gives a home-screen label about a
 * dozen characters and truncates, and the app drawer sorts on the same string. So the
 * deployment-first order that is right for appTitle is wrong here, and the difference
 * is the whole report this exists for — seven project apps installed on one phone
 * (the journal has the `installed` line for each) all read "personal: …" under seven
 * identical icons, filed together under "p". Which is indistinguishable from the
 * installs having silently failed, and was reported as exactly that: "I only have
 * triplec installed".
 *
 * So the project goes where the characters are, and the deployment follows it for the
 * case the prefix was added for — two deployments' icons for the same project, which
 * would otherwise be the same word twice. The project is still the part that survives
 * truncation, which is the part that has to differ.
 */
export function iconLabel(project) {
  const name = deploymentName();
  return name ? `${project} · ${name}` : project;
}

/**
 * The chat app's own manifest: pwa/manifest.webmanifest, wearing this deployment's
 * name.
 *
 * Taken as an argument rather than read here because that file is not in this
 * directory at runtime — server.js serves it out of public/ and hands it over on
 * the way past. The `id` is deliberately untouched: it is app identity, and renaming
 * an app must not orphan the icon already installed from it.
 *
 * Unnamed deployments get the object back exactly as it came, so the file is served
 * byte for byte as shipped.
 */
export function chatManifest(base) {
  const name = deploymentName();
  if (!name) return base;
  return { ...base, name, short_name: name };
}

/**
 * The same name, in an HTML shell's title.
 *
 * Three shells reach a browser tab — the chat app, the login page, the box page —
 * and each of them writes APP_NAME where it means "this deployment's app". So the
 * word is what gets replaced, which leaves each shell's own phrasing intact:
 * "Sign in — TripleC" becomes "Sign in — <name>" without the server having to know
 * that page's sentence.
 *
 * `<meta name="deployment">` is the one addition rather than a replacement: it is
 * how app.js learns the name, so a tab can read "<name>: <project>" once a project
 * is on screen. It stays empty for an unnamed deployment, which is what the client
 * reads as "prefix nothing".
 */
export function applyDeploymentName(html) {
  const name = deploymentName();
  if (!name) return html;
  const rename = (text) => text.split(APP_NAME).join(name);
  return html
    .replace(/<title>([^<]*)<\/title>/i, (_, title) => `<title>${rename(title)}</title>`)
    .replace(
      /(<meta name="apple-mobile-web-app-title" content=")([^"]*)(")/i,
      (_, before, title, after) => `${before}${rename(title)}${after}`,
    )
    .replace(
      /(<meta name="deployment" content=")([^"]*)(")/i,
      (_, before, _content, after) => `${before}${name}${after}`,
    );
}

/**
 * The path a project's window lives under, which is the whole reason it can be its
 * own app.
 *
 * This segment carries no information — `?folder=` below already names the folder,
 * and nginx forwards the query to code-server without reading it — so it looks
 * redundant and is not. **A manifest's scope is a path prefix, and scope matching
 * ignores the query string.** While every project's start_url was
 * `/editor/?folder=<path>`, every project manifest described an app with the same
 * scope as every other one *and* the same scope as the chat app, so Android had a
 * single installed web app claiming the whole origin and refused every install after
 * the first as "already installed". A differing `id` does not rescue that: on Android
 * the installed WebAPK claims URLs by scope.
 *
 * So a window per project needs a path per project. Hence /p/<name>/, whose only job
 * is to be a scope that nothing else covers. The route is in
 * infra/userdata/bootstrap.sh, which means this cannot be changed by --app-only.
 */
export function projectWindowPath(project) {
  return `/p/${encodeURIComponent(project)}/`;
}

/**
 * The URL a project's window opens on.
 *
 * `?folder=` is code-server's own way to open a workspace, and it stays in the
 * browser's URL rather than being swallowed by the route, because the overlay reads
 * it to know which project it is in — `folder()` in pwa/mobile-overlay.js. nginx
 * forwards the query to code-server unchanged, so the path segment and the query are
 * two views of one fact and this function is what keeps them agreeing.
 */
export function projectStartUrl(project, path) {
  return `${projectWindowPath(project)}?folder=${encodeURIComponent(path)}`;
}

/**
 * The manifest for one project.
 *
 * `short_name` is what Android writes under the icon and truncates, so it leads with
 * the project and nothing else — see iconLabel, which is where the ordering is argued
 * and why it is not appTitle's. `name` is the longer label used in the installer and
 * app info, and it is the one that carries the deployment's name in full, because
 * nothing truncates it.
 *
 * Two deliberate omissions:
 *   - `orientation`. The chat app asks for portrait; a workbench is used in both,
 *     and locking the editor to portrait would make a phone in landscape worse
 *     than the browser it replaced.
 *   - `launch_handler`. The default lets a desktop browser open a second window
 *     of the same project, which is wanted later — pinning `focus-existing` here
 *     would be building the ceiling before the room.
 */
export function projectManifest({ project, path }) {
  const home = projectWindowPath(project);
  const title = appTitle(project);
  return {
    // The path, not the start_url: an id is app identity, and identity should not
    // change if the folder a project lives in ever moves. Nor when the deployment
    // is renamed, which is why the name below is not in here.
    id: home,
    name: `${title} — ${APP_NAME}`,
    short_name: iconLabel(project),
    description: `Claude Code in ${project}, in a window of its own`,
    start_url: projectStartUrl(project, path),
    /*
     * The one field this whole feature turns on. See projectWindowPath: scope is a
     * path prefix compared without the query string, so this must be per-project or
     * every project is the same app to Android and only the first one installs.
     *
     * The cost, accepted deliberately: /login is outside this scope, so the first
     * launch after a lapsed session leaves the app's own window and shows Chrome's
     * toolbar until the redirect back. A scope wide enough to include the login page
     * is a scope wide enough to collide, and a login that looks like a browser beats
     * a project that cannot be installed at all.
     */
    scope: home,
    display: 'standalone',
    background_color: THEME_COLOR,
    theme_color: THEME_COLOR,
    icons: ICONS,
    /*
     * The chat app, declared as a relation so a phone can be asked about it.
     *
     * `navigator.getInstalledRelatedApps()` only answers about applications the
     * current page's manifest declares, and this is the one question worth asking on
     * Android: which installed app does Chrome think this page belongs to? Chrome
     * matches an installed web app to a URL by *scope*, and the chat app claimed `/`
     * — the whole origin, every /p/<name>/ URL here included — until it was moved to
     * /chat/ for exactly that reason. This is how the answer is checked rather than
     * assumed: a phone whose chat icon was installed while the old manifest was live
     * still holds a WebAPK claiming the origin, and it will keep refusing project
     * installs until Chrome updates it or the icon is removed. See explainInstall in
     * pwa/mobile-overlay.js.
     *
     * `prefer_related_applications` is stated rather than left to its default,
     * because it is the one member that would turn this diagnostic into a
     * regression: true tells the browser to offer the related app instead of
     * installing this one.
     */
    related_applications: [{ platform: 'webapp', url: '/chat/manifest.webmanifest' }],
    prefer_related_applications: false,
  };
}

/**
 * Resolve a project name to a manifest, or throw.
 *
 * `projectPathFor` is the same validator the rest of the service uses, so a name
 * that cannot be a directory cannot be a manifest either. The existence check is
 * what stops this from being an oracle for arbitrary names: a manifest is only
 * minted for a project that is really there.
 */
export async function manifestForProject(project) {
  const path = projectPathFor(project); // throws on a name that is not a name
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) {
    const err = new Error('no such project');
    err.code = 'ENOPROJECT';
    throw err;
  }
  return projectManifest({ project, path });
}
