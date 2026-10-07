import { parseArgs } from 'node:util';
import path from 'node:path';

import { readReview, readTags, setVerdict, VERDICTS } from '../review.mjs';
import { readJson, resolveJob, workspaceDir } from '../workspace.mjs';

export const review = async (argv) => {
	const { values: opts, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			workspace: { type: 'string', short: 'w' },
			json: { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h', default: false },
		},
	});
	if (opts.help) {
		console.log(`usage: sbshot review [diff] [--json]
       sbshot review <diff> <file> <${VERDICTS.join('|')}> [note]

Lists the verdicts left on a diff's pairs (in the UI or here), or sets one.`);
		return 0;
	}
	const workspace = workspaceDir(opts.workspace);
	const [ref, file, verdict, ...note] = positionals;
	const dir = resolveJob(workspace, ref ?? 'latest:diff', 'diff');
	const diff = dir && readJson(path.join(dir, 'diff.json'));
	if (!diff) {
		console.error(`no diff ${ref ?? ''} in ${workspace}`);
		return 1;
	}
	if (file) {
		if (!VERDICTS.includes(verdict)) {
			console.error(`verdict must be one of ${VERDICTS.join(', ')}`);
			return 1;
		}
		setVerdict(dir, file, verdict, note.join(' '));
	}
	const verdicts = readReview(dir);
	const tags = Object.entries(readTags(dir));
	const tagsOf = (file) =>
		tags.filter(([, entry]) => entry.files.includes(file)).map(([name]) => name);
	const changed = diff.results.filter((pair) => pair.changed > 0);
	if (opts.json) {
		console.log(
			JSON.stringify(
				changed.map((pair) => ({
					...pair,
					review: verdicts[pair.file] ?? null,
					tags: tagsOf(pair.file),
				})),
				null,
				2,
			),
		);
		return 0;
	}
	const pending = changed.filter((pair) => !verdicts[pair.file]);
	for (const pair of changed) {
		const entry = verdicts[pair.file];
		console.log(
			`${(entry?.verdict ?? 'pending').padEnd(10)} ${String(pair.changed).padStart(9)}  ${pair.file}${
				entry?.note ? `  ${entry.note}` : ''
			}${pair.flaky ? '  (flaky)' : ''}`,
		);
	}
	console.log(`\n${changed.length - pending.length}/${changed.length} reviewed`);
	return 0;
};
