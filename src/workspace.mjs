import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * A workspace is one directory holding every run, diff and build:
 *
 *   <workspace>/runs/<name>/     a capture: <theme>/<id>.png, shots.json
 *   <workspace>/diffs/<name>/    a diff: <theme>/<id>.png, diff.json
 *   <workspace>/builds/<name>/   a storybook build made by `capture <project>`
 *
 * Every run and diff also holds `sbshot.json` (what it is, who runs it, how it
 * ended) and `events.ndjson` (everything that happened, in order). A directory
 * with only a `shots.json`, from the older story-shots scripts, reads as a
 * finished capture.
 */
export const workspaceDir = (flag) =>
	path.resolve(flag ?? process.env.SBSHOT_WORKSPACE ?? '.sbshot');

export const KINDS = { capture: 'runs', diff: 'diffs' };

export const metaFile = (dir) => path.join(dir, 'sbshot.json');
export const eventsFile = (dir) => path.join(dir, 'events.ndjson');

/** A JSON file's contents, or `null` when it is missing or not JSON. */
export const readJson = (file) => {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
};

export const writeMeta = (dir, meta) =>
	writeFile(metaFile(dir), `${JSON.stringify(meta, null, '\t')}\n`);

/** When the process with this pid started, in epoch ms, where the system says (Linux). */
const startTime = (pid) => {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		// Field 22 is the start in clock ticks (100 a second) since boot, counted
		// past the command name, which may hold spaces.
		const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
		const boot = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))[1]);
		return boot * 1000 + ticks * 10;
	} catch {
		return null;
	}
};

/**
 * Whether the process with this pid, which wrote a record at `since`, is
 * still there. A pid is handed out again after a crash or a reboot, so a
 * process that started well after the record is another one.
 */
export const alive = (pid, since) => {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (error.code !== 'EPERM') {
			return false;
		}
	}
	return !(since && startTime(pid) > since + 60_000);
};

/** The job's meta, with a run whose process is gone marked as interrupted. */
export const readMeta = (dir) => {
	const meta = readJson(metaFile(dir));
	if (meta) {
		if (
			['running', 'building'].includes(meta.status) &&
			meta.host === os.hostname() &&
			!alive(meta.pid, meta.started)
		) {
			meta.status = 'interrupted';
		}
		return { ...meta, dir };
	}
	if (existsSync(path.join(dir, 'shots.json'))) {
		const { mtimeMs } = statSync(path.join(dir, 'shots.json'));
		return {
			kind: 'capture',
			name: path.basename(dir),
			status: 'done',
			legacy: true,
			started: mtimeMs,
			ended: mtimeMs,
			dir,
		};
	}
	if (existsSync(path.join(dir, 'diff.json'))) {
		const { mtimeMs } = statSync(path.join(dir, 'diff.json'));
		return {
			kind: 'diff',
			name: path.basename(dir),
			status: 'done',
			started: mtimeMs,
			ended: mtimeMs,
			dir,
		};
	}
	return null;
};

/** Every run and diff of the workspace, newest first. */
export const listJobs = (workspace) =>
	Object.values(KINDS)
		.flatMap((sub) => {
			const root = path.join(workspace, sub);
			if (!existsSync(root)) {
				return [];
			}
			return readdirSync(root, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
				.map((entry) => readMeta(path.join(root, entry.name)))
				.filter(Boolean);
		})
		.sort((a, b) => (b.started ?? 0) - (a.started ?? 0));

/**
 * A run or diff by name in the workspace, `latest` (optionally
 * `latest:capture` / `latest:diff`), or by path. A name is looked up first,
 * so a directory of the same name where the command runs does not stand in
 * for the job.
 */
export const resolveJob = (workspace, ref, kind) => {
	if (!ref || ref === 'latest' || ref.startsWith('latest:')) {
		const wanted = ref?.split(':')[1] ?? kind;
		const job = listJobs(workspace).find((candidate) => !wanted || candidate.kind === wanted);
		return job?.dir ?? null;
	}
	if (ref === path.basename(ref) && ref !== '.' && ref !== '..') {
		const kinds = kind ? [KINDS[kind]] : Object.values(KINDS);
		for (const sub of kinds) {
			const dir = path.join(workspace, sub, ref);
			if (existsSync(dir)) {
				return dir;
			}
		}
	}
	if (existsSync(ref) && statSync(ref).isDirectory()) {
		return path.resolve(ref);
	}
	return null;
};

/**
 * A name a new run or diff may take: one path segment that is not `.`, `..`
 * or `latest`, so it can only ever name a directory of `runs/` or `diffs/`.
 */
export const validName = (name) =>
	typeof name === 'string' && /^\w[\w.-]*$/.test(name) && name !== 'latest';

/**
 * Where a run keeps its shots: `<out>/<theme>/<id>.png`, or `<out>/<id>.png`
 * when flat. `dirOf` is the directory on disk, `shotFile` the path relative to
 * the run, which is the key a shot has in `shots.json` and in a diff.
 */
export const shotPaths = (outDir, flat) => ({
	dirOf: (theme) => (flat ? outDir : path.join(outDir, theme ?? 'default')),
	shotFile: (theme, relative) => path.posix.join(flat ? '' : (theme ?? 'default'), relative),
});

/** A name for a new job: the time it started, sortable and unique enough. */
export const defaultName = (prefix = '') => {
	const now = new Date();
	const pad = (value) => String(value).padStart(2, '0');
	return `${prefix}${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};

const SKIP_DIRS = new Set([...Object.values(KINDS), 'builds', 'node_modules', '.git']);

/**
 * Walks `root` for results written outside a workspace (the story-shots
 * scripts left them at any depth): a directory holding `shots.json` is a run,
 * one holding `diff.json` is a diff. A directory with PNGs and neither file,
 * such as a story-shots-diff.mjs output, cannot be read back and is only
 * reported. The walk stops at every find, since results do not nest.
 */
export const findResults = (root) => {
	const found = { runs: [], diffs: [], unreadable: [] };
	const walk = (dir, depth) => {
		const entries = readdirSync(dir, { withFileTypes: true });
		const names = new Set(entries.map((entry) => entry.name));
		if (names.has('shots.json')) {
			found.runs.push(dir);
			return;
		}
		if (names.has('diff.json')) {
			found.diffs.push(dir);
			return;
		}
		if (names.has('iframe.html')) {
			return; // a storybook build
		}
		const subdirs = entries.filter(
			(entry) => entry.isDirectory() && !(depth === 0 && SKIP_DIRS.has(entry.name)),
		);
		const hasPngs = subdirs.some((entry) =>
			readdirSync(path.join(dir, entry.name)).some((name) => name.endsWith('.png')),
		);
		if (hasPngs) {
			found.unreadable.push(dir);
			return;
		}
		for (const entry of subdirs) {
			if (!entry.name.startsWith('.')) {
				walk(path.join(dir, entry.name), depth + 1);
			}
		}
	};
	walk(root, 0);
	return found;
};

/**
 * Links the results already in `source` into `workspace` (by default the same
 * directory, which makes it a workspace in place): each run and diff gets a
 * relative link in runs/ or diffs/, named after its path under `source`
 * (`tokens-before/s00` becomes `tokens-before-s00`). Running it again links
 * only what is new.
 */
export const adoptResults = async (source, workspace = source) => {
	const found = findResults(source);
	const linked = [];
	const known = [];
	const already = new Set(listJobs(workspace).map((job) => realpathSync(job.dir)));
	for (const [sub, dirs] of [
		[KINDS.capture, found.runs],
		[KINDS.diff, found.diffs],
	]) {
		for (const target of dirs) {
			if (already.has(realpathSync(target))) {
				known.push(target);
				continue;
			}
			const base = path.relative(source, target).split(path.sep).join('-') || path.basename(target);
			let name = base;
			for (let n = 2; existsSync(path.join(workspace, sub, name)); n += 1) {
				name = `${base}-${n}`;
			}
			const link = path.join(workspace, sub, name);
			mkdirSync(path.dirname(link), { recursive: true });
			await symlink(path.relative(path.dirname(link), target), link);
			linked.push({ link, target });
		}
	}
	return { linked, known, unreadable: found.unreadable };
};
