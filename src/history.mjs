import path from 'node:path';

import { listJobs, readJson, readMeta, resolveJob } from './workspace.mjs';

/** Each shot's duration in a run, by its file. Empty for a run with no `shots.json`. */
const durationsOf = (dir) =>
	new Map(
		(readJson(path.join(dir, 'shots.json'))?.shots ?? [])
			.filter((shot) => shot.duration)
			.map((shot) => [shot.file, shot.duration]),
	);

/**
 * The earlier run whose durations price a new one's queue and ETA. `ref`
 * names one, `none` asks for none, and by default it is the most recent
 * finished capture covering at least half of `wantedFiles` (else the one of
 * the last 20 covering most of them). `parallelism` is that run's busy time
 * over its wall time: how many stories it kept going at once.
 */
export const pickHistory = ({ workspace, ref, wantedFiles, exclude }) => {
	const none = { dir: null, durations: new Map(), parallelism: null };
	if (ref === 'none') {
		return none;
	}

	let found = null;
	if (ref) {
		const dir = resolveJob(workspace, ref, 'capture');
		if (!dir) {
			throw new Error(`--history: no run ${ref}`);
		}
		found = { dir, durations: durationsOf(dir) };
	} else {
		let best = { overlap: 0 };
		for (const job of listJobs(workspace)
			.filter((job) => job.kind === 'capture' && job.status === 'done' && job.dir !== exclude)
			.slice(0, 20)) {
			const durations = durationsOf(job.dir);
			const overlap = wantedFiles.filter((file) => durations.has(file)).length;
			if (overlap > best.overlap || overlap >= wantedFiles.length / 2) {
				best = { overlap, dir: job.dir, durations };
			}
			if (overlap >= wantedFiles.length / 2) {
				break;
			}
		}
		found = best.dir ? best : null;
	}
	if (!found) {
		return none;
	}

	const wall = readMeta(found.dir)?.summary?.duration;
	const busy = [...found.durations.values()].reduce((sum, value) => sum + value, 0);
	return {
		dir: found.dir,
		durations: found.durations,
		parallelism: wall > 0 && busy > 0 ? busy / wall : null,
	};
};
