import { parseArgs } from 'node:util';
import path from 'node:path';

import { matchPairs, readTags, setTags, TAG_NAME } from '../review.mjs';
import { readJson, resolveJob, workspaceDir } from '../workspace.mjs';

export const tag = async (argv) => {
	const { values: opts, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			workspace: { type: 'string', short: 'w' },
			note: { type: 'string' },
			theme: { type: 'string' },
			remove: { type: 'boolean', default: false },
			json: { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h', default: false },
		},
	});
	if (opts.help) {
		console.log(`usage: sbshot tag [diff] [--json]
       sbshot tag <diff> <tag>[,<tag>...] <pair>... [--note text] [--theme dark,light]
       sbshot tag <diff> <tag>[,<tag>...] --remove [pair...]

Groups a diff's pairs under tags the viewer filters by
(#/job/diff/<diff>?tag=<tag>[,<tag>...] shows the pairs holding every tag named).
A <pair> is a file (dark/<id>.png), a story id (every theme of it), or either
with * wildcards. A pattern that names no pair fails the command and writes nothing.

  --note <text>     what the tag means, shown in the viewer (set on every tag named)
  --theme <list>    only the pairs of these themes
  --remove          take the pairs off the tags; with no pairs, drop the tags`);
		return 0;
	}
	const workspace = workspaceDir(opts.workspace);
	const [ref, name, ...patterns] = positionals;
	const names = name?.split(',').filter(Boolean) ?? [];
	const dir = resolveJob(workspace, ref ?? 'latest:diff', 'diff');
	const diff = dir && readJson(path.join(dir, 'diff.json'));
	if (!diff) {
		console.error(`no diff ${ref ?? ''} in ${workspace}`);
		return 1;
	}
	if (name) {
		if (!names.length || !names.every((tag) => TAG_NAME.test(tag))) {
			console.error('a tag is letters, digits and . _ : -, and commas separate tags');
			return 1;
		}
		const themes = opts.theme?.split(',').filter(Boolean);
		const files = diff.results
			.map((pair) => pair.file)
			.filter((file) => !themes || themes.includes(file.split('/')[0]));
		const { matched, unmatched } = matchPairs(files, patterns);
		if (unmatched.length) {
			console.error(`no pair matches ${unmatched.join(', ')}`);
			return 1;
		}
		if (!matched.length && !opts.remove && opts.note === undefined) {
			console.error('name the pairs to tag, or pass --note or --remove');
			return 1;
		}
		setTags(dir, names, matched, { note: opts.note, remove: opts.remove });
	}
	const tags = readTags(dir);
	if (opts.json) {
		console.log(JSON.stringify(tags, null, 2));
		return 0;
	}
	for (const [tagName, entry] of Object.entries(tags)) {
		console.log(
			`${tagName.padEnd(20)} ${String(entry.files.length).padStart(4)}  ${entry.note ?? ''}`,
		);
	}
	if (!Object.keys(tags).length) console.log('no tags');
	const url = `#/job/diff/${encodeURIComponent(path.basename(dir))}?tag=`;
	const kept = names.filter((tag) => tags[tag]);
	if (kept.length) console.log(`\nviewer: ${url}${kept.map(encodeURIComponent).join(',')}`);
	return 0;
};
