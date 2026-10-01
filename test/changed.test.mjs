import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { changedStoryFiles } from '../src/changed.mjs';

const put = (file, content = '') => {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
};

const git = (cwd, ...args) =>
	spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });

test('changed-since walks sibling packages, root lockfiles and extra globs', async () => {
	const root = mkdtempSync(path.join(import.meta.dirname, '.tmp-'));
	const project = path.join(root, 'apps/web');
	const stats = path.join(project, 'preview-stats.json');
	try {
		put(path.join(root, 'yarn.lock'));
		put(path.join(root, 'packages/ui/button.ts'));
		put(path.join(project, '.storybook/preview.js'));
		put(path.join(project, 'src/page.ts'));
		put(path.join(project, 'src/theme.css'));
		put(path.join(project, 'src/page.stories.tsx'));
		put(
			stats,
			JSON.stringify({
				modules: [
					{ name: './../../packages/ui/button.ts', reasons: [{ moduleName: './src/page.ts' }] },
					{ name: './src/page.ts', reasons: [{ moduleName: './src/page.stories.tsx' }] },
					{ name: './src/page.stories.tsx', reasons: [] },
				],
			}),
		);
		git(root, 'init', '-q');
		git(root, 'add', '.');
		git(root, 'commit', '-qm', 'base');
		// Reached through a symlink, the way `.agent` or a linked checkout is.
		symlinkSync(root, `${root}-link`);
		const cwd = path.join(`${root}-link`, 'apps/web');
		const reach = (globs) => changedStoryFiles({ ref: 'HEAD', stats, cwd, globs });

		put(path.join(root, 'packages/ui/button.ts'), 'changed');
		assert.deepEqual([...(await reach()).files], ['./src/page.stories.tsx']);

		put(path.join(project, 'src/theme.css'), 'changed');
		assert.equal((await reach()).files.size, 1);
		assert.equal((await reach(['src/*.css'])).reason, 'src/theme.css');

		put(path.join(root, 'yarn.lock'), 'changed');
		assert.equal((await reach()).reason, '../../yarn.lock');
	} finally {
		rmSync(`${root}-link`, { force: true });
		rmSync(root, { recursive: true, force: true });
	}
});
