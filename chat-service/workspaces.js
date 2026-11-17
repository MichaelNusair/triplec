/**
 * Workspaces: more than one full clone of a project, each with its own main
 * checkout and its own slots — one per orchestrated task. `mono` is on master with
 * ten slots; `mono · Feature A` is a second clone on feat/a with ten more.
 *
 * A workspace is an ordinary project to everything that names one: a directory
 * under the projects root called `<project>--<slug>`, so its terminals, slots,
 * notifications and auth checks are a project's. What makes it a workspace is this
 * note in its `.git` — never in the tree, so it is nobody's uncommitted change —
 * naming the project it belongs to, its display name, and the branch it was made
 * for. See createWorkspace in session-manager.js.
 */
import { readFile, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { LIMITS } from './limits.js';

// The project's own clone included: five tasks, ten agents each, by default.
/** Clones per repository, counting the original: the deployment's `mux.workspaces`. */
export const MAX_WORKSPACES = LIMITS.workspaces;
const NOTE = 'triplec-workspace.json';

/** A display name as a directory name's tail: "Feature A" is feature-a. */
export function workspaceSlug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export const workspaceDirName = (project, slug) => `${project}--${slug}`;

/** The note, when this checkout is a workspace; null for an ordinary project. */
export async function readWorkspace(path) {
  const gitDir = join(String(path || ''), '.git');
  if (!(await stat(gitDir).catch(() => null))?.isDirectory()) return null;
  try {
    const note = JSON.parse(await readFile(join(gitDir, NOTE), 'utf8'));
    if (typeof note?.parent !== 'string' || typeof note?.name !== 'string') return null;
    return { parent: note.parent, name: note.name, branch: typeof note.branch === 'string' ? note.branch : null };
  } catch {
    return null;
  }
}

export async function writeWorkspace(path, { parent, name, branch = null }) {
  await writeFile(join(path, '.git', NOTE), `${JSON.stringify({ parent, name, branch }, null, 2)}\n`);
}
