import { realpathSync } from 'node:fs';
import path from 'node:path';

import { readReview, readTags } from './review.mjs';
import { IMAGE_EXTENSIONS, workspaceUsage } from './usage.mjs';
import { readJson } from './workspace.mjs';

const DAY = 24 * 60 * 60 * 1000;

/** A path as one shell word, for commands an agent pastes as they are. */
const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

/** The command that deletes a directory's images and leaves everything else. */
export const pruneCommand = (dir) =>
	`find ${quote(dir)} -type f \\( ${IMAGE_EXTENSIONS.map((ext) => `-name '*${ext}'`).join(' -o ')} \\) -delete`;

const real = (dir) => {
	try {
		return realpathSync(dir);
	} catch {
		return path.resolve(dir);
	}
};

/** `14d`, `36h`, `90m` or a number of days, in ms. */
export const parseAge = (value) => {
	const match = /^(\d+(?:\.\d+)?)([dhm]?)$/.exec(String(value).trim());
	if (!match) {
		return null;
	}
	return Number(match[1]) * { d: DAY, h: DAY / 24, m: DAY / 1440, '': DAY }[match[2]];
};

/**
 * What can go from one workspace, and why each job stays or goes. Nothing
 * is deleted: the answer carries the commands, and whoever reads it decides.
 *
 * A prune deletes images only. `sbshot.json`, `events.ndjson`, `shots.json`,
 * `diff.json`, verdicts and tags stay, so the job keeps its history, its
 * timings (which price the next run) and its results.
 *
 * A job is kept when it is still running, among the newest `keep`, younger
 * than `olderThan`, a diff someone reviewed (verdicts or tags) unless
 * `includeReviewed`, or a run or noise-floor diff that a kept diff compares:
 * a diff shows the images of the runs it compared.
 */
export const auditWorkspace = async (
	workspace,
	{ olderThan = 14 * DAY, keep = 5, includeReviewed = false, now = Date.now() } = {},
) => {
	const usage = await workspaceUsage(workspace)();
	const jobs = usage.jobs.map((row) => {
		const job = {
			kind: row.kind,
			name: row.name,
			dir: row.dir,
			status: row.status,
			started: row.started ?? null,
			ended: row.ended ?? null,
			ageDays: null,
			size: row.size,
			images: row.images,
			imageBytes: row.imageBytes,
			linked: row.linked,
			build: row.buildDir
				? {
						dir: row.buildDir,
						bytes: row.build,
						note: 'not part of a prune: open in storybook serves the run from it',
						command: `rm -rf ${quote(row.buildDir)} ${quote(`${row.buildDir}.log`)}`,
					}
				: null,
			compares: [],
			usedBy: [],
			suggest: 'keep',
			reasons: [],
			commands: [],
		};
		const at = job.ended ?? job.started;
		job.ageDays = at ? Math.floor((now - at) / DAY) : null;
		if (row.kind === 'diff') {
			const review = readReview(row.real);
			const tags = readTags(row.real);
			job.review = {
				verdicts: Object.keys(review).length,
				tags: Object.keys(tags).length,
			};
			const meta = readJson(path.join(row.real, 'sbshot.json')) ?? {};
			const diff = readJson(path.join(row.real, 'diff.json')) ?? {};
			job.compares = [meta.base ?? diff.base, meta.after ?? diff.after, diff.config?.noise]
				.filter((dir) => typeof dir === 'string')
				.map(real);
		}
		job.real = row.real;
		return job;
	});

	const byDir = new Map(jobs.map((job) => [real(job.real), job]));
	for (const job of jobs) {
		for (const dir of job.compares) {
			byDir.get(dir)?.usedBy.push(job.name);
		}
	}

	// Newest first, as listJobs sorts them.
	jobs.forEach((job, index) => {
		const keepFor = [];
		if (['running', 'building'].includes(job.status)) {
			keepFor.push(`still ${job.status}`);
		}
		if (index < keep) {
			keepFor.push(`one of the newest ${keep}`);
		}
		if (job.ageDays !== null && now - (job.ended ?? job.started) < olderThan) {
			keepFor.push(`younger than ${Math.round(olderThan / DAY)} days`);
		}
		if (job.review && (job.review.verdicts || job.review.tags) && !includeReviewed) {
			keepFor.push(`reviewed: ${job.review.verdicts} verdicts, ${job.review.tags} tags`);
		}
		job.reasons = keepFor;
		job.suggest = keepFor.length ? 'keep' : 'prune';
	});

	// A kept diff keeps what it compares, and that may reach further (a noise
	// floor diff compares runs of its own).
	let changed = true;
	while (changed) {
		changed = false;
		for (const job of jobs) {
			if (job.suggest !== 'keep') continue;
			for (const dir of job.compares) {
				const used = byDir.get(dir);
				if (used && used.suggest === 'prune') {
					used.suggest = 'keep';
					used.reasons.push(`compared by kept diff ${job.name}`);
					changed = true;
				}
			}
		}
	}

	for (const job of jobs) {
		if (job.suggest === 'prune' && job.images === 0) {
			job.suggest = 'no-images';
			job.reasons = ['no images to delete: pruned already, or a diff with no changed pairs'];
		}
		if (job.suggest === 'prune') {
			job.reasons.push(
				job.ageDays === null ? 'no recorded date' : `${job.ageDays} days old`,
				...(job.usedBy.length ? [`its diffs are pruned too: ${job.usedBy.join(', ')}`] : []),
			);
			job.commands.push(pruneCommand(job.real));
			if (job.linked) {
				job.reasons.push(`linked: its images live in ${job.real}, outside the workspace`);
			}
		}
		delete job.real;
	}

	const prune = jobs.filter((job) => job.suggest === 'prune');
	const extra = [
		...(usage.cache
			? [
					{
						kind: 'thumbnail-cache',
						dir: path.join(workspace, '.cache'),
						bytes: usage.cache,
						note: 'thumbnails the viewer rebuilds on demand',
						command: `rm -rf ${quote(path.join(workspace, '.cache'))}`,
					},
				]
			: []),
		...usage.orphanBuilds.map((build) => ({
			kind: 'orphan-build',
			dir: build.dir,
			bytes: build.bytes,
			note: 'a storybook build no run of the workspace points at',
			command: `rm -rf ${quote(build.dir)} ${quote(`${build.dir}.log`)}`,
		})),
	];
	return {
		workspace,
		total: usage.total,
		imageBytes: usage.imageBytes,
		frees: prune.reduce((sum, job) => sum + job.imageBytes, 0),
		extraBytes: extra.reduce((sum, item) => sum + item.bytes, 0),
		counts: {
			jobs: jobs.length,
			prune: prune.length,
			keep: jobs.filter((job) => job.suggest === 'keep').length,
			noImages: jobs.filter((job) => job.suggest === 'no-images').length,
		},
		jobs,
		extra,
	};
};
