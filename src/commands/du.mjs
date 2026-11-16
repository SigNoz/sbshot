import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

import { auditWorkspace, parseAge } from '../audit.mjs';
import { findWorkspaces } from '../find.mjs';
import { workspaceUsage } from '../usage.mjs';
import { workspaceDir } from '../workspace.mjs';

/** A byte count for a terminal column. */
export const formatBytes = (value) =>
	value >= 1e9
		? `${(value / 1e9).toFixed(1)} GB`
		: value >= 1e6
			? `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)} MB`
			: `${Math.ceil(value / 1e3)} KB`;

const date = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '-');

/** Columns padded to line up; numbers to the right, names and a trailing text to the left. */
const table = (rows, { left = false } = {}) => {
	const widths = rows[0].map((_, column) =>
		Math.max(...rows.map((row) => String(row[column]).length)),
	);
	return rows
		.map((row) =>
			row
				.map((cell, column) =>
					column === 0
						? String(cell).padEnd(widths[column])
						: left && column === row.length - 1
							? String(cell)
							: String(cell).padStart(widths[column]),
				)
				.join('  '),
		)
		.join('\n');
};

/**
 * The workspaces a command acts on: those found under the paths given, or
 * the current one (`--workspace`, `$SBSHOT_WORKSPACE`, `./.sbshot`).
 */
const workspacesOf = async (paths, flag) =>
	paths.length ? findWorkspaces(paths) : [workspaceDir(flag)];

const COMMON = {
	workspace: { type: 'string', short: 'w' },
	json: { type: 'boolean', default: false },
	help: { type: 'boolean', short: 'h', default: false },
};

export const du = async (argv) => {
	const { values: opts, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			...COMMON,
			open: { type: 'boolean', default: false },
			port: { type: 'string', default: '0' },
		},
	});
	if (opts.help) {
		console.log(`usage: sbshot du [path...] [--json] [--open]

How much disk sbshot takes. Each path is a workspace, or a folder searched
for .sbshot workspaces (node_modules, .git and hidden folders skipped, 6
levels deep). Without a path, the current workspace.

  --json   every workspace and every job, with sizes and image counts
  --open   a page of the workspaces found, each one a click from its viewer
  --port   port of that page (default: a free one)

'sbshot audit' says what of it can go.`);
		return 0;
	}
	let workspaces;
	try {
		workspaces = await workspacesOf(positionals, opts.workspace);
	} catch (error) {
		console.error(error.message);
		return 1;
	}

	if (opts.open) {
		const { serveSizes } = await import('../sizes.mjs');
		const server = await serveSizes({ workspaces, port: Number(opts.port) || 0 });
		console.log(`sbshot du: ${server.url}  (${workspaces.length} workspaces)`);
		const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
		spawn(opener, [server.url], { stdio: 'ignore', detached: true })
			.on('error', () => {})
			.unref();
		return new Promise(() => {});
	}

	const usages = await Promise.all(workspaces.map((dir) => workspaceUsage(dir)()));
	if (opts.json) {
		console.log(JSON.stringify(usages, null, 2));
		return 0;
	}
	if (!usages.length) {
		console.log('no workspace found');
		return 0;
	}
	const rows = usages
		.toSorted((a, b) => b.total - a.total)
		.map((usage) => [
			usage.workspace,
			formatBytes(usage.total),
			formatBytes(usage.runs),
			formatBytes(usage.diffs),
			formatBytes(usage.builds),
			formatBytes(usage.cache),
			formatBytes(usage.imageBytes),
			usage.jobs.length,
			date(usage.lastActivity),
		]);
	const total = usages.reduce((sum, usage) => sum + usage.total, 0);
	console.log(
		table([
			['WORKSPACE', 'TOTAL', 'RUNS', 'DIFFS', 'ORPHAN BUILDS', 'CACHE', 'IMAGES', 'JOBS', 'LAST'],
			...rows,
		]),
	);
	if (usages.length > 1) console.log(`\n${formatBytes(total)} in ${usages.length} workspaces`);
	return 0;
};

export const audit = async (argv) => {
	const { values: opts, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			...COMMON,
			'older-than': { type: 'string', default: '14d' },
			keep: { type: 'string', default: '5' },
			'include-reviewed': { type: 'boolean', default: false },
		},
	});
	if (opts.help) {
		console.log(`usage: sbshot audit [path...] [--older-than 14d] [--keep 5] [--json]

Says which runs and diffs can lose their images, and how much that frees.
It deletes nothing: --json carries, for each job, the reasons and the exact
command that deletes its images, for a person or an agent to run.

A prune deletes images only (png, webp, gif, jpg). sbshot.json,
events.ndjson, shots.json, diff.json, verdicts and tags stay, so the job
keeps its history, its timings and its results.

A job is kept when it is running, one of the newest --keep of its
workspace, younger than --older-than (14d, 36h, 90m), a diff with verdicts
or tags (unless --include-reviewed), or a run or noise floor a kept diff
compares. The thumbnail cache and builds no run points at are listed apart.

Paths work as in 'sbshot du': workspaces, or folders searched for them.`);
		return 0;
	}
	const olderThan = parseAge(opts['older-than']);
	const keep = Number(opts.keep);
	if (olderThan === null) {
		console.error(`--older-than: not an age: ${opts['older-than']} (try 14d, 36h, 90m)`);
		return 1;
	}
	if (!Number.isInteger(keep) || keep < 0) {
		console.error(`--keep: not a whole number: ${opts.keep}`);
		return 1;
	}
	let workspaces;
	try {
		workspaces = await workspacesOf(positionals, opts.workspace);
	} catch (error) {
		console.error(error.message);
		return 1;
	}
	const reports = await Promise.all(
		workspaces.map((dir) =>
			auditWorkspace(dir, { olderThan, keep, includeReviewed: opts['include-reviewed'] }),
		),
	);
	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					settings: {
						olderThanDays: olderThan / 86_400_000,
						keep,
						includeReviewed: opts['include-reviewed'],
					},
					frees: reports.reduce((sum, report) => sum + report.frees, 0),
					extraBytes: reports.reduce((sum, report) => sum + report.extraBytes, 0),
					workspaces: reports,
				},
				null,
				2,
			),
		);
		return 0;
	}
	for (const report of reports) {
		console.log(
			`${report.workspace}: ${formatBytes(report.total)}, ${formatBytes(report.imageBytes)} of images`,
		);
		const prune = report.jobs
			.filter((job) => job.suggest === 'prune')
			.toSorted((a, b) => b.imageBytes - a.imageBytes);
		if (prune.length) {
			console.log(
				table(
					[
						['  PRUNE', 'KIND', 'AGE', 'IMAGES', 'FREES', 'WHY'],
						...prune.map((job) => [
							`  ${job.name}`,
							job.kind === 'capture' ? 'run' : 'diff',
							job.ageDays === null ? '-' : `${job.ageDays}d`,
							job.images,
							formatBytes(job.imageBytes),
							job.reasons.join('; '),
						]),
					],
					{ left: true },
				),
			);
		}
		console.log(
			`  ${report.counts.prune} to prune (frees ${formatBytes(report.frees)}), ${report.counts.keep} kept, ${report.counts.noImages} with no images`,
		);
		for (const item of report.extra) {
			console.log(`  also: ${item.kind} ${item.dir} ${formatBytes(item.bytes)} (${item.note})`);
		}
		console.log('');
	}
	console.log('Nothing was deleted. --json has the reasons and the delete command of each job.');
	return 0;
};
