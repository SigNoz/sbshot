import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import os from 'node:os';
import path from 'node:path';

import { CONFIG_KEYS, contactSheet, hasMagick, settingsLine } from '../caption.mjs';
import { changedStoryFiles } from '../changed.mjs';
import { openLog } from '../events.mjs';
import { pickHistory } from '../history.mjs';
import { notify } from '../notify.mjs';
import { resolvePlaywright } from '../playwright.mjs';
import { estimate, fold, formatDuration, progressLine } from '../progress.mjs';
import { availableMemory, cpuSampler } from '../resources.mjs';
import {
	buildProject,
	buildStorybook,
	fileSafeId,
	selectStories,
	serveStatic,
} from '../storybook.mjs';
import { ensureViewer } from '../viewer.mjs';
import {
	defaultName,
	eventsFile,
	listJobs,
	readMeta,
	shotPaths,
	validName,
	workspaceDir,
	writeMeta,
} from '../workspace.mjs';

/**
 * The wall clock every shot is taken at, passed to the preview as `storyClock`.
 * A preview that reads it (SigNoz's `.storybook/preview-head.html` does) shoots
 * every story at the same instant; one that does not ignores the parameter.
 */
export const FROZEN_CLOCK = '2026-06-15T12:00:00.000Z';

export const CAPTURE_HELP = `usage: sbshot capture <storybook> [options]

<storybook> is one of:
  http://host:port    a running storybook (dev server or any static host)
  <dir>               a storybook build (has index.json), served on a free port
  <project>           a project with .storybook/: built first into
                      <workspace>/builds/<name>, then served

Selection
  --stories <match>   id or Title/Name substring (repeatable, comma-separated)
  --title <prefix>    only titles starting with <prefix>
  --name <match>      only story names containing <match>
  --theme <themes>    themes to shoot, e.g. dark,light (default: story default)
  --changed-since <ref>
                      only stories whose module graph holds a file changed since
                      <ref>. Needs a build made with --stats-json
  --changed-global <glob>
                      a change to a file matching <glob> (relative to the
                      project) reaches every story (repeatable)
  --project <dir>     storybook project root for --changed-since (default: the
                      project the build came from, else the build's parent)
  --list              print the matched stories and exit

Output
  --name-run <name>   run name under <workspace>/runs (default: a timestamp)
  -o, --out <dir>     write the run here instead
  --force             replace an existing run of that name
  --flat              <out>/<id>.png instead of <out>/<theme>/<id>.png
  --no-caption        do not stamp the story and the settings on the shot

Page
  --args <k:v;k2:v2>  arg overrides, storybook's ?args= syntax (repeatable)
  --globals <k:v;..>  extra storybook globals, on top of theme and motion
  --width <px>        viewport width, the only fixed dimension (default 1680)
  --height <px>       shortest the viewport may be (default 1200)
  --max-height <px>   tallest the viewport may grow to (default 8000)
  --grow <what>       scrollers (default) | document | none
  --settle <ms>       wait after the page goes quiet (default 300)
  --clock <iso|live>  wall clock passed as ?storyClock (default ${FROZEN_CLOCK})
  --motion            keep animations and transitions running
  --ignore <selector> hide matching elements, on top of [data-shot-ignore]
  --highlight <sel>   also shoot <id>--highlight.png, every match ringed in red
  --crop <selector>   also write <theme>/crops/<id>--<n>.png per match and a
                      <theme>/crops.png contact sheet

Scheduling
  --jobs <n>          cap on stories at once; the count still adapts to CPU/memory under it
  --history <run|none>
                      earlier run whose durations drive the ETA and the
                      slowest-first order (default: latest finished run)
  --no-order          keep id order even with a history
  --port <port>       dev server port when <storybook> is omitted (default 6006)

Reporting
  --verbose           print every shot, not only busy, failed and retried ones
  --ui                open the workspace viewer on this run: reuses the one
                      already running, or starts a detached 'sbshot ui'
  --ui-port <port>    port for a viewer it starts (default 7007)
  --notify            desktop notification when the run ends
  --fail-on-busy      exit non-zero when a story never held still

Everything the run does is appended to <run>/events.ndjson as it happens:
'sbshot status' and 'sbshot ui' read it.`;

const OPTIONS = {
	out: { type: 'string', short: 'o' },
	'name-run': { type: 'string' },
	force: { type: 'boolean', default: false },
	workspace: { type: 'string', short: 'w' },
	stories: { type: 'string', multiple: true, default: [] },
	title: { type: 'string', default: '' },
	name: { type: 'string', default: '' },
	theme: { type: 'string', multiple: true, default: [] },
	args: { type: 'string', multiple: true, default: [] },
	globals: { type: 'string', multiple: true, default: [] },
	port: { type: 'string', default: process.env.SB_PORT ?? '6006' },
	jobs: { type: 'string' },
	history: { type: 'string' },
	'no-order': { type: 'boolean', default: false },
	'changed-since': { type: 'string' },
	'changed-global': { type: 'string', multiple: true, default: [] },
	project: { type: 'string' },
	width: { type: 'string', default: '1680' },
	height: { type: 'string', default: '1200' },
	'max-height': { type: 'string', default: '8000' },
	grow: { type: 'string', default: 'scrollers' },
	settle: { type: 'string', default: '300' },
	clock: { type: 'string', default: FROZEN_CLOCK },
	motion: { type: 'boolean', default: false },
	ignore: { type: 'string', multiple: true, default: [] },
	highlight: { type: 'string', multiple: true, default: [] },
	crop: { type: 'string', multiple: true, default: [] },
	flat: { type: 'boolean', default: false },
	'no-caption': { type: 'boolean', default: false },
	'fail-on-busy': { type: 'boolean', default: false },
	list: { type: 'boolean', default: false },
	verbose: { type: 'boolean', short: 'v', default: false },
	ui: { type: 'boolean', default: false },
	'ui-port': { type: 'string' },
	notify: { type: 'boolean', default: false },
	help: { type: 'boolean', short: 'h', default: false },
};

/** A repeatable, comma-separated flag read as one CSS selector list. */
const selectorList = (values) =>
	values
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.filter(Boolean)
		.join(', ');

/**
 * Ratios of the machine, not counts: the run keeps adding pages while the
 * cores stay below `CPU_ROOM` busy and the memory left after two more pages
 * stays above `MEMORY_FLOOR`, and gives pages back past `CPU_FULL` or under
 * half the floor. A new browser starts once every running one has a driver
 * loop busier than `DRIVER_BUSY`.
 */
const CPU_ROOM = 0.75;
const CPU_FULL = 0.9;
const MEMORY_FLOOR = 0.1;
const DRIVER_BUSY = 0.5;

const GROW = ['scrollers', 'document', 'none'];

/** How often the terminal gets a progress line, when nothing else is printed. */
const PROGRESS_EVERY = 20_000;

export const capture = async (argv) => {
	const { values: opts, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: OPTIONS,
	});
	if (opts.help) {
		console.log(CAPTURE_HELP);
		return 0;
	}

	const workspace = workspaceDir(opts.workspace);
	const source = positionals[0] ?? `http://localhost:${opts.port}`;
	if (opts['name-run'] !== undefined && !validName(opts['name-run'])) {
		console.error(
			`--name-run: ${opts['name-run']} is not a name: letters, digits and . _ -, not starting with a dot, and not 'latest'`,
		);
		return 1;
	}
	const runName = opts['name-run'] ?? defaultName();
	const outDir = path.resolve(opts.out ?? path.join(workspace, 'runs', runName));
	const themes = opts.theme.flatMap((value) => value.split(',')).filter(Boolean);
	const themeList = themes.length ? themes : [null];
	const storyArgs = opts.args.filter(Boolean).join(';');
	const extraGlobals = opts.globals.filter(Boolean).join(';');
	const ignoreSelectors = selectorList(opts.ignore);
	const highlightSelector = selectorList(opts.highlight);
	const cropSelector = selectorList(opts.crop);

	if (opts.clock !== 'live' && Number.isNaN(Date.parse(opts.clock))) {
		console.error(`--clock: not a date: ${opts.clock}`);
		return 1;
	}
	for (const flag of ['width', 'height', 'max-height', 'settle', 'jobs']) {
		const value = opts[flag];
		if (value !== undefined && !(Number.isInteger(Number(value)) && Number(value) >= 0)) {
			console.error(`--${flag}: not a whole number: ${value}`);
			return 1;
		}
	}
	if (!GROW.includes(opts.grow)) {
		console.error(`--grow: one of ${GROW.join(', ')}`);
		return 1;
	}

	const isUrl = /^https?:\/\//.test(source);
	const isBuild = !isUrl && existsSync(path.join(source, 'index.json'));
	const isProject = !isUrl && !isBuild && existsSync(path.join(source, '.storybook'));
	if (!isUrl && !isBuild && !isProject) {
		console.error(
			`${source}: not a URL, a storybook build (no index.json) or a project (no .storybook/)`,
		);
		return 1;
	}

	if (!opts.list) {
		if (existsSync(outDir) && (await readdir(outDir)).length) {
			// --force replaces a run, never whatever else the path leads to.
			if (readMeta(outDir)?.kind !== 'capture') {
				console.error(`${outDir} is not empty and is not a run: not replacing it.`);
				return 1;
			}
			if (!opts.force) {
				console.error(`${outDir} already exists. Pass --force to replace it.`);
				return 1;
			}
			await rm(outDir, { recursive: true, force: true });
		}
		await mkdir(outDir, { recursive: true });
	}

	// A `--list` run writes nothing, so its events go nowhere.
	const log = opts.list ? { emit() {}, close() {} } : openLog(eventsFile(outDir));
	const meta = {
		kind: 'capture',
		name: path.basename(outDir),
		status: 'running',
		pid: process.pid,
		host: os.hostname(),
		started: Date.now(),
		storybook: path.isAbsolute(source) || isUrl ? source : path.resolve(source),
		argv,
		cwd: process.cwd(),
	};
	const saveMeta = () => !opts.list && writeMeta(outDir, meta);
	// Written at once, so a run stopped before it shoots is still a run that
	// --force may replace.
	await saveMeta();

	// The static server of a build, once one is up.
	let server = null;
	/** Ends a run that failed before it shot anything, and says why. */
	const fail = async (message) => {
		console.error(message);
		log.emit('end', { status: 'failed', summary: { error: message } });
		log.close();
		meta.status = 'failed';
		meta.ended = Date.now();
		await saveMeta();
		await server?.close();
		return 1;
	};

	if (opts.ui && !opts.list) {
		const url = await ensureViewer(workspace, Number(opts['ui-port']) || undefined);
		console.log(`ui: ${url}/#/job/capture/${encodeURIComponent(path.basename(outDir))}`);
	}

	let staticDir = isBuild ? path.resolve(source) : null;
	if (isProject) {
		staticDir = path.join(workspace, 'builds', path.basename(outDir));
		meta.status = 'building';
		await saveMeta();
		// The last build this workspace timed prices this one.
		const expected = listJobs(workspace).find((job) => job.buildDuration)?.buildDuration;
		log.emit('build-start', {
			kind: 'capture',
			name: meta.name,
			dir: staticDir,
			project: path.resolve(source),
			expected,
		});
		console.log(`building ${path.resolve(source)} -> ${staticDir}`);
		const started = Date.now();
		try {
			await mkdir(path.dirname(staticDir), { recursive: true });
			await buildStorybook(path.resolve(source), staticDir, log);
			meta.buildDuration = Date.now() - started;
			log.emit('build-end', { ok: true, duration: meta.buildDuration });
			console.log(`built in ${formatDuration(Date.now() - started)}`);
		} catch (error) {
			log.emit('build-end', { ok: false, error: error.message });
			return fail(error.message);
		}
		meta.status = 'running';
		meta.build = staticDir;
	}

	server = staticDir ? await serveStatic(staticDir) : null;
	const base = server?.url ?? source.replace(/\/$/, '');

	let index;
	try {
		// `index.json` carries raw control characters from story jsdoc, so it is
		// read as text rather than piped through anything that revalidates it.
		index = JSON.parse(await (await fetch(`${base}/index.json`)).text());
	} catch (error) {
		return fail(`cannot read ${base}/index.json: ${error.message}`);
	}

	const unsafe = Object.values(index.entries ?? {}).filter(
		(entry) => entry?.type === 'story' && !fileSafeId(entry.id),
	);
	if (unsafe.length) {
		console.error(
			`skipped ${unsafe.length} stories whose id cannot be a file name: ${unsafe
				.slice(0, 5)
				.map((entry) => JSON.stringify(entry.id))
				.join(', ')}`,
		);
	}
	let stories = selectStories(index, {
		stories: opts.stories.flatMap((value) => value.split(',')).filter(Boolean),
		title: opts.title,
		name: opts.name,
	});

	const since = opts['changed-since'];
	if (since) {
		if (!staticDir) {
			return fail('--changed-since needs a storybook build, not a URL');
		}
		const project = path.resolve(
			opts.project ?? (isProject ? source : (buildProject(staticDir) ?? path.dirname(staticDir))),
		);
		let reach;
		try {
			reach = await changedStoryFiles({
				ref: since,
				stats: path.join(staticDir, 'preview-stats.json'),
				cwd: project,
				globs: opts['changed-global'],
			});
		} catch (error) {
			return fail(
				error.code === 'ENOENT'
					? `no preview-stats.json in ${staticDir}: rebuild with --stats-json`
					: error.message,
			);
		}
		if (reach.files) {
			stories = stories.filter((story) => reach.files.has(story.importPath));
			console.error(
				`${reach.changed.length} files changed since ${since}, reaching ${reach.files.size} story files`,
			);
		} else {
			console.error(`${reach.reason} changed since ${since}: every story`);
		}
	}

	if (opts.list) {
		stories.forEach((story) => console.log(`${story.id}\t${story.title}/${story.name}`));
		console.log(`${stories.length} stories`);
		await server?.close();
		return 0;
	}

	if (!stories.length) {
		console.error(since ? 'no story reached by the change' : 'no story matched');
		log.emit('end', { status: 'done', summary: { shots: 0 } });
		log.close();
		meta.status = 'done';
		meta.ended = Date.now();
		await saveMeta();
		await server?.close();
		return since ? 0 : 1;
	}

	const runConfig = {
		args: storyArgs,
		clock: opts.clock,
		width: opts.width,
		height: opts.height,
		grow: opts.grow,
		motion: opts.motion ? 'live' : 'still',
		settle: opts.settle,
		ignore: ignoreSelectors,
		highlight: highlightSelector,
		crop: cropSelector,
	};
	const captioning = !opts['no-caption'] && hasMagick();
	if (!opts['no-caption'] && !captioning) {
		console.error('ImageMagick not found: shots are written without a caption.');
	}

	const { dirOf, shotFile } = shotPaths(outDir, opts.flat);
	await Promise.all(themeList.map((theme) => mkdir(dirOf(theme), { recursive: true })));

	const wantedFiles = themeList.flatMap((theme) =>
		stories.map((story) => shotFile(theme, `${story.id}.png`)),
	);
	let history;
	let playwrightModule;
	try {
		history = pickHistory({ workspace, ref: opts.history, wantedFiles, exclude: outDir });
		playwrightModule = resolvePlaywright();
	} catch (error) {
		return fail(error.message);
	}
	const { dir: historyDir, durations: earlier, parallelism: historyParallelism } = history;

	const keyOf = (story, theme) => `${theme ?? 'default'}/${story.id}`;

	// Slowest first by the history, so the long stories do not leave the end of
	// the run on a few pages. One the history lacks may be anything: first.
	const expectedOf = (story, theme) => earlier.get(shotFile(theme, `${story.id}.png`));
	const queue = themeList.flatMap((theme) => stories.map((story) => [story, theme]));
	if (!opts['no-order'] && earlier.size) {
		queue.sort(
			(a, b) =>
				(expectedOf(...b) ?? Number.MAX_SAFE_INTEGER) -
				(expectedOf(...a) ?? Number.MAX_SAFE_INTEGER),
		);
	}

	const total = queue.length;
	meta.total = total;
	meta.history = historyDir;
	meta.config = runConfig;
	await saveMeta();
	// The same fold the UI runs, kept here so the terminal line and the
	// sampled ETA agree with it.
	const state = fold([]);
	const track = (type, data) => {
		const event = { t: Date.now(), type, ...data };
		log.emit(type, data);
		fold([event], state);
	};
	track('start', {
		kind: 'capture',
		name: meta.name,
		total,
		storybook: meta.storybook,
		base,
		history: historyDir,
		historyParallelism,
		themes: themeList.map((theme) => theme ?? 'default'),
		config: runConfig,
		items: queue.map(([story, theme]) => ({
			key: keyOf(story, theme),
			id: story.id,
			title: story.title,
			name: story.name,
			theme: theme ?? 'default',
			file: shotFile(theme, `${story.id}.png`),
			expected: expectedOf(story, theme),
		})),
	});

	console.log(
		`${stories.length} stories x ${themeList.length} theme(s) = ${total} shots -> ${outDir}${
			historyDir
				? `\nhistory: ${historyDir} (${wantedFiles.filter((file) => earlier.has(file)).length} of ${total} priced)`
				: ''
		}`,
	);

	const settings = {
		base,
		outDir,
		flat: opts.flat,
		width: Number(opts.width),
		height: Number(opts.height),
		maxHeight: Number(opts['max-height']),
		grow: opts.grow,
		settle: Number(opts.settle),
		clock: opts.clock,
		motion: opts.motion,
		ignore: ignoreSelectors,
		highlight: highlightSelector,
		crop: cropSelector,
		args: storyArgs,
		globals: extraGlobals,
		captioning,
		configLine: settingsLine(runConfig, CONFIG_KEYS),
		playwrightModule,
	};

	const shots = [];
	const failures = [];
	const crops = new Map(themeList.map((theme) => [theme, []]));
	const ceiling = opts.jobs ? Math.max(Number(opts.jobs), 1) : Infinity;
	const workers = [];
	const retried = new Set();
	const peak = { pages: 0, browsers: 0 };
	let inFlight = 0;
	let limit = 1;
	let loadedSinceGrowth = false;
	let starting = false;
	let canSpawn = true;
	let workerSeq = 0;
	let shuttingDown = false;
	let lastPrint = Date.now();
	let finished;
	const drained = new Promise((resolve) => {
		finished = resolve;
	});

	const say = (line) => {
		console.log(line);
		lastPrint = Date.now();
	};

	const complete = ([story, theme], result) => {
		inFlight -= 1;
		const key = keyOf(story, theme);
		if (!result.failed) {
			shots.push(...result.recorded);
			crops.get(theme).push(...result.cropped);
			track('shot', {
				key,
				status: result.status,
				duration: result.duration,
				files: result.recorded.map((shot) => shot.file),
				notes: result.notes,
				size: result.size,
				caption: result.caption,
			});
			if (opts.verbose || result.status === 'busy') {
				say(
					`  ${result.status === 'ok' ? 'ok  ' : 'busy'} ${key} ${formatDuration(result.duration)}${
						result.notes.length ? ` (${result.notes.join(', ')})` : ''
					}`,
				);
			}
		} else if (retried.has(key)) {
			failures.push([story, theme]);
			track('fail', { key, error: result.error, duration: result.duration });
			say(`  FAIL ${key}: ${result.error}`);
		} else {
			// A story that timed out under load usually passes on a second go.
			retried.add(key);
			queue.push([story, theme]);
			track('retry', { key, error: result.error });
			say(`  retry ${key}: ${result.error}`);
		}
	};

	const spawnWorker = () => {
		starting = true;
		workerSeq += 1;
		const child = fork(path.join(import.meta.dirname, '..', 'worker.mjs'), [], {
			env: {
				...process.env,
				SBSHOT_SETTINGS: JSON.stringify(settings),
				// Captions run a process per shot in flight, and each one's own
				// threads would only fight the pages for the cores.
				MAGICK_THREAD_LIMIT: process.env.MAGICK_THREAD_LIMIT ?? '1',
			},
		});
		const worker = {
			id: workerSeq,
			child,
			load: 0,
			jobs: new Map(),
			ready: false,
		};
		workers.push(worker);

		child.on('message', (message) => {
			switch (message.type) {
				case 'ready':
					worker.ready = true;
					starting = false;
					break;
				case 'loaded':
					loadedSinceGrowth = true;
					track('phase', { key: message.key, phase: 'loaded' });
					return;
				case 'phase':
					track('phase', { key: message.key, phase: message.phase });
					return;
				case 'load':
					worker.load = message.load;
					return;
				case 'result':
					complete(worker.jobs.get(message.key), message);
					worker.jobs.delete(message.key);
					break;
				default:
					return;
			}
			pump();
		});

		child.on('exit', () => {
			workers.splice(workers.indexOf(worker), 1);
			// A run being stopped kills its browsers: what they had in flight is
			// left unshot, not failed.
			if (shuttingDown) {
				return;
			}
			if (!worker.ready) {
				// It never got a browser up, and the next one would not either.
				starting = false;
				canSpawn = false;
				if (!workers.length) {
					console.error('no browser could be started');
					shutdown('failed');
					return;
				}
			}
			worker.jobs.forEach((job) =>
				complete(job, { failed: true, error: 'the browser process exited' }),
			);
			worker.jobs.clear();
			pump();
		});
	};

	const pump = () => {
		while (queue.length && inFlight < Math.min(limit, ceiling)) {
			const [worker] = workers
				.filter(({ ready }) => ready)
				.sort((a, b) => a.load - b.load || a.jobs.size - b.jobs.size);
			if (!worker || worker.load > DRIVER_BUSY) {
				if (!starting && canSpawn) {
					spawnWorker();
				}
				if (!worker || starting) {
					return;
				}
			}

			const [story, theme] = queue.shift();
			const key = keyOf(story, theme);
			worker.jobs.set(key, [story, theme]);
			worker.child.send({ key, story, theme });
			inFlight += 1;
			track('begin', {
				key,
				worker: worker.id,
				attempt: retried.has(key) ? 2 : 1,
			});
			peak.pages = Math.max(peak.pages, inFlight);
			peak.browsers = Math.max(peak.browsers, workers.length);
		}
		if (!queue.length && !inFlight) {
			finished('done');
		}
	};

	// The machine is sampled rather than sized up front: what a page costs
	// depends on the story, and the rest of the desktop keeps using it too.
	// A page costs CPU only once its story renders, so growth is at most a page
	// per story rendered, which keeps pages from piling up and timing out.
	const cpuBusy = cpuSampler();
	const totalMemory = os.totalmem();
	const baseline = availableMemory();
	let cpu = 0;
	let tick = 0;
	const control = setInterval(() => {
		cpu = (cpu + cpuBusy()) / 2;
		const free = availableMemory();
		const perPage = inFlight ? Math.max(baseline - free, 0) / inFlight : 0;
		if (cpu > CPU_FULL || free < (totalMemory * MEMORY_FLOOR) / 2) {
			limit = Math.max(limit - 1, 1);
		} else if (
			limit < ceiling &&
			cpu < CPU_ROOM &&
			free - perPage * 2 > totalMemory * MEMORY_FLOOR &&
			inFlight >= limit &&
			loadedSinceGrowth &&
			queue.length
		) {
			limit += 1;
			loadedSinceGrowth = false;
			pump();
		}

		tick += 1;
		if (tick % 4 === 0) {
			const now = Date.now();
			const e = estimate(state, now);
			track('sample', {
				cpu,
				memFree: free,
				memTotal: totalMemory,
				pages: inFlight,
				limit: Math.min(limit, ceiling),
				browsers: workers.length,
				eta: e.eta,
				parallelism: e.parallelism,
			});
			if (now - lastPrint > PROGRESS_EVERY) {
				say(`[${progressLine(state, now)}]`);
			}
		}
	}, 500);

	const shutdown = (status) => {
		if (!shuttingDown) {
			shuttingDown = true;
			finished(status);
		}
	};
	const onSignal = () => {
		console.error('\ninterrupted: stopping the browsers and saving what was shot');
		queue.length = 0;
		shutdown('interrupted');
	};
	process.once('SIGINT', onSignal);
	process.once('SIGTERM', onSignal);

	pump();
	const endStatus = await drained;
	clearInterval(control);
	process.off('SIGINT', onSignal);
	process.off('SIGTERM', onSignal);
	await Promise.all(
		workers.map(
			({ child }) =>
				new Promise((resolve) => {
					if (child.exitCode !== null) {
						resolve();
						return;
					}
					child.once('exit', resolve);
					if (endStatus === 'done') {
						child.disconnect();
					} else {
						child.kill('SIGTERM');
					}
				}),
		),
	);

	// One image of every crop a theme produced, labelled with the story it
	// came from: a component on eight pages is one survey, not eight files.
	for (const theme of themeList) {
		const sheetCrops = crops.get(theme);
		if (sheetCrops.length && captioning) {
			const sheet = path.join(dirOf(theme), 'crops.png');
			contactSheet({ crops: sheetCrops, sheet, theme: theme ?? 'dark' });
			say(`  ${sheetCrops.length} crops -> ${sheet}`);
		}
	}

	await server?.close();

	// The diff captions and prices its output from this, so the run's own
	// settings sit next to the shots they produced.
	await writeFile(
		path.join(outDir, 'shots.json'),
		`${JSON.stringify(
			{
				config: runConfig,
				shots: shots.sort((a, b) => a.file.localeCompare(b.file)),
			},
			null,
			'\t',
		)}\n`,
	);

	const busy = shots.filter((shot) => shot.status === 'busy');
	const pageShots = shots.filter((shot) => shot.duration);
	const summary = {
		shots: shots.length,
		ok: pageShots.length - busy.length,
		busy: busy.length,
		failed: failures.length,
		retries: retried.size,
		skipped: total - pageShots.length - failures.length,
		peakPages: peak.pages,
		peakBrowsers: peak.browsers,
		duration: Date.now() - state.started,
		buildDuration: meta.buildDuration,
		busyFiles: busy.map((shot) => shot.file),
		failedKeys: failures.map(([story, theme]) => keyOf(story, theme)),
	};
	const status = endStatus;
	track('end', { status, summary });
	log.close();
	meta.status = status;
	meta.ended = Date.now();
	meta.summary = summary;
	await saveMeta();

	console.log(
		`\n${status}: ${pageShots.length}/${total} stories shot in ${formatDuration(summary.duration)}: ${summary.ok} ok, ${busy.length} busy, ${failures.length} failed, ${retried.size} retried (at most ${peak.pages} pages over ${peak.browsers} browsers)`,
	);
	if (busy.length) {
		console.log(`busy: ${summary.busyFiles.join(', ')}`);
	}
	if (failures.length) {
		console.error(`failed: ${summary.failedKeys.join(', ')}`);
	}
	console.log(`run: ${outDir}`);

	if (opts.notify) {
		notify(
			`sbshot ${meta.name} ${status}`,
			`${pageShots.length}/${total} in ${formatDuration(summary.duration)}, ${failures.length} failed, ${busy.length} busy`,
		);
	}

	if (status !== 'done' || failures.length) {
		return 1;
	}
	return opts['fail-on-busy'] && busy.length ? 1 : 0;
};
