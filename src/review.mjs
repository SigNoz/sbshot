import { renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { readJson } from './workspace.mjs';

/**
 * Verdicts a human (in the viewer) or an agent (with `sbshot review`) leaves
 * on the pairs of a diff, kept in `<diff>/review.json` keyed by pair file.
 */
export const VERDICTS = ['expected', 'regression', 'flaky', 'clear'];

/**
 * Read, changed and written back in one synchronous go, so two verdicts the
 * viewer sends at once cannot drop one, and written beside the file and
 * renamed over it, so a crash leaves the old file rather than half of one.
 */
const writeJson = (file, value) => {
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, '\t')}\n`);
	renameSync(temporary, file);
};

const reviewFile = (dir) => path.join(dir, 'review.json');

export const readReview = (dir) => readJson(reviewFile(dir)) ?? {};

/** Sets or clears the verdict on one pair of the diff; a file that is no pair of it is refused. */
export const setVerdict = (dir, file, verdict, note) => {
	const review = readReview(dir);
	if (verdict === 'clear') {
		delete review[file];
	} else {
		const pairs = readJson(path.join(dir, 'diff.json'))?.results;
		if (!Array.isArray(pairs) || !pairs.some((pair) => pair.file === file)) {
			throw new Error(`no pair ${file} in ${path.basename(dir)}`);
		}
		review[file] = { verdict, note: note ? String(note) : undefined, at: Date.now() };
	}
	writeJson(reviewFile(dir), review);
	return review;
};

/**
 * Named groups of pairs, so an agent can hand the human a filter instead of a
 * list of files. Kept in `<diff>/tags.json` as `{ tag: { note, files } }`.
 */
// `__proto__` would set the prototype of the tag map instead of adding a tag.
export const TAG_NAME = /^(?!__proto__$)[\w.:-]+$/;

const tagsFile = (dir) => path.join(dir, 'tags.json');

export const readTags = (dir) => readJson(tagsFile(dir)) ?? {};

const storyId = (file) => path.basename(file, '.png');

const globRegex = (glob) =>
	new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

/**
 * The pair files each pattern names: a file (`dark/<id>.png`), a story id (every
 * theme of it), or either with `*` wildcards. `unmatched` lists the patterns
 * that named nothing, so a typo is not silently dropped.
 */
export const matchPairs = (files, patterns) => {
	const matched = new Set();
	const unmatched = [];
	for (const pattern of patterns) {
		const test = pattern.includes('*')
			? (
					(regex) => (file) =>
						regex.test(file) || regex.test(storyId(file))
				)(globRegex(pattern))
			: (file) => file === pattern || storyId(file) === pattern;
		const hits = files.filter(test);
		if (!hits.length) unmatched.push(pattern);
		for (const file of hits) matched.add(file);
	}
	return { matched: [...matched], unmatched };
};

/**
 * Adds files to each tag (or takes them off with `remove`), and sets each
 * tag's note when one is given. One write, so the tags change together.
 */
export const setTags = (dir, names, files, { note, remove = false } = {}) => {
	const tags = readTags(dir);
	for (const tag of names) {
		const entry = (Object.hasOwn(tags, tag) && tags[tag]) || { files: [] };
		const kept = new Set(Array.isArray(entry.files) ? entry.files : []);
		for (const file of files) {
			if (remove) kept.delete(file);
			else kept.add(file);
		}
		if (remove && (!files.length || !kept.size)) {
			delete tags[tag];
		} else {
			tags[tag] = { note: note ?? entry.note, files: [...kept].sort() };
		}
	}
	writeJson(tagsFile(dir), tags);
	return tags;
};
