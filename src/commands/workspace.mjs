import { existsSync } from 'node:fs';
import { lstat, mkdir, rm, symlink, unlink } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';

import { adoptResults, readMeta, resolveJob, validName, workspaceDir } from '../workspace.mjs';

export const init = async (argv) => {
	const { values: opts, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			workspace: { type: 'string', short: 'w' },
			help: { type: 'boolean', short: 'h', default: false },
		},
	});
	if (opts.help) {
		console.log(`usage: sbshot init [source] [--workspace dir]

Links results that were not made by sbshot, such as the .story-shots folder
the story-shots scripts write, into the workspace. Every directory under
source with a shots.json becomes a run and every one with a diff.json a diff,
linked into runs/ and diffs/ under a name built from its path. Nothing is
moved. Run it again after adding results to link the new ones.

source defaults to ./.story-shots when it exists, else the workspace itself.
Then open the viewer:

  sbshot init && sbshot ui`);
		return 0;
	}
	const workspace = workspaceDir(opts.workspace);
	const source = path.resolve(
		positionals[0] ?? (existsSync('.story-shots') ? '.story-shots' : workspace),
	);
	if (!existsSync(source)) {
		console.error(`${source}: no such directory`);
		return 1;
	}
	await mkdir(workspace, { recursive: true });
	const { linked, known, unreadable } = await adoptResults(source, workspace);
	const here = (file) => path.relative(process.cwd(), file) || '.';
	for (const { link, target } of linked) {
		console.log(`${here(link)} -> ${here(target)}`);
	}
	if (unreadable.length) {
		console.error(
			`skipped ${unreadable.length}, PNGs with no shots.json or diff.json (old diffs, redo them with sbshot diff):`,
		);
		for (const target of unreadable) {
			console.error(`  ${here(target)}`);
		}
	}
	const flag = workspace === workspaceDir() ? '' : ` -w ${here(workspace)}`;
	console.log(
		`${linked.length} linked, ${known.length} already in the workspace. View with: sbshot ui${flag}`,
	);
	return 0;
};

export const link = async (argv) => {
	const { values: opts, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			workspace: { type: 'string', short: 'w' },
			help: { type: 'boolean', short: 'h', default: false },
		},
	});
	const [dir, name] = positionals;
	if (opts.help || !dir || !existsSync(dir)) {
		console[opts.help ? 'log' : 'error'](`usage: sbshot link <dir> [name] [--workspace dir]

Adds one run or diff made elsewhere to the workspace as a symlink, under
runs/ (or diffs/ when <dir> holds a diff.json), named [name] or after <dir>.
Use 'sbshot init' to link a whole folder of results at once.`);
		return opts.help ? 0 : 1;
	}
	const workspace = workspaceDir(opts.workspace);
	const kind = existsSync(path.join(dir, 'diff.json')) ? 'diffs' : 'runs';
	if (name !== undefined && !validName(name)) {
		console.error(
			`${name} is not a name: letters, digits and . _ -, not starting with a dot, and not 'latest'`,
		);
		return 1;
	}
	const target = path.join(workspace, kind, name ?? path.basename(path.resolve(dir)));
	if (existsSync(target)) {
		console.error(`${target} already exists: pass another name`);
		return 1;
	}
	await mkdir(path.dirname(target), { recursive: true });
	await symlink(path.resolve(dir), target);
	console.log(`${target} -> ${path.resolve(dir)}`);
	return 0;
};

/**
 * Deletes jobs by name. A linked run only loses its link, and a build is
 * deleted only when it sits in this workspace's builds/.
 */
export const remove = async (argv) => {
	const { values: opts, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			workspace: { type: 'string', short: 'w' },
			help: { type: 'boolean', short: 'h', default: false },
		},
	});
	if (opts.help || !positionals.length) {
		console[opts.help ? 'log' : 'error'](`usage: sbshot rm <job>... [--workspace dir]

Deletes runs or diffs of the workspace by name, and the storybook build a
run made under builds/. A linked job only loses its link. A job still
running is refused.`);
		return opts.help ? 0 : 1;
	}
	const workspace = workspaceDir(opts.workspace);
	let failed = 0;
	for (const ref of positionals) {
		const dir = resolveJob(workspace, ref);
		const inside = dir && path.dirname(path.dirname(dir)) === workspace;
		if (!dir || !inside) {
			console.error(`${ref}: no such run or diff in ${workspace}`);
			failed += 1;
			continue;
		}
		const meta = readMeta(dir);
		if (['running', 'building'].includes(meta?.status)) {
			console.error(`${ref}: still ${meta.status} (pid ${meta.pid}), stop it first`);
			failed += 1;
			continue;
		}
		if ((await lstat(dir)).isSymbolicLink()) {
			await unlink(dir);
			console.log(`unlinked ${dir}`);
			continue;
		}
		await rm(dir, { recursive: true, force: true });
		console.log(`deleted ${dir}`);
		// Resolved first: the record is only a string, and `builds/..` would
		// otherwise pass for a build.
		const build = typeof meta?.build === 'string' && path.resolve(meta.build);
		if (build && path.dirname(build) === path.join(workspace, 'builds')) {
			await rm(build, { recursive: true, force: true });
			await rm(`${build}.log`, { force: true });
			console.log(`deleted ${build}`);
		}
	}
	return failed ? 1 : 0;
};
