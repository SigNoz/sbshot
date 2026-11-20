import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { auditWorkspace, parseAge } from '../src/audit.mjs';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 16);

test('audit keeps new, running, reviewed and compared jobs, and prunes images only', async () => {
	const workspace = realpathSync(mkdtempSync(path.join(import.meta.dirname, '.tmp-')));
	const put = (file, content = Buffer.alloc(5000, 1)) => {
		mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
		writeFileSync(path.join(workspace, file), content);
	};
	const job = (kind, name, ageDays, fields = {}) => {
		const sub = kind === 'capture' ? 'runs' : 'diffs';
		const at = NOW - ageDays * DAY;
		put(
			`${sub}/${name}/sbshot.json`,
			JSON.stringify({ kind, name, status: 'done', started: at, ended: at, ...fields }),
		);
		put(`${sub}/${name}/dark/x.png`);
		put(`${sub}/${name}/${kind === 'capture' ? 'shots' : 'diff'}.json`, '{}');
	};
	const runDir = (name) => path.join(workspace, 'runs', name);
	try {
		job('capture', 'fresh', 1);
		job('capture', 'old', 40);
		job('capture', 'base', 40);
		job('capture', 'after', 40);
		job('diff', 'kept-diff', 40, { base: runDir('base'), after: runDir('after') });
		put('diffs/kept-diff/review.json', JSON.stringify({ 'dark/x.png': { verdict: 'expected' } }));
		job('capture', 'busy', 40, { status: 'done' });
		job('capture', 'gone', 40);
		rmSync(path.join(workspace, 'runs/gone/dark/x.png'));

		const report = await auditWorkspace(workspace, { olderThan: 14 * DAY, keep: 0, now: NOW });
		const byName = Object.fromEntries(report.jobs.map((entry) => [entry.name, entry]));
		assert.equal(byName.fresh.suggest, 'keep');
		assert.match(byName.fresh.reasons.join(), /younger than 14 days/);
		assert.equal(byName['kept-diff'].suggest, 'keep');
		assert.match(byName['kept-diff'].reasons.join(), /reviewed: 1 verdicts/);
		assert.equal(byName.base.suggest, 'keep');
		assert.match(byName.base.reasons.join(), /compared by kept diff kept-diff/);
		assert.deepEqual(byName.base.usedBy, ['kept-diff']);
		assert.equal(byName.old.suggest, 'prune');
		assert.equal(byName.gone.suggest, 'no-images');
		assert.equal(report.counts.prune, 2); // old, busy
		assert.equal(report.frees, byName.old.imageBytes + byName.busy.imageBytes);

		// The command deletes the images and nothing else.
		execFileSync('sh', ['-c', byName.old.commands[0]]);
		assert.equal(existsSync(path.join(runDir('old'), 'dark/x.png')), false);
		assert.equal(existsSync(path.join(runDir('old'), 'shots.json')), true);
		assert.equal(existsSync(path.join(runDir('old'), 'sbshot.json')), true);

		// --include-reviewed lets the reviewed diff, and so its runs, go.
		const all = await auditWorkspace(workspace, {
			olderThan: 14 * DAY,
			keep: 0,
			includeReviewed: true,
			now: NOW,
		});
		const after = Object.fromEntries(all.jobs.map((entry) => [entry.name, entry]));
		assert.equal(after['kept-diff'].suggest, 'prune');
		assert.equal(after.base.suggest, 'prune');
		assert.equal(after.old.suggest, 'no-images');

		// --keep counts the newest jobs of the workspace.
		const kept = await auditWorkspace(workspace, { olderThan: 0, keep: 100, now: NOW });
		assert.equal(kept.counts.prune, 0);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test('parseAge reads days, hours and minutes', () => {
	assert.equal(parseAge('14d'), 14 * DAY);
	assert.equal(parseAge('36h'), 1.5 * DAY);
	assert.equal(parseAge('90m'), DAY / 16);
	assert.equal(parseAge('3'), 3 * DAY);
	assert.equal(parseAge('soon'), null);
});
