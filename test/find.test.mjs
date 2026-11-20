import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { findWorkspaces } from '../src/find.mjs';

test('findWorkspaces finds .sbshot folders, skips dependencies and hidden folders', async () => {
	const root = realpathSync(mkdtempSync(path.join(import.meta.dirname, '.tmp-')));
	const dir = (...parts) => mkdirSync(path.join(root, ...parts), { recursive: true });
	try {
		dir('a/.sbshot/runs');
		dir('b/frontend/.sbshot/diffs');
		dir('c/.sbshot'); // empty: no runs or diffs, not a workspace
		dir('d/node_modules/x/.sbshot/runs');
		dir('e/.hidden/.sbshot/runs');
		dir('f/1/2/3/4/5/6/7/.sbshot/runs'); // past the depth
		dir('named/runs');

		assert.deepEqual(await findWorkspaces([root]), [
			path.join(root, 'a/.sbshot'),
			path.join(root, 'b/frontend/.sbshot'),
		]);
		// A workspace given by path counts whatever its name.
		assert.deepEqual(await findWorkspaces([path.join(root, 'named')]), [path.join(root, 'named')]);
		await assert.rejects(findWorkspaces([path.join(root, 'missing')]), /not a directory/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
