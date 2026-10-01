import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import os from 'node:os';
import path from 'node:path';

import { requireMagick } from '../caption.mjs';
import { comparerThread, createComparer } from '../compare.mjs';
import { openLog } from '../events.mjs';
import { notify } from '../notify.mjs';
import { listPngs, pixelsOf } from '../png.mjs';
import { formatDuration } from '../progress.mjs';
import { availableMemory } from '../resources.mjs';
import { ensureViewer } from '../viewer.mjs';
import {
	eventsFile,
	readJson,
	readMeta,
	resolveJob,
	validName,
	workspaceDir,
	writeMeta,
} from '../workspace.mjs';

export const DIFF_HELP = `usage: sbshot diff <baseline> <after> [options]

<baseline> and <after> are runs: a name under <workspace>/runs, a directory,
or 'latest'. Pairs the PNGs of the two by relative path and reports what
moved, largest first.

  --name-diff <name>     diff name under <workspace>/diffs
                         (default: <baseline>--<after>)
  -o, --out <dir>        write the diff here instead
  --mode green           the after shot, changed pixels painted over it (default)
  --mode green-parallel  previous | current | green diff, side by side
  --mode red             the after shot faded out, changed pixels painted red
  --mode red-parallel    previous | current | red diff, side by side
  --threshold <0..1>     YIQ distance a pixel must move to count (default 0.063)
  --include-aa           count antialiasing changes too (default: ignore them)
  --tint <#rrggbb>       override the mode's highlight colour
  --no-caption           do not stamp the story and the run settings on top
  --noise <diff>         a noise-floor diff (same tree twice): pairs that moved
                         there are marked flaky here
  --fail-over <px>       exit 1 when a pair that is not flaky moved more than <px>
  --jobs <n>             pairs compared at once, one thread each (default: what
                         the cores and the free memory hold)
  --top <n>              print only the <n> largest movers (default: all changed)
  --all                  also print the unchanged pairs
  --notify               desktop notification when the diff ends
  --ui                   open the workspace viewer on this diff (reused or started)

Writes <diff>/diff.json (every pair: changed pixels, ratio, change box, flaky)
and <diff>/events.ndjson, which 'sbshot status' and 'sbshot ui' read. Needs
ImageMagick.`;

const OPTIONS = {
	'name-diff': { type: 'string' },
	out: { type: 'string', short: 'o' },
	workspace: { type: 'string', short: 'w' },
	mode: { type: 'string', default: 'green' },
	threshold: { type: 'string', default: '0.063' },
	'include-aa': { type: 'boolean', default: false },
	tint: { type: 'string', default: '' },
	'no-caption': { type: 'boolean', default: false },
	noise: { type: 'string' },
	'fail-over': { type: 'string' },
	jobs: { type: 'string' },
	top: { type: 'string' },
	all: { type: 'boolean', default: false },
	notify: { type: 'boolean', default: false },
	ui: { type: 'boolean', default: false },
	'ui-port': { type: 'string' },
	force: { type: 'boolean', default: false },
	help: { type: 'boolean', short: 'h', default: false },
};

const MODES = new Set(['green', 'green-parallel', 'red', 'red-parallel']);

export const diff = async (argv) => {
	const { values: opts, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: OPTIONS,
	});
	const [baseRef, afterRef] = positionals;
	if (opts.help || !baseRef || !afterRef) {
		console.log(DIFF_HELP);
		return opts.help ? 0 : 1;
	}
	if (!MODES.has(opts.mode)) {
		console.error(`--mode: one of ${[...MODES].join(', ')}`);
		return 1;
	}
	for (const flag of ['threshold', 'jobs', 'top', 'fail-over']) {
		if (opts[flag] !== undefined && !Number.isFinite(Number(opts[flag]))) {
			console.error(`--${flag}: not a number: ${opts[flag]}`);
			return 1;
		}
	}
	if (opts.tint && !/^#?[0-9a-f]{6}$/i.test(opts.tint)) {
		console.error(`--tint: not a #rrggbb colour: ${opts.tint}`);
		return 1;
	}
	if (opts['name-diff'] !== undefined && !validName(opts['name-diff'])) {
		console.error(
			`--name-diff: ${opts['name-diff']} is not a name: letters, digits and . _ -, not starting with a dot, and not 'latest'`,
		);
		return 1;
	}
	requireMagick();

	const workspace = workspaceDir(opts.workspace);
	const baseDir = resolveJob(workspace, baseRef, 'capture');
	const afterDir = resolveJob(workspace, afterRef, 'capture');
	for (const [ref, dir] of [
		[baseRef, baseDir],
		[afterRef, afterDir],
	]) {
		if (!dir) {
			console.error(`no run ${ref} (looked in ${path.join(workspace, 'runs')})`);
			return 1;
		}
	}
	const name = opts['name-diff'] ?? `${path.basename(baseDir)}--${path.basename(afterDir)}`;
	const outDir = path.resolve(opts.out ?? path.join(workspace, 'diffs', name));

	// Everything that can fail is read before an earlier diff is replaced.
	let flakyFiles = new Set();
	if (opts.noise) {
		const noiseDir = resolveJob(workspace, opts.noise, 'diff');
		const noise = noiseDir && readJson(path.join(noiseDir, 'diff.json'));
		if (!noise?.results) {
			console.error(`--noise: no diff.json in ${opts.noise}`);
			return 1;
		}
		flakyFiles = new Set(noise.results.filter((pair) => pair.changed > 0).map((pair) => pair.file));
	}
	const [baseFiles, afterFiles] = await Promise.all([listPngs(baseDir), listPngs(afterDir)]);

	// Verdicts and tags are about the stories, not about one pass over them, so a
	// rerun of the same diff keeps them.
	const kept = {};
	if (existsSync(outDir) && (await readdir(outDir)).length) {
		// --force replaces a diff, never whatever else the path leads to.
		if (readMeta(outDir)?.kind !== 'diff') {
			console.error(`${outDir} is not empty and is not a diff: not replacing it.`);
			return 1;
		}
		if (!opts.force && existsSync(path.join(outDir, 'diff.json'))) {
			console.error(`${outDir} already exists. Pass --force to replace it.`);
			return 1;
		}
		for (const file of ['review.json', 'tags.json']) {
			kept[file] = await readFile(path.join(outDir, file)).catch(() => null);
		}
		await rm(outDir, { recursive: true, force: true });
	}
	await mkdir(outDir, { recursive: true });
	for (const [file, content] of Object.entries(kept)) {
		if (content) await writeFile(path.join(outDir, file), content);
	}
	const pairs = [...new Set([...baseFiles, ...afterFiles])].sort((a, b) => a.localeCompare(b));
	const threshold = Number(opts.threshold);
	const settings = {
		baseDir,
		afterDir,
		outDir,
		mode: opts.mode,
		threshold,
		includeAA: opts['include-aa'],
		tint: opts.tint,
		noCaption: opts['no-caption'],
		baseFiles,
		afterFiles,
	};
	const config = {
		mode: opts.mode,
		threshold,
		includeAA: opts['include-aa'],
		noise: opts.noise ?? null,
	};

	const log = openLog(eventsFile(outDir));
	const meta = {
		kind: 'diff',
		name: path.basename(outDir),
		status: 'running',
		pid: process.pid,
		host: os.hostname(),
		started: Date.now(),
		base: baseDir,
		after: afterDir,
		config,
		total: pairs.length,
		argv,
	};
	await writeMeta(outDir, meta);
	log.emit('start', {
		kind: 'diff',
		name: meta.name,
		total: pairs.length,
		base: baseDir,
		after: afterDir,
		config,
		items: pairs.map((rel) => ({ key: rel.split(path.sep).join('/') })),
	});
	console.log(`${pairs.length} pairs: ${baseDir} vs ${afterDir} -> ${outDir}`);
	if (opts.ui) {
		const url = await ensureViewer(workspace, Number(opts['ui-port']) || undefined);
		console.log(`ui: ${url}/#/job/diff/${encodeURIComponent(meta.name)}`);
	}

	/**
	 * A pair in flight holds both shots and the diff as 8-bit RGBA, and
	 * ImageMagick three more at 16 bits a channel: about 40 bytes a pixel. The
	 * largest shot sets the threads that fit.
	 */
	const fittingJobs = () => {
		const largest = Math.max(
			1,
			...baseFiles.map((rel) => pixelsOf(path.join(baseDir, rel))),
			...afterFiles.map((rel) => pixelsOf(path.join(afterDir, rel))),
		);
		return Math.min(
			os.availableParallelism(),
			Math.floor((availableMemory() * 0.9) / (largest * 40)),
		);
	};

	const results = [];
	const record = (result) => {
		result.flaky = flakyFiles.has(result.file);
		results.push(result);
		const { file, ...rest } = result;
		log.emit('pair', { key: file, file, ...rest });
	};

	const queue = [...pairs];
	const jobs = Math.min(Math.max(Number(opts.jobs ?? fittingJobs()), 1), Math.max(pairs.length, 1));
	let failure;
	try {
		if (jobs === 1) {
			const compare = await createComparer(settings);
			for (const rel of queue) {
				record(await compare(rel));
			}
		} else {
			// Every pair is on its own thread, so ImageMagick's own threads only
			// fight them for the cores.
			process.env.MAGICK_THREAD_LIMIT ??= '1';
			await Promise.all(
				Array.from(
					{ length: jobs },
					() =>
						new Promise((resolve, reject) => {
							const worker = comparerThread(settings);
							const next = () => {
								if (queue.length) {
									worker.postMessage(queue.shift());
								} else {
									worker.terminate().then(resolve, resolve);
								}
							};
							worker.on('message', (result) => {
								record(result);
								next();
							});
							worker.on('error', reject);
							worker.once('online', next);
						}),
				),
			);
		}
	} catch (error) {
		failure = error;
	}

	// Every thread leaves its own scratch files behind.
	await Promise.all(
		(await readdir(outDir))
			.filter((file) => file.startsWith('.sbshot-'))
			.map((file) => rm(path.join(outDir, file), { force: true })),
	);

	results.sort((a, b) => b.changed - a.changed || a.file.localeCompare(b.file));
	const changed = results.filter((pair) => pair.changed > 0);
	const summary = {
		pairs: results.length,
		changed: changed.filter((pair) => !pair.note).length,
		missing: changed.filter((pair) => pair.note).length,
		same: results.length - changed.length,
		flaky: changed.filter((pair) => pair.flaky).length,
		duration: Date.now() - meta.started,
		error: failure?.message,
	};
	await writeFile(
		path.join(outDir, 'diff.json'),
		`${JSON.stringify({ base: baseDir, after: afterDir, config, summary, results }, null, '\t')}\n`,
	);
	const status = failure ? 'failed' : 'done';
	log.emit('end', { status, summary });
	log.close();
	meta.status = status;
	meta.ended = Date.now();
	meta.summary = summary;
	await writeMeta(outDir, meta);

	const shown = (opts.all ? results : changed).slice(0, opts.top ? Number(opts.top) : undefined);
	for (const pair of shown) {
		const notes = [pair.note, pair.flaky && 'flaky'].filter(Boolean).join(', ');
		const pct = pair.pixels ? ` ${((pair.ratio ?? 0) * 100).toFixed(2)}%` : '';
		console.log(
			`${String(pair.changed).padStart(10)}${pct.padStart(9)}  ${pair.file}${notes ? `  (${notes})` : ''}`,
		);
	}
	if (failure) {
		console.error(`diff failed: ${failure.message}`);
	}
	console.log(
		`\n${summary.pairs} pairs in ${formatDuration(summary.duration)}: ${summary.changed} changed, ${summary.missing} missing, ${summary.same} same${
			opts.noise ? `, ${summary.flaky} of the changed are flaky` : ''
		}\ndiff: ${outDir}`,
	);
	if (opts.notify) {
		notify(
			`sbshot diff ${meta.name} ${status}`,
			`${summary.changed} changed, ${summary.missing} missing of ${summary.pairs}`,
		);
	}

	if (failure) {
		return 1;
	}
	if (opts['fail-over'] !== undefined) {
		const limit = Number(opts['fail-over']);
		if (changed.some((pair) => !pair.flaky && pair.changed > limit)) {
			return 1;
		}
	}
	return 0;
};
