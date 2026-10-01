import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { openLog, readEvents } from '../src/events.mjs';
import { estimate, fold, progressLine } from '../src/progress.mjs';

const items = (count, expected) =>
	Array.from({ length: count }, (_, index) => ({
		key: `dark/story-${index}`,
		id: `story-${index}`,
		theme: 'dark',
		expected,
	}));

test('folds a capture: begin, retry, shot, fail, end', () => {
	const state = fold([
		{ t: 0, type: 'start', kind: 'capture', total: 3, items: items(3) },
		{ t: 10, type: 'begin', key: 'dark/story-0' },
		{ t: 20, type: 'phase', key: 'dark/story-0', phase: 'settle' },
		{ t: 30, type: 'retry', key: 'dark/story-0', error: 'timeout' },
		{ t: 40, type: 'begin', key: 'dark/story-0' },
		{
			t: 50,
			type: 'shot',
			key: 'dark/story-0',
			status: 'ok',
			duration: 10,
			files: ['dark/story-0.png'],
		},
		{ t: 60, type: 'begin', key: 'dark/story-1' },
		{ t: 70, type: 'fail', key: 'dark/story-1', error: 'boom', duration: 10 },
	]);
	assert.equal(state.status, 'running');
	assert.deepEqual(
		{ ok: state.counts.ok, failed: state.counts.failed, retries: state.counts.retries },
		{ ok: 1, failed: 1, retries: 1 },
	);
	assert.equal(state.items['dark/story-0'].status, 'ok');
	assert.equal(state.items['dark/story-2'].status, 'queued');
	assert.deepEqual(Object.keys(state.active), []);
	assert.equal(state.completed.length, 2);
	fold([{ t: 80, type: 'end', status: 'done' }], state);
	assert.equal(state.status, 'done');
	assert.equal(estimate(state, 1000).eta, 0);
});

test('prices what is left by history, scaled by how this run compares', () => {
	const events = [{ t: 0, type: 'start', kind: 'capture', total: 10, items: items(10, 1000) }];
	// Four finished at twice their history, two at a time: 4 x 2000 ms over 4 s.
	for (let index = 0; index < 4; index += 1) {
		const t = 1000 + index * 1000;
		events.push({ t: t - 2000, type: 'begin', key: `dark/story-${index}` });
		events.push({ t, type: 'shot', key: `dark/story-${index}`, status: 'ok', duration: 2000 });
	}
	const state = fold(events);
	state.started = -3000;
	const now = 4000;
	const e = estimate(state, now);
	assert.ok(Math.abs(e.scale - 2) < 1e-9);
	// 8000 ms of work over 7 s is one story at a time: six left at 2000 ms each.
	assert.equal(Math.round(e.eta), 12000);
	assert.equal(e.remaining, 6);
	assert.match(progressLine(state, now), /4\/10 40\.0%/);
});

test('with nothing finished, the pages open set the parallelism', () => {
	const events = [{ t: 0, type: 'start', kind: 'capture', total: 20, items: items(20) }];
	for (let index = 0; index < 10; index += 1) {
		events.push({ t: 100, type: 'begin', key: `dark/story-${index}` });
	}
	const e = estimate(fold(events), 1000);
	assert.equal(e.parallelism, 10);
	assert.equal(e.confidence, 'rough');
});

test('a long story left alone at the end sets the finish', () => {
	const events = [
		{
			t: 0,
			type: 'start',
			kind: 'capture',
			total: 4,
			historyParallelism: 4,
			items: [
				{ key: 'dark/a', id: 'a', expected: 60_000 },
				{ key: 'dark/b', id: 'b', expected: 1000 },
				{ key: 'dark/c', id: 'c', expected: 1000 },
				{ key: 'dark/d', id: 'd', expected: 1000 },
			],
		},
	];
	const state = fold(events);
	// Four slots and 63 s of work: work over slots says 16 s, the story says 60.
	assert.equal(Math.round(estimate(state, 0).eta), 60_000);
});

test('readEvents leaves a torn last line for the next read', () => {
	const dir = mkdtempSync(path.join(import.meta.dirname, '.tmp-'));
	try {
		const file = path.join(dir, 'events.ndjson');
		const log = openLog(file);
		log.emit('start', { total: 1 });
		log.close();
		appendFileSync(file, '{"t":1,"type":"sh');
		const first = readEvents(file);
		assert.equal(first.events.length, 1);
		appendFileSync(file, 'ot"}\n');
		const second = readEvents(file, first.offset);
		assert.deepEqual(
			second.events.map((event) => event.type),
			['shot'],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
