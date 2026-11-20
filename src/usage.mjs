import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { KINDS, listJobs } from './workspace.mjs';

/** What a file takes on disk, as `du` counts it, or its length where blocks are not reported. */
const onDisk = (info) => (Number.isFinite(info.blocks) ? info.blocks * 512 : info.size);

/**
 * Bytes a file or directory takes on disk, links not followed. The walk
 * reads a directory at a time and stats its entries together, so a run of
 * thousands of shots does not hold the viewer for the whole walk.
 */
export const diskUsage = async (target) => {
	let info;
	try {
		info = await lstat(target);
	} catch {
		return 0;
	}
	if (!info.isDirectory()) {
		return onDisk(info);
	}
	let entries;
	try {
		entries = await readdir(target);
	} catch {
		return onDisk(info);
	}
	const sizes = await Promise.all(entries.map((entry) => diskUsage(path.join(target, entry))));
	return sizes.reduce((sum, size) => sum + size, onDisk(info));
};

/**
 * When a directory last changed, as far as a cheap look can tell: its own
 * mtime and those of the directories right under it. A run writes its shots
 * one level down (`<theme>/<id>.png`), so a new shot moves the stamp.
 */
const stampOf = async (dir) => {
	try {
		const own = await stat(dir);
		const children = await readdir(dir, { withFileTypes: true });
		const times = await Promise.all(
			children
				.filter((entry) => entry.isDirectory())
				.map((entry) =>
					stat(path.join(dir, entry.name)).then(
						(child) => child.mtimeMs,
						() => 0,
					),
				),
		);
		return `${own.mtimeMs}:${Math.max(0, ...times)}:${children.length}`;
	} catch {
		return 'gone';
	}
};

/** A size kept until the directory's stamp moves, or `ttl` ms pass. */
const sizeCache = (ttl) => {
	const cache = new Map();
	return async (dir) => {
		const stamp = await stampOf(dir);
		const kept = cache.get(dir);
		if (kept && kept.stamp === stamp && Date.now() - kept.at < ttl) {
			return kept.size;
		}
		const size = diskUsage(dir);
		cache.set(dir, { stamp, at: Date.now(), size });
		size.catch(() => cache.delete(dir));
		return size;
	};
};

/**
 * What a workspace takes on disk, split so the human can see what to delete:
 * each run and diff (a run with the build it made, which `sbshot rm` deletes
 * with it), builds no run claims, the thumbnail cache, and the rest. A job
 * linked in from elsewhere is sized where it lives and kept out of the total,
 * since deleting it here only removes the link.
 */
export const workspaceUsage = (workspace) => {
	const sizeOf = sizeCache(10 * 60_000);
	return async () => {
		const jobs = listJobs(workspace);
		const buildsDir = path.join(workspace, 'builds');
		const claimed = new Set();
		const rows = await Promise.all(
			jobs.map(async (job) => {
				const linked = (await lstat(job.dir).catch(() => null))?.isSymbolicLink() ?? false;
				const real = await realpath(job.dir).catch(() => job.dir);
				const own = await sizeOf(real);
				const build =
					typeof job.build === 'string' && path.dirname(path.resolve(job.build)) === buildsDir
						? path.resolve(job.build)
						: null;
				let buildSize = 0;
				if (build) {
					claimed.add(path.basename(build));
					buildSize = (await sizeOf(build)) + (await diskUsage(`${build}.log`));
				}
				return {
					kind: job.kind,
					name: job.name,
					dir: job.dir,
					size: own + buildSize,
					build: buildSize,
					linked,
				};
			}),
		);

		const top = await readdir(workspace, { withFileTypes: true }).catch(() => []);
		let builds = 0;
		let cache = 0;
		// The workspace directory's own entry, the way `du` counts it.
		let other = await lstat(workspace).then(onDisk, () => 0);
		for (const entry of top) {
			const full = path.join(workspace, entry.name);
			if (Object.values(KINDS).includes(entry.name)) {
				// The jobs are sized above. What is left here is anything that is not a
				// job, and the links themselves, which take a block of their own.
				const inside = await readdir(full).catch(() => []);
				const listed = new Set(
					rows
						.filter((row) => !row.linked && path.dirname(row.dir) === full)
						.map((row) => path.basename(row.dir)),
				);
				for (const name of inside) {
					if (!listed.has(name)) {
						other += await diskUsage(path.join(full, name));
					}
				}
				other += onDisk(await lstat(full));
			} else if (entry.name === 'builds') {
				const inside = await readdir(full).catch(() => []);
				for (const name of inside) {
					const owner = name.endsWith('.log') ? name.slice(0, -4) : name;
					if (!claimed.has(owner)) {
						builds += name.endsWith('.log')
							? await diskUsage(path.join(full, name))
							: await sizeOf(path.join(full, name));
					}
				}
				other += onDisk(await lstat(full));
			} else if (entry.name === '.cache') {
				cache += await sizeOf(full);
			} else {
				other += await diskUsage(full);
			}
		}

		const inWorkspace = rows.filter((row) => !row.linked).reduce((sum, row) => sum + row.size, 0);
		return {
			total: inWorkspace + builds + cache + other,
			runs: rows
				.filter((row) => row.kind === 'capture' && !row.linked)
				.reduce((sum, row) => sum + row.size, 0),
			diffs: rows
				.filter((row) => row.kind === 'diff' && !row.linked)
				.reduce((sum, row) => sum + row.size, 0),
			linked: rows.filter((row) => row.linked).reduce((sum, row) => sum + row.size, 0),
			builds,
			cache,
			other,
			jobs: rows,
		};
	};
};
