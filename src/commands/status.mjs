import { parseArgs } from 'node:util';

import { readEvents } from '../events.mjs';
import { estimate, fold, formatDuration, progressLine } from '../progress.mjs';
import { eventsFile, listJobs, readMeta, resolveJob, workspaceDir } from '../workspace.mjs';

const DONE = new Set(['done', 'failed', 'interrupted']);

/** The folded state of a job, from its events, with its meta's verdict on liveness. */
export const jobState = (dir) => {
	const meta = readMeta(dir);
	const { events } = readEvents(eventsFile(dir));
	const state = fold(events);
	// A job killed at any point before its end, the storybook build included.
	if (meta?.status === 'interrupted' && !DONE.has(state.status)) {
		state.status = 'interrupted';
	}
	if (!events.length && meta) {
		state.kind = meta.kind;
		state.name = meta.name;
		state.status = meta.status;
		state.started = meta.started;
		state.ended = meta.ended;
	}
	return { meta, state };
};

export const STATUS_HELP = `usage: sbshot status [run|diff|latest] [options]

  --json      print the state as JSON: counts, estimate, active and failed items
  --watch     print a progress line every few seconds until the job ends
  --wait      print nothing until the job ends, then the summary (exit 1 if it
              failed). For an agent that started the job in the background
  --interval <s>  seconds between --watch lines (default 5)`;

const summarize = (state, now = Date.now()) => {
	const e = estimate(state, now);
	const items = Object.values(state.items);
	return {
		kind: state.kind,
		name: state.name,
		status: state.status,
		started: state.started,
		ended: state.ended,
		counts: state.counts,
		estimate: e,
		active: items
			.filter((item) => item.status === 'active')
			.map(({ key, phase, began, expected }) => ({
				key,
				phase,
				elapsed: now - began,
				expected,
			})),
		failed: items
			.filter((item) => item.status === 'failed')
			.map(({ key, error }) => ({ key, error })),
		busy: items.filter((item) => item.status === 'busy').map(({ key }) => key),
		summary: state.summary,
	};
};

const print = (state, now = Date.now()) => {
	const s = summarize(state, now);
	console.log(`${s.kind ?? 'job'} ${s.name}: ${s.status}`);
	if (s.status !== 'building') {
		console.log(`  ${progressLine(state, now)}`);
	}
	if (s.status === 'running' && s.estimate.finishAt) {
		console.log(
			`  finishes around ${new Date(s.estimate.finishAt).toLocaleTimeString()} (${s.estimate.parallelism.toFixed(1)} stories at once)`,
		);
	}
	if (s.status === 'building') {
		const { started, expected } = state.build;
		console.log(
			`  building storybook for ${formatDuration(now - started)}${
				expected ? `, the last build took ${formatDuration(expected)}` : ''
			}`,
		);
	}
	for (const item of s.active.slice(0, 12)) {
		console.log(
			`  > ${item.key} ${item.phase ?? ''} ${formatDuration(item.elapsed)}${
				item.expected ? ` / ~${formatDuration(item.expected)}` : ''
			}`,
		);
	}
	for (const item of s.failed) {
		console.log(`  FAIL ${item.key}: ${item.error}`);
	}
};

export const status = async (argv) => {
	const { values: opts, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			workspace: { type: 'string', short: 'w' },
			json: { type: 'boolean', default: false },
			watch: { type: 'boolean', default: false },
			wait: { type: 'boolean', default: false },
			interval: { type: 'string', default: '5' },
			help: { type: 'boolean', short: 'h', default: false },
		},
	});
	if (opts.help) {
		console.log(STATUS_HELP);
		return 0;
	}
	const workspace = workspaceDir(opts.workspace);
	const dir = resolveJob(workspace, positionals[0] ?? 'latest');
	if (!dir || !readMeta(dir)) {
		console.error(`no job ${positionals[0] ?? ''} in ${workspace}`);
		return 1;
	}
	const seconds = Number(opts.interval);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		console.error(`--interval: not a number of seconds: ${opts.interval}`);
		return 1;
	}

	const output = (state) =>
		opts.json ? console.log(JSON.stringify(summarize(state), null, 2)) : print(state);

	if (!opts.watch && !opts.wait) {
		output(jobState(dir).state);
		return 0;
	}

	const interval = Math.max(seconds, 1) * 1000;
	for (;;) {
		const { state } = jobState(dir);
		if (DONE.has(state.status)) {
			output(state);
			return state.status === 'done' ? 0 : 1;
		}
		if (opts.watch) {
			console.log(`[${progressLine(state)}]`);
		}
		await new Promise((resolve) => setTimeout(resolve, interval));
	}
};

export const runs = async (argv) => {
	const { values: opts } = parseArgs({
		args: argv,
		options: {
			workspace: { type: 'string', short: 'w' },
			json: { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h', default: false },
		},
	});
	if (opts.help) {
		console.log(`usage: sbshot runs [--json] [--workspace dir]

Every run and diff in the workspace, newest first: kind, status, name,
start time, duration and result.`);
		return 0;
	}
	const workspace = workspaceDir(opts.workspace);
	const jobs = listJobs(workspace);
	if (opts.json) {
		console.log(JSON.stringify(jobs, null, 2));
		return 0;
	}
	if (!jobs.length) {
		console.log(`no runs in ${workspace}`);
		return 0;
	}
	for (const job of jobs) {
		const when = job.started ? new Date(job.started).toLocaleString() : '';
		const took = job.ended && job.started ? formatDuration(job.ended - job.started) : '';
		const detail =
			job.kind === 'diff'
				? job.summary
					? `${job.summary.changed} changed, ${job.summary.missing} missing of ${job.summary.pairs}`
					: ''
				: job.summary
					? `${job.summary.shots} shots, ${job.summary.failed} failed, ${job.summary.busy} busy`
					: job.total
						? `${job.total} planned`
						: '';
		console.log(
			`${job.kind.padEnd(7)} ${job.status.padEnd(11)} ${job.name.padEnd(40)} ${when.padEnd(22)} ${took.padEnd(8)} ${detail}`,
		);
	}
	return 0;
};
