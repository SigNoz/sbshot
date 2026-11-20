import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

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
  --port   port of that page (default: a free one)`);
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
