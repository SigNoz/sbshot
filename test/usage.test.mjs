import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { diskUsage, workspaceUsage } from '../src/usage.mjs';

const put = (file, size) => {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, Buffer.alloc(size, 1));
};

test('workspace usage splits the disk by job, adds a build to its run and leaves links out', async () => {
	const root = mkdtempSync(path.join(import.meta.dirname, '.tmp-'));
	const workspace = path.join(root, 'ws');
	try {
		const build = path.join(workspace, 'builds/a');
		put(path.join(workspace, 'runs/a/dark/x.png'), 200_000);
		writeFileSync(
			path.join(workspace, 'runs/a/sbshot.json'),
			JSON.stringify({ kind: 'capture', name: 'a', status: 'done', started: 2, build }),
		);
		put(path.join(build, 'index.json'), 50_000);
		put(`${build}.log`, 10_000);
		put(path.join(workspace, 'builds/orphan/index.json'), 30_000);
		put(path.join(workspace, 'diffs/d/diff.json'), 20_000);
		put(path.join(workspace, '.cache/thumbs/t.jpg'), 5_000);
		put(path.join(workspace, 'ui.log'), 1_000);
		put(path.join(root, 'elsewhere/shots.json'), 40_000);
		mkdirSync(path.join(workspace, 'runs'), { recursive: true });
		symlinkSync(path.join(root, 'elsewhere'), path.join(workspace, 'runs/linked'));

		const measure = workspaceUsage(workspace);
		const usage = await measure();
		const job = (name) => usage.jobs.find((row) => row.name === name);
		const runA = await diskUsage(path.join(workspace, 'runs/a'));
		const buildA = (await diskUsage(build)) + (await diskUsage(`${build}.log`));
		assert.equal(job('a').build, buildA);
		assert.equal(job('a').size, runA + buildA);
		assert.equal(job('linked').linked, true);
		assert.equal(job('linked').size, await diskUsage(path.join(root, 'elsewhere')));
		assert.equal(usage.linked, job('linked').size);
		assert.equal(usage.builds, await diskUsage(path.join(workspace, 'builds/orphan')));
		assert.equal(usage.cache, await diskUsage(path.join(workspace, '.cache')));
		// Everything under the workspace is counted once, the link's target not at all.
		assert.equal(usage.total, await diskUsage(workspace));
		assert.equal(usage.total, usage.runs + usage.diffs + usage.builds + usage.cache + usage.other);

		// A new shot moves the run's size on the next look.
		put(path.join(workspace, 'runs/a/dark/y.png'), 100_000);
		assert.ok((await measure()).jobs.find((row) => row.name === 'a').size > job('a').size);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
