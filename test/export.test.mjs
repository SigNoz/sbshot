import assert from 'node:assert/strict';
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import { get } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

import { magick, writesWebp } from '../src/caption.mjs';
import { exportPlan, isExportZip, writeExport, writeZip } from '../src/export.mjs';
import { serve } from '../src/server.mjs';

const put = (file, content = '') => {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
};

/**
 * A PNG cut after its IHDR chunk. Export reads no further to keep a shot as
 * PNG, and ImageMagick 6 refuses to draw one past 16K pixels.
 */
const pngHeader = (width, height) => {
	const header = Buffer.alloc(24);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
	header.writeUInt32BE(13, 8);
	header.write('IHDR', 12);
	header.writeUInt32BE(width, 16);
	header.writeUInt32BE(height, 20);
	return header;
};

/** Two legacy runs and a diff between them: one changed pair, one the same. */
const workspace = () => {
	const root = mkdtempSync(path.join(import.meta.dirname, '.tmp-'));
	for (const run of ['a', 'b']) {
		const dir = path.join(root, 'runs', run);
		put(
			path.join(dir, 'shots.json'),
			JSON.stringify({ shots: [{ file: 'dark/x.png' }, { file: 'dark/y.png' }] }),
		);
		put(path.join(dir, 'dark/x.png'), `${run}x`);
		put(path.join(dir, 'dark/y.png'), 'y');
	}
	const diff = path.join(root, 'diffs', 'a--b');
	put(
		path.join(diff, 'diff.json'),
		JSON.stringify({
			base: path.join(root, 'runs', 'a'),
			after: path.join(root, 'runs', 'b'),
			config: { noise: path.join(root, 'diffs', 'noise') },
			summary: {},
			results: [
				{ file: 'dark/x.png', changed: 5, output: 'dark/x.png' },
				{ file: 'dark/y.png', changed: 0 },
			],
		}),
	);
	put(path.join(diff, 'dark/x.png'), 'diff');
	return root;
};

test('an export holds the changed pairs, their shots, and no local path', async () => {
	const root = workspace();
	try {
		const out = path.join(root, 'site');
		await writeExport(exportPlan(root, [path.join(root, 'diffs', 'a--b')]), out);
		for (const file of [
			'index.html',
			'lib/progress.mjs',
			'files/runs/a/dark/x.png',
			'files/runs/b/dark/x.png',
			'files/diffs/a--b/dark/x.png',
		]) {
			assert.ok(existsSync(path.join(out, file)), file);
		}
		assert.ok(!existsSync(path.join(out, 'files/runs/a/dark/y.png')));
		assert.match(readFileSync(path.join(out, 'index.html'), 'utf8'), /data-static/);
		const jobs = JSON.parse(readFileSync(path.join(out, 'api/jobs.json'), 'utf8'));
		assert.equal(jobs.start, '#/job/diff/a--b');
		const detail = readFileSync(path.join(out, 'api/diff/a--b.json'), 'utf8');
		assert.ok(!detail.includes(root), 'no absolute path');
		assert.equal(JSON.parse(detail).diff.results.length, 1);

		// --all and --runs: every pair, and both runs as pages of their own.
		await writeExport(
			exportPlan(root, [path.join(root, 'diffs', 'a--b')], { all: true, runs: true }),
			out,
		);
		assert.ok(existsSync(path.join(out, 'files/runs/a/dark/y.png')));
		assert.ok(existsSync(path.join(out, 'api/capture/b.json')));

		// A folder that is not an export is never replaced.
		put(path.join(root, 'mine/notes.txt'), 'keep');
		await assert.rejects(
			writeExport(exportPlan(root, [path.join(root, 'runs', 'a')]), path.join(root, 'mine')),
		);
		assert.ok(existsSync(path.join(root, 'mine/notes.txt')));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test(
	'shots go out as lossless WebP, but for one too tall for it',
	{ skip: !writesWebp() && 'no ImageMagick with WebP' },
	async () => {
		const root = workspace();
		try {
			const run = path.join(root, 'runs', 'b');
			magick(['-size', '40x30', 'xc:red', path.join(run, 'dark/x.png')]);
			put(path.join(run, 'dark/y.png'), pngHeader(2, 17000));
			const out = path.join(root, 'site');
			await writeExport(exportPlan(root, [run]), out);
			const differing = magick([
				path.join(run, 'dark/x.png'),
				path.join(out, 'files/runs/b/dark/x.webp'),
				'-metric',
				'AE',
				'-compare',
				'-format',
				'%[distortion]',
				'info:',
			]);
			assert.equal(Number(differing.toString()), 0, 'same pixels');
			assert.equal(
				magick([
					'identify',
					'-format',
					'%m',
					path.join(out, 'files/runs/b/dark/x.webp'),
				]).toString(),
				'WEBP',
			);
			assert.ok(existsSync(path.join(out, 'files/runs/b/dark/y.png')));
			const jobs = JSON.parse(readFileSync(path.join(out, 'api/jobs.json'), 'utf8'));
			assert.equal(jobs.images, 'webp');
			assert.deepEqual(
				jobs.png.filter((file) => file.includes('/b/')),
				['files/runs/b/dark/y.png'],
			);

			await writeExport(exportPlan(root, [run], { png: true }), out);
			assert.ok(existsSync(path.join(out, 'files/runs/b/dark/x.png')));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test('the viewer streams an export as a zip, for jobs of its workspace only', async () => {
	const root = workspace();
	const server = await serve({ workspace: root });
	const fetchRaw = (pathname) =>
		new Promise((resolve, reject) => {
			get(`${server.url}${pathname}`, (response) => {
				const chunks = [];
				response.on('data', (chunk) => chunks.push(chunk));
				response.on('end', () =>
					resolve({ status: response.statusCode, body: Buffer.concat(chunks) }),
				);
			}).on('error', reject);
		});
	try {
		const zip = await fetchRaw('/api/export.zip?diff=a--b&runs=1');
		assert.equal(zip.status, 200);
		const end = zip.body.subarray(-22);
		assert.equal(end.readUInt32LE(0), 0x06054b50);
		assert.ok(end.readUInt16LE(10) > 10, 'entries in the zip');
		assert.equal((await fetchRaw('/api/export.zip?diff=..')).status, 400);
		assert.equal((await fetchRaw(`/api/export.zip?run=${encodeURIComponent(root)}`)).status, 400);
	} finally {
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('an export takes files from inside its jobs only', async () => {
	const root = workspace();
	try {
		put(path.join(root, 'secret/id.png'), 'secret');
		const run = path.join(root, 'runs', 'a');
		const shots = (file) =>
			put(path.join(run, 'shots.json'), JSON.stringify({ shots: [{ file }] }));
		for (const file of ['../../secret/id.png', '/etc/hostname', 'dark/../../b/dark/x.png']) {
			shots(file);
			assert.throws(() => exportPlan(root, [run]), /not a path inside it/, file);
		}
		// A link inside the job that leads out of it.
		symlinkSync(path.join(root, 'secret'), path.join(run, 'out'));
		shots('out/id.png');
		assert.throws(() => exportPlan(root, [run]), /leads out of it/);

		// A diff that names a directory that is no run as its baseline.
		const diff = path.join(root, 'diffs', 'a--b', 'diff.json');
		const record = JSON.parse(readFileSync(diff, 'utf8'));
		put(diff, JSON.stringify({ ...record, base: path.join(root, 'secret') }));
		assert.throws(() => exportPlan(root, [path.dirname(diff)]), /is not a run/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('an export zip is known again, and a plan that would escape writes nothing', async () => {
	const root = workspace();
	try {
		const plan = exportPlan(root, [path.join(root, 'diffs', 'a--b')]);
		const zip = path.join(root, 'site.zip');
		const stream = createWriteStream(zip);
		await writeZip(plan, stream, 'site');
		await once(stream, 'close');
		assert.equal(isExportZip(zip), true);
		put(path.join(root, 'notes.zip'), 'not a zip');
		assert.equal(isExportZip(path.join(root, 'notes.zip')), false);

		const out = path.join(root, 'out');
		const escaping = { ...plan, entries: [{ path: '../evil.txt', data: Buffer.from('x') }] };
		await assert.rejects(writeExport(escaping, out), /outside itself/);
		assert.ok(!existsSync(path.join(root, 'evil.txt')));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
