import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { jobState } from '../src/commands/status.mjs';
import { adoptResults, listJobs, resolveJob, validName } from '../src/workspace.mjs';

const put = (file, content = '') => {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
};

test('init links older runs and diffs and reports what it cannot read', async () => {
	const dir = mkdtempSync(path.join(import.meta.dirname, '.tmp-'));
	try {
		put(path.join(dir, 'tokens-before/s00/shots.json'), '{"shots":[]}');
		put(path.join(dir, 'tokens-before/s00/dark/a.png'));
		put(path.join(dir, 'old/diff/diff.json'), '{}');
		put(path.join(dir, 'tokens-diff/s00/dark/a.png'));
		put(path.join(dir, 'sb/iframe.html'));
		put(path.join(dir, 'sb/assets/logo.png'));

		const first = await adoptResults(dir);
		assert.deepEqual(first.linked.map(({ link }) => path.relative(dir, link)).sort(), [
			'diffs/old-diff',
			'runs/tokens-before-s00',
		]);
		assert.equal(readlinkSync(path.join(dir, 'runs/tokens-before-s00')), '../tokens-before/s00');
		assert.deepEqual(first.unreadable, [path.join(dir, 'tokens-diff/s00')]);
		assert.deepEqual(
			listJobs(dir)
				.map((job) => job.kind)
				.sort(),
			['capture', 'diff'],
		);

		const second = await adoptResults(dir);
		assert.equal(second.linked.length, 0);
		assert.equal(second.known.length, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('init links a source folder into another workspace', async () => {
	const dir = mkdtempSync(path.join(import.meta.dirname, '.tmp-'));
	try {
		put(path.join(dir, '.story-shots/before/shots.json'), '{"shots":[]}');
		const workspace = path.join(dir, '.sbshot');
		const { linked } = await adoptResults(path.join(dir, '.story-shots'), workspace);
		assert.deepEqual(
			linked.map(({ link }) => path.relative(workspace, link)),
			['runs/before'],
		);
		assert.equal(readlinkSync(path.join(workspace, 'runs/before')), '../../.story-shots/before');
		assert.equal((await adoptResults(path.join(dir, '.story-shots'), workspace)).linked.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a job named like latest is itself, and only a plain name is looked up', () => {
	const dir = mkdtempSync(path.join(import.meta.dirname, '.tmp-'));
	try {
		put(path.join(dir, 'runs/latest-baseline/sbshot.json'), '{"kind":"capture","started":1}');
		put(path.join(dir, 'runs/newer/sbshot.json'), '{"kind":"capture","started":2}');
		assert.equal(resolveJob(dir, 'latest-baseline'), path.join(dir, 'runs/latest-baseline'));
		assert.equal(resolveJob(dir, 'latest'), path.join(dir, 'runs/newer'));
		assert.equal(resolveJob(dir, 'latest:diff'), null);
		for (const name of ['before', 'a.b', 'x-1']) assert.ok(validName(name), name);
		for (const name of ['.', '..', '.hidden', 'a/b', 'latest', '', undefined]) {
			assert.ok(!validName(name), String(name));
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a capture that died while building reads as interrupted', () => {
	const dir = mkdtempSync(path.join(import.meta.dirname, '.tmp-'));
	try {
		// A pid past any pid_max, so no process has it.
		const meta = { kind: 'capture', status: 'building', pid: 2 ** 30, host: os.hostname() };
		put(path.join(dir, 'sbshot.json'), JSON.stringify(meta));
		put(
			path.join(dir, 'events.ndjson'),
			`${JSON.stringify({ t: 1, type: 'build-start', kind: 'capture' })}\n`,
		);
		assert.equal(jobState(dir).state.status, 'interrupted');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
