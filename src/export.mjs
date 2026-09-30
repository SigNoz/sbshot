import { crc32 } from 'node:zlib';
import { once } from 'node:events';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { magickAsync, writesWebp } from './caption.mjs';
import { readEvents } from './events.mjs';
import { jobDetail, jobSummary } from './jobs.mjs';
import { dimensionsOf } from './png.mjs';
import { fold } from './progress.mjs';
import { defaultName, eventsFile, listJobs, readJson, readMeta } from './workspace.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const UI = path.join(ROOT, 'ui');

/**
 * Whether `rel` is a path that stays where it is joined: relative, forward
 * slashes, no `.` or `..` step. Every path in `shots.json` and `diff.json`,
 * which a linked job brings from anywhere, and every entry of a site is one.
 */
const contained = (rel) =>
	typeof rel === 'string' &&
	rel.split('/').every((part) => part && part !== '.' && part !== '..' && !part.includes('\\'));

/**
 * Finished runs and diffs as a static site any file host serves: the viewer's
 * own files, the API answers they would get frozen as JSON under `api/`, and
 * the images those answers point at under `files/`. The page sees
 * `data-static` on <html> and reads the JSON instead of the server, read-only.
 *
 * A diff takes only its changed and missing pairs unless `all`, and the
 * shots those pairs need; `runs` adds the two runs it compared, whole.
 * Absolute paths never leave the machine: every directory becomes its path
 * in the site, and a storybook or history path its last segment.
 *
 * Shots go out as lossless WebP, about a third of the PNG, pixel for pixel
 * the same, unless `png` or ImageMagick cannot write WebP. WebP stops at
 * 16383 pixels a side, so a taller shot stays PNG; `api/jobs.json` lists
 * those, and the page asks for `.webp` in place of every other `.png`.
 */
export const exportPlan = (workspace, dirs, { all = false, runs = false, png = false } = {}) => {
	// A diff may name a run that has been deleted since.
	const real = (dir) => (existsSync(dir) ? realpathSync(dir) : path.resolve(dir));
	const known = new Map(listJobs(workspace).map((job) => [real(job.dir), job]));
	const metaOf = (dir) => known.get(real(dir)) ?? readMeta(dir);

	// Each job's name in the site, unique, and the same wherever it shows up.
	const names = new Map();
	const taken = new Set();
	const siteDir = (kind, dir) => {
		const key = real(dir);
		if (!names.has(key)) {
			const base = String(metaOf(dir)?.name ?? path.basename(dir))
				.replace(/[^\w.-]/g, '_')
				.replace(/^\./, '_');
			let name = base;
			for (let n = 2; taken.has(`${kind}/${name}`); n += 1) {
				name = `${base}-${n}`;
			}
			taken.add(`${kind}/${name}`);
			names.set(key, { name, dir: `files/${kind === 'diff' ? 'diffs' : 'runs'}/${name}` });
		}
		return names.get(key);
	};

	// A file goes in only from inside its job, links followed: the paths are
	// what a job's JSON says, and the site is meant to be published.
	const files = new Map();
	const addFile = (site, dir, rel) => {
		if (!contained(rel)) {
			throw new Error(`${dir}: ${JSON.stringify(rel)} is not a path inside it`);
		}
		const file = path.join(dir, rel);
		if (!existsSync(file)) {
			return;
		}
		if (!realpathSync(file).startsWith(`${realpathSync(dir)}${path.sep}`)) {
			throw new Error(`${dir}: ${rel} leads out of it`);
		}
		files.set(`${site}/${rel}`, file);
	};

	/** A run a diff names, which must be one when it is still there. */
	const runOf = (dir, side) => {
		if (typeof dir !== 'string' || (existsSync(dir) && metaOf(dir)?.kind !== 'capture')) {
			throw new Error(`the ${side} of a diff is not a run: ${dir}`);
		}
		return dir;
	};

	const finished = (dir, kind) => {
		const meta = metaOf(dir);
		if (!meta || meta.kind !== kind) {
			throw new Error(`${dir} is not a ${kind === 'diff' ? 'diff' : 'run'}`);
		}
		if (['running', 'building'].includes(meta.status)) {
			throw new Error(`${meta.name} is still running`);
		}
		return meta;
	};

	const stateOf = (dir) => {
		const state = fold(readEvents(eventsFile(dir)).events);
		state.base = state.base && siteDir('capture', state.base).dir;
		state.after = state.after && siteDir('capture', state.after).dir;
		state.storybook = state.storybook && path.basename(state.storybook);
		state.history = state.history && path.basename(state.history);
		if (state.build) state.build.dir = path.basename(state.build.dir ?? '');
		state.logs = [];
		return state;
	};

	const pages = [];
	const page = (kind, dir, detail, state) => {
		const meta = metaOf(dir);
		const { name, dir: site } = siteDir(kind, dir);
		const summary = {
			...jobSummary(meta, state),
			name,
			dir: site,
			base: detail.diff?.base ?? null,
			after: detail.diff?.after ?? null,
			storybook: meta.storybook && path.basename(meta.storybook),
		};
		pages.push(summary);
		return [
			[`api/${kind}/${name}.json`, { ...detail, job: summary, dir: site }],
			[`api/${kind}/${name}.state.json`, state],
		];
	};

	const data = [];
	const runDirs = dirs.filter((dir) => metaOf(dir)?.kind === 'capture');
	for (const dir of dirs.filter((candidate) => !runDirs.includes(candidate))) {
		finished(dir, 'diff');
		const diff = readJson(path.join(dir, 'diff.json'));
		if (!diff) {
			throw new Error(`${dir} has no diff.json`);
		}
		const { dir: site } = siteDir('diff', dir);
		const baseDir = runOf(diff.base, 'baseline');
		const afterDir = runOf(diff.after, 'after');
		const base = siteDir('capture', baseDir).dir;
		const after = siteDir('capture', afterDir).dir;
		const results = all
			? diff.results
			: diff.results.filter((pair) => pair.changed > 0 || pair.note);
		for (const pair of results) {
			if (pair.note !== 'missing previous') addFile(base, baseDir, pair.file);
			if (pair.note !== 'missing current') addFile(after, afterDir, pair.file);
			if (pair.output && !pair.note) addFile(site, dir, pair.output);
			if (pair.plain) addFile(site, dir, pair.plain);
		}
		if (runs) {
			runDirs.push(baseDir, afterDir);
		}
		const detail = jobDetail('diff', dir, null);
		detail.diff = {
			...diff,
			base,
			after,
			config: { ...diff.config, noise: diff.config?.noise && path.basename(diff.config.noise) },
			results,
		};
		data.push(...page('diff', dir, detail, stateOf(dir)));
	}
	const seen = new Set();
	for (const dir of runDirs) {
		if (seen.has(real(dir))) continue;
		seen.add(real(dir));
		finished(dir, 'capture');
		const detail = jobDetail('capture', dir, null);
		if (!detail.shots) {
			throw new Error(`${dir} has no shots.json`);
		}
		const { dir: site } = siteDir('capture', dir);
		for (const shot of detail.shots.shots) {
			addFile(site, dir, shot.file);
		}
		data.push(...page('capture', dir, detail, stateOf(dir)));
	}

	const webp = !png && writesWebp();
	const kept = [];
	const images = [...files].map(([site, file]) => {
		const { width, height } = dimensionsOf(file);
		if (webp && site.endsWith('.png') && width && Math.max(width, height) <= WEBP_MAX) {
			return { path: `${site.slice(0, -4)}.webp`, file, webp: true };
		}
		if (webp) kept.push(site);
		return { path: site, file };
	});

	// The page opens on the one diff, or the one job, when there is one.
	const diffs = pages.filter((job) => job.kind === 'diff');
	const first = diffs.length === 1 ? diffs[0] : pages.length === 1 ? pages[0] : null;
	data.push([
		'api/jobs.json',
		{
			workspace: 'static export',
			jobs: pages,
			start: first && `#/job/${first.kind}/${encodeURIComponent(first.name)}`,
			images: webp ? 'webp' : 'png',
			png: kept,
		},
	]);

	const entries = [];
	const html = readFileSync(path.join(UI, 'index.html'), 'utf8').replace(
		'<html lang="en">',
		'<html lang="en" data-static>',
	);
	entries.push({ path: 'index.html', data: Buffer.from(html) });
	for (const file of readdirSync(UI).filter((name) => /\.(js|css)$/.test(name))) {
		entries.push({ path: file, file: path.join(UI, file) });
	}
	entries.push({ path: 'lib/progress.mjs', file: path.join(ROOT, 'src', 'progress.mjs') });
	for (const [file, body] of data) {
		entries.push({ path: file, data: Buffer.from(JSON.stringify(body)) });
	}
	entries.push(...images);
	const name = first?.name ?? defaultName('export-');
	return { name, entries };
};

const WEBP_MAX = 16383;

/** An entry's bytes: its data, the file, or the file encoded as lossless WebP. */
const bytesOf = (entry) =>
	entry.data ??
	(entry.webp
		? magickAsync([
				entry.file,
				'-define',
				'webp:lossless=true',
				'-define',
				'webp:method=4',
				'webp:-',
			])
		: readFile(entry.file));

/**
 * The entries with their bytes, in order, with up to `width` read or
 * encoded ahead: WebP encoding is the slow part and each is its own process.
 */
async function* loaded(entries, width = os.availableParallelism()) {
	const pending = [];
	let next = 0;
	const fill = () => {
		while (next < entries.length && pending.length < width) {
			const entry = entries[next++];
			const item = Promise.resolve(bytesOf(entry)).then((data) => ({ entry, data }));
			item.catch(() => {}); // awaited in turn below, never unhandled meanwhile
			pending.push(item);
		}
	};
	fill();
	while (pending.length) {
		const item = await pending.shift();
		fill();
		yield item;
	}
}

/** Refuses a plan with an entry that would land outside the site. */
const checkEntries = (plan, root) => {
	const paths = plan.entries.map((entry) => entry.path);
	const bad = [...(root === undefined ? [] : [root]), ...paths].find((rel) => !contained(rel));
	if (bad !== undefined) {
		throw new Error(`the export would write outside itself: ${JSON.stringify(bad)}`);
	}
};

/**
 * Writes the site to `out`. A directory that is not empty is only replaced
 * when it holds an earlier export, so a typo in `--out` cannot wipe a folder.
 */
export const writeExport = async (plan, out) => {
	checkEntries(plan);
	if (existsSync(out) && (await readdir(out)).length) {
		if (!existsSync(path.join(out, 'api', 'jobs.json'))) {
			throw new Error(`${out} is not empty and is not an earlier export`);
		}
		await rm(out, { recursive: true });
	}
	for await (const { entry, data } of loaded(plan.entries)) {
		const target = path.join(out, entry.path);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, data);
	}
};

/**
 * Whether `file` is a zip `writeZip` wrote, which opens with the site's page:
 * the only kind of file `export --zip` replaces.
 */
export const isExportZip = (file) => {
	const head = Buffer.alloc(512);
	let fd;
	try {
		fd = openSync(file, 'r');
		const read = readSync(fd, head, 0, head.length, 0);
		if (read < 30 || head.readUInt32LE(0) !== 0x04034b50) {
			return false;
		}
		const name = head.toString('utf8', 30, Math.min(30 + head.readUInt16LE(26), read));
		return /^[^/]+\/index\.html$/.test(name);
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
};

const u16 = (value) => {
	const buffer = Buffer.alloc(2);
	buffer.writeUInt16LE(value);
	return buffer;
};
const u32 = (value) => {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32LE(value >>> 0);
	return buffer;
};

/**
 * Streams the site as a zip under a `root/` folder. Entries are stored, not
 * deflated: nearly every byte is PNG, which is compressed already. No zip64,
 * so the export must stay under 4 GB and 65535 files, which is checked first.
 */
export const writeZip = async (plan, stream, root = plan.name) => {
	checkEntries(plan, root);
	const size = plan.entries.reduce(
		(sum, entry) => sum + (entry.file ? statSync(entry.file).size : entry.data.length) + 200,
		0,
	);
	if (size > 0xffffffff || plan.entries.length > 0xffff) {
		throw new Error('the export is too big for a zip: use sbshot export --out');
	}
	const closed = once(stream, 'close');
	const put = async (chunk) => {
		if (!stream.write(chunk)) {
			await Promise.race([once(stream, 'drain'), closed]);
		}
		if (stream.destroyed) {
			throw new Error('the download was cancelled');
		}
	};
	const now = new Date();
	const time = u16((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1));
	const date = u16(((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate());
	const central = [];
	let offset = 0;
	for await (const { entry, data } of loaded(plan.entries)) {
		const name = Buffer.from(`${root}/${entry.path}`);
		// version 2.0, UTF-8 names, stored
		const fields = [
			u16(20),
			u16(0x0800),
			u16(0),
			time,
			date,
			u32(crc32(data)),
			u32(data.length),
			u32(data.length),
			u16(name.length),
			u16(0),
		];
		const local = Buffer.concat([u32(0x04034b50), ...fields, name]);
		central.push(
			Buffer.concat([
				u32(0x02014b50),
				u16(20),
				...fields,
				u16(0),
				u16(0),
				u16(0),
				u32(0),
				u32(offset),
				name,
			]),
		);
		await put(local);
		await put(data);
		offset += local.length + data.length;
	}
	const directory = Buffer.concat(central);
	await put(directory);
	await put(
		Buffer.concat([
			u32(0x06054b50),
			u16(0),
			u16(0),
			u16(central.length),
			u16(central.length),
			u32(directory.length),
			u32(offset),
			u16(0),
		]),
	);
	stream.end();
	await Promise.race([once(stream, 'finish'), closed]);
};
