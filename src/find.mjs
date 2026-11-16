import { existsSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { KINDS } from './workspace.mjs';

/** Directories a search never enters: dependencies, git data, and caches of other tools. */
const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', '.pnpm-store', '.cache', '.next']);

/** Whether a directory holds runs or diffs of sbshot. */
export const isWorkspace = (dir) =>
	Object.values(KINDS).some((sub) => existsSync(path.join(dir, sub)));

/**
 * The workspaces under each path, by real path, sorted. A path that is a
 * workspace itself counts as one, whatever its name. Under any other path
 * the search looks for directories named `.sbshot` (a workspace with another
 * name is found only when given), skips dependencies, `.git` and other
 * hidden directories, and does not go below `depth` levels or into a
 * workspace it found.
 */
export const findWorkspaces = async (paths, { depth = 6 } = {}) => {
	const found = new Set();
	const walk = async (dir, level) => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		await Promise.all(
			entries
				.filter((entry) => entry.isDirectory() && !SKIP.has(entry.name))
				.map(async (entry) => {
					const full = path.join(dir, entry.name);
					if (entry.name === '.sbshot') {
						if (isWorkspace(full)) found.add(await realpath(full));
						return;
					}
					if (!entry.name.startsWith('.') && level < depth) {
						await walk(full, level + 1);
					}
				}),
		);
	};
	for (const given of paths) {
		const dir = path.resolve(given);
		if (!(await stat(dir).catch(() => null))?.isDirectory()) {
			throw new Error(`${given}: not a directory`);
		}
		if (isWorkspace(dir)) {
			found.add(await realpath(dir));
		} else {
			await walk(dir, 1);
		}
	}
	return [...found].sort();
};
