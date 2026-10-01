import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';

import { exportPlan, isExportZip, writeExport, writeZip } from '../export.mjs';
import { resolveJob, workspaceDir } from '../workspace.mjs';

export const exportJobs = async (argv) => {
	const { values: opts, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			workspace: { type: 'string', short: 'w' },
			out: { type: 'string', short: 'o' },
			zip: { type: 'boolean', default: false },
			all: { type: 'boolean', default: false },
			runs: { type: 'boolean', default: false },
			png: { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h', default: false },
		},
	});
	if (opts.help) {
		console.log(`usage: sbshot export [job...] [--out dir] [--zip] [--all] [--runs] [--png]

Writes finished diffs and runs as a static site: the viewer, read-only, with
the images it needs. Serve the folder from any static host (Cloudflare Pages,
GitHub Pages, S3) and send the link. With one diff the page opens on it.

  job         diffs or runs, by name or path (default: the latest diff)
  --out dir   where to write it (default: <workspace>/exports/<name>). A
              folder that is not empty is only replaced if it is an export
  --zip       write <out>.zip instead of a folder. A file that is there is
              only replaced if it is an export
  --all       keep the identical pairs of a diff, not only changed and missing
  --runs      add the two runs each diff compared, every shot of them
  --png       keep the shots as PNG. By default they become lossless WebP,
              about a third of the size and the same pixels (needs
              ImageMagick with WebP; without it they stay PNG)

Local paths are left out: the page shows job names only.`);
		return 0;
	}
	const workspace = workspaceDir(opts.workspace);
	const refs = positionals.length ? positionals : ['latest:diff'];
	const dirs = refs.map((ref) => {
		const dir = resolveJob(workspace, ref);
		if (!dir) {
			throw new Error(`no job ${ref} in ${workspace}`);
		}
		return dir;
	});
	const plan = exportPlan(workspace, dirs, { all: opts.all, runs: opts.runs, png: opts.png });
	const out = path.resolve(opts.out ?? path.join(workspace, 'exports', plan.name));
	const files = plan.entries.length;
	if (opts.zip) {
		const target = out.endsWith('.zip') ? out : `${out}.zip`;
		if (existsSync(target) && !isExportZip(target)) {
			throw new Error(`${target} exists and is not an earlier export`);
		}
		await mkdir(path.dirname(target), { recursive: true });
		// Written aside and moved into place, so a failure leaves no half a zip.
		const partial = `${target}.partial`;
		try {
			await writeZip(plan, createWriteStream(partial), path.basename(target, '.zip'));
			await rename(partial, target);
		} catch (error) {
			await rm(partial, { force: true });
			throw error;
		}
		console.log(`${files} files -> ${target}`);
	} else {
		await writeExport(plan, out);
		console.log(`${files} files -> ${out}`);
	}
	return 0;
};
