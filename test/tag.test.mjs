import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { tag } from '../src/commands/tag.mjs';
import { matchPairs, readTags } from '../src/review.mjs';

const files = ['dark/a--one.png', 'light/a--one.png', 'dark/a--two.png', 'dark/b--one.png'];

test('a pattern names a file, every theme of a story id, or a glob of either', () => {
	assert.deepEqual(matchPairs(files, ['dark/a--two.png']).matched, ['dark/a--two.png']);
	assert.deepEqual(matchPairs(files, ['a--one']).matched, ['dark/a--one.png', 'light/a--one.png']);
	assert.deepEqual(matchPairs(files, ['*--one']).matched, [
		'dark/a--one.png',
		'light/a--one.png',
		'dark/b--one.png',
	]);
	assert.deepEqual(matchPairs(files, ['a--o', 'b--one']).unmatched, ['a--o']);
});

test('sbshot tag adds, notes, removes, and writes nothing for a typo', async () => {
	const workspace = mkdtempSync(path.join(import.meta.dirname, '.tmp-'));
	const dir = path.join(workspace, 'diffs/base--after');
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		path.join(dir, 'diff.json'),
		JSON.stringify({ results: files.map((file) => ({ file, changed: 1 })) }),
	);
	const run = (...args) => tag(['--workspace', workspace, 'base--after', ...args]);
	try {
		assert.equal(
			await run('fixed', 'a--one', '--theme', 'dark', '--note', 'now under the drawer'),
			0,
		);
		assert.equal(await run('fixed', 'b--one'), 0);
		assert.deepEqual(readTags(dir).fixed, {
			note: 'now under the drawer',
			files: ['dark/a--one.png', 'dark/b--one.png'],
		});

		assert.equal(await run('fixed', 'a--two', 'nope'), 1);
		assert.equal(readTags(dir).fixed.files.length, 2);

		assert.equal(await run('fixed', '--remove', 'b--one'), 0);
		assert.deepEqual(readTags(dir).fixed.files, ['dark/a--one.png']);
		assert.equal(await run('fixed', '--remove'), 0);
		assert.deepEqual(readTags(dir), {});

		assert.equal(await run('dark,wide', 'dark/*', '--note', 'dark mode'), 0);
		assert.deepEqual(Object.keys(readTags(dir)), ['dark', 'wide']);
		assert.deepEqual(readTags(dir).wide, {
			note: 'dark mode',
			files: ['dark/a--one.png', 'dark/a--two.png', 'dark/b--one.png'],
		});
		assert.equal(await run('dark,bad name', 'a--one'), 1);
		assert.equal(await run('dark,wide', '--remove', 'dark/a--two.png'), 0);
		assert.equal(readTags(dir).dark.files.length, 2);
		assert.equal(readTags(dir).wide.files.length, 2);
		assert.equal(await run('dark,wide', '--remove'), 0);
		assert.deepEqual(readTags(dir), {});
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});
