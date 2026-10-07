import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Files outside the module graph that still reach every story: the preview
 * config, the static dirs, and the project's own build and TypeScript config.
 * Paths are relative to the Storybook project root.
 */
const GLOBAL = [/^\.storybook\//, /^public\//, /^package\.json$/, /^vite\.config\./, /^tsconfig/];

/**
 * Lockfiles change the installed dependencies, which reach every story. A
 * workspace keeps its one lockfile at the root, so one in the project or in
 * any directory above it counts.
 */
const LOCKFILE =
	/^(\.\.\/)*(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?)$/;

const git = (args, cwd) => {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
	}
	return result.stdout.split('\n').filter(Boolean);
};

/**
 * The story files a change since `ref` can reach, walking the importers
 * recorded in a `storybook build --stats-json` from each changed file up to
 * the stories. The same idea as Chromatic's TurboSnap. Returns `null` when the
 * change reaches the preview itself, which every story renders through.
 *
 * `cwd` is the Storybook project root: changed paths and module names are
 * both relative to it, so a file in a sibling workspace package reads
 * `../ui/src/button.tsx` (`./../ui/src/button.tsx` in the module graph). A
 * change to a file matching one of `globs` (also relative to `cwd`) reaches
 * every story, on top of the built-in list.
 */
export const changedStoryFiles = async ({ ref, stats, cwd, globs = [] }) => {
	// Paths from git are relative to the repository root. The project's own
	// place in it comes from git too, since a symlink on the way to `cwd`
	// would throw off a comparison of filesystem paths.
	const [prefix = ''] = git(['rev-parse', '--show-prefix'], cwd);
	const changed = [
		...git(['diff', '--name-only', ref, '--', ':/'], cwd),
		...git(['ls-files', '--others', '--exclude-standard', '--full-name', ':/'], cwd),
	].map((file) => path.posix.relative(prefix, file));
	const reachesAll = (file) =>
		GLOBAL.some((re) => re.test(file)) ||
		LOCKFILE.test(file) ||
		globs.some((glob) => path.matchesGlob(file, glob));
	const touched = changed.filter(reachesAll);
	if (touched.length) {
		return { files: null, changed, reason: touched[0] };
	}

	const { modules } = JSON.parse(await readFile(stats, 'utf8'));
	const importers = new Map(
		modules.map(({ name, reasons }) => [name, reasons.map(({ moduleName }) => moduleName)]),
	);

	const files = new Set();
	const seen = new Set();
	// Vite names every module from the project root with a leading `./`, one
	// outside it too: `./../ui/src/button.tsx`.
	const pending = changed.map((file) => `./${file}`);
	while (pending.length) {
		const name = pending.pop();
		if (seen.has(name)) {
			continue;
		}
		seen.add(name);

		// The preview imports what every story renders through: the global
		// styles, the decorators, the msw setup. Above a story sits only the
		// builder's own index of stories, which is no dependency of the render.
		if (name.startsWith('./.storybook/')) {
			return { files: null, changed, reason: name.slice(2) };
		}
		if (name.startsWith('/virtual:')) {
			continue;
		}
		if (/\.stories\.[jt]sx?$/.test(name)) {
			files.add(name);
		}
		pending.push(...(importers.get(name) ?? []));
	}

	return { files, changed };
};
