import path from 'node:path';

import { estimate } from './progress.mjs';
import { readReview, readTags } from './review.mjs';
import { readJson } from './workspace.mjs';

/**
 * What the viewer's API says about a job, shared by the server, which answers
 * it live, and `export`, which freezes it into a static site.
 */

/** A row of the job list: the job's meta merged with its folded state. */
export const jobSummary = (job, state) => ({
	kind: job.kind,
	name: job.name,
	dir: job.dir,
	status:
		job.status === 'interrupted'
			? 'interrupted'
			: state.status !== 'pending'
				? state.status
				: job.status,
	started: job.started,
	ended: job.ended,
	total: state.total || job.total,
	counts: state.counts,
	estimate: estimate(state),
	summary: job.summary,
	base: job.base,
	after: job.after,
	storybook: job.storybook,
	legacy: job.legacy,
});

/** A job's page: its summary and results (`diff.json`, verdicts and tags, or `shots.json`). */
export const jobDetail = (kind, dir, summary) =>
	kind === 'diff'
		? {
				job: summary,
				dir,
				diff: readJson(path.join(dir, 'diff.json')),
				review: readReview(dir),
				tags: readTags(dir),
			}
		: { job: summary, dir, shots: readJson(path.join(dir, 'shots.json')) };
