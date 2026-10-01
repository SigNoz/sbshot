import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { hasMagick, magickAsync } from './caption.mjs';
import { readEvents } from './events.mjs';
import { exportPlan, writeZip } from './export.mjs';
import { jobDetail, jobSummary } from './jobs.mjs';
import { hostnameOf, LOOPBACK } from './loopback.mjs';
import { fold } from './progress.mjs';
import { setVerdict, VERDICTS } from './review.mjs';
import { eventsFile, KINDS, listJobs, readMeta, resolveJob, validName } from './workspace.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const UI = path.join(ROOT, 'ui');
const BIN = path.join(ROOT, 'bin', 'sbshot.mjs');

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.svg': 'image/svg+xml',
};

/**
 * What `/file` and `/thumb` answer inline: images, which cannot run script
 * on the viewer's origin. Anything else under a root is a download.
 */
const IMAGES = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
};

/** Far more than a verdict or a diff request ever needs. */
const BODY_LIMIT = 64 * 1024;

/**
 * The file behind a UI path: the page, a flat script or stylesheet of `ui/`,
 * or the one source file the page shares with the CLI.
 */
const asset = (pathname) => {
	if (pathname === '/') {
		return path.join(UI, 'index.html');
	}
	if (pathname === '/lib/progress.mjs') {
		return path.join(ROOT, 'src', 'progress.mjs');
	}
	return /^\/[\w-]+\.(js|css)$/.test(pathname) ? path.join(UI, pathname) : null;
};

/** A bounded pool, so a page of thumbnails does not start a hundred ImageMagicks. */
const pool = (size) => {
	let running = 0;
	const waiting = [];
	return async (task) => {
		if (running >= size) {
			await new Promise((resolve) => waiting.push(resolve));
		}
		running += 1;
		try {
			return await task();
		} finally {
			running -= 1;
			waiting.shift()?.();
		}
	};
};

/**
 * Serves the UI for one workspace on localhost. The page reads every job's
 * `events.ndjson` over server-sent events and folds it itself, with the same
 * code the CLI uses, so the server stays a file server with a few verbs.
 */
export const serve = async ({ workspace, port = 0, host = '127.0.0.1' }) => {
	const thumbs = path.join(workspace, '.cache', 'thumbs');
	const thumbPool = pool(4);
	const magick = hasMagick();

	// Folded states, advanced from the last offset on each request.
	const states = new Map();
	const stateOf = (dir) => {
		const cached = states.get(dir) ?? { offset: 0, state: fold([]) };
		const { events, offset } = readEvents(eventsFile(dir), cached.offset);
		if (offset < cached.offset) {
			// The file was replaced (a --force rerun): start over.
			states.delete(dir);
			return stateOf(dir);
		}
		fold(events, cached.state);
		cached.offset = offset;
		states.set(dir, cached);
		return cached.state;
	};

	/**
	 * Directories a file may be served from: the workspace, every job's real
	 * directory, and the runs a diff compared. A diff's `base` and `after` are
	 * only what its `sbshot.json` says, so each counts only when it is a run.
	 */
	let rootsCache = { at: 0, roots: [] };
	const roots = () => {
		if (Date.now() - rootsCache.at < 5000) {
			return rootsCache.roots;
		}
		const found = new Set([realpathSync(workspace)]);
		for (const job of listJobs(workspace)) {
			const runs = [job.base, job.after].filter(
				(dir) => typeof dir === 'string' && readMeta(dir)?.kind === 'capture',
			);
			for (const dir of [job.dir, ...runs]) {
				try {
					found.add(realpathSync(dir));
				} catch {
					/* gone */
				}
			}
		}
		rootsCache = { at: Date.now(), roots: [...found] };
		return rootsCache.roots;
	};
	const allowed = (file) => {
		try {
			const real = realpathSync(file);
			return roots().some((root) => real === root || real.startsWith(`${root}${path.sep}`))
				? real
				: null;
		} catch {
			return null;
		}
	};

	const json = (response, body, status = 200) => {
		response.writeHead(status, {
			'content-type': 'application/json',
			'cache-control': 'no-store',
		});
		response.end(JSON.stringify(body));
	};

	const sendFile = async (response, file, { cache = 'no-cache', types = TYPES } = {}) => {
		try {
			const { size } = await stat(file);
			const type = types[path.extname(file).toLowerCase()];
			response.writeHead(200, {
				'content-type': type ?? 'application/octet-stream',
				'content-length': size,
				'cache-control': cache,
				'x-content-type-options': 'nosniff',
				...(!type && { 'content-disposition': 'attachment' }),
			});
			createReadStream(file).pipe(response);
		} catch {
			response.writeHead(404).end();
		}
	};

	const readBody = (request) =>
		new Promise((resolve, reject) => {
			const chunks = [];
			let size = 0;
			request.on('data', (chunk) => {
				size += chunk.length;
				if (size > BODY_LIMIT) {
					request.destroy();
					reject(new Error('request body too large'));
					return;
				}
				chunks.push(chunk);
			});
			request.on('end', () => {
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
				} catch (error) {
					reject(error);
				}
			});
			request.on('error', reject);
		});

	const summary = (job) => jobSummary(job, stateOf(job.dir));

	/** SSE of a job's events from `from` on, polled: fs.watch misses writes on synced folders. */
	const streamEvents = (request, response, dir, from) => {
		response.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-store',
			connection: 'keep-alive',
		});
		let offset = from;
		let closed = false;
		const push = () => {
			if (closed) {
				return;
			}
			const read = readEvents(eventsFile(dir), offset);
			if (read.offset < offset) {
				response.write('event: reset\ndata: {}\n\n');
			}
			offset = read.offset;
			if (read.events.length) {
				response.write(`id: ${offset}\ndata: ${JSON.stringify(read.events)}\n\n`);
			}
			if (read.events.some((event) => event.type === 'end')) {
				response.write('event: done\ndata: {}\n\n');
			}
		};
		push();
		const timer = setInterval(push, 500);
		const keepAlive = setInterval(() => response.write(': ping\n\n'), 15_000);
		request.on('close', () => {
			closed = true;
			clearInterval(timer);
			clearInterval(keepAlive);
		});
	};

	/** A JPEG thumbnail of a shot, its caption cropped off, cached by path, mtime and size. */
	const thumbnail = async (response, file, top, width) => {
		const { mtimeMs } = await stat(file);
		const key = createHash('sha1')
			.update(`v3\0${file}\0${mtimeMs}\0${top}\0${width}`)
			.digest('hex');
		const target = path.join(thumbs, `${key}.jpg`);
		if (!existsSync(target)) {
			if (!magick) {
				return sendFile(response, file, { types: IMAGES });
			}
			await mkdir(thumbs, { recursive: true });
			await thumbPool(() =>
				magickAsync([
					file,
					...(top > 0 ? ['-chop', `0x${top}`] : []),
					'+repage',
					'-thumbnail',
					`${width}x${width * 3}>`,
					'-strip',
					'-quality',
					'72',
					target,
				]),
			);
		}
		return sendFile(response, target, { cache: 'max-age=31536000, immutable' });
	};

	/** A job the page names: only one of this workspace, by name, never a path. */
	const job = (ref, kind) => {
		if (typeof ref !== 'string' || ref !== path.basename(ref) || ref === '.' || ref === '..') {
			return null;
		}
		const dir = resolveJob(workspace, ref, kind);
		return dir && path.dirname(dir) === path.join(workspace, KINDS[kind]) ? dir : null;
	};

	// The names a request may carry in its Host: the loopback ones, and on a
	// network bind the bind address, this machine's name and any IP literal.
	// A DNS-rebinding page carries a name of its own, never one of these.
	const machine = os.hostname().toLowerCase();
	const names = LOOPBACK.has(host)
		? LOOPBACK
		: new Set([...LOOPBACK, host.toLowerCase(), machine, `${machine}.local`]);
	const localName = (hostname) =>
		names.has(hostname) || (!LOOPBACK.has(host) && isIP(hostname.replace(/^\[(.*)\]$/, '$1')) > 0);

	/**
	 * Any page open in the browser can send requests to this server. A foreign
	 * Host header is DNS rebinding, and a POST must be JSON (which a
	 * cross-origin page cannot send without a preflight this server never
	 * answers) from the viewer's own origin.
	 */
	const trusted = (request) => {
		if (!localName(hostnameOf(request))) {
			return false;
		}
		if (request.method === 'GET' || request.method === 'HEAD') {
			return true;
		}
		const { origin } = request.headers;
		return (
			(request.headers['content-type'] ?? '').startsWith('application/json') &&
			(!origin || origin === `http://${request.headers.host}`)
		);
	};

	const server = createServer(async (request, response) => {
		const url = new URL(request.url, 'http://localhost');
		const { pathname } = url;
		if (!trusted(request)) {
			response.writeHead(403).end();
			return;
		}
		try {
			const assetFile = asset(pathname);
			if (assetFile) {
				return sendFile(response, assetFile);
			}

			if (pathname === '/api/jobs') {
				return json(response, {
					workspace,
					jobs: listJobs(workspace).map(summary),
				});
			}

			const jobMatch = /^\/api\/jobs\/(capture|diff)\/([^/]+)(\/[a-z]+)?$/.exec(pathname);
			if (jobMatch) {
				const [, kind, rawName, verb] = jobMatch;
				const dir = job(decodeURIComponent(rawName), kind);
				if (!dir) {
					return json(response, { error: 'no such job' }, 404);
				}
				if (verb === '/events') {
					return streamEvents(request, response, dir, Number(url.searchParams.get('from') ?? 0));
				}
				if (verb === '/review' && request.method === 'POST' && kind === 'diff') {
					const { file, verdict, note } = await readBody(request);
					if (!VERDICTS.includes(verdict)) {
						return json(response, { error: 'bad verdict' }, 400);
					}
					try {
						return json(response, setVerdict(dir, file, verdict, note));
					} catch (error) {
						return json(response, { error: error.message }, 400);
					}
				}
				const listed = listJobs(workspace).find((candidate) => candidate.dir === dir);
				return json(response, jobDetail(kind, dir, listed ? summary(listed) : null));
			}

			// Start a diff between two runs from the page. It runs as its own
			// process, like one started from a terminal, and shows up in the list.
			if (pathname === '/api/diffs' && request.method === 'POST') {
				const { base, after, mode, threshold, noise, name } = await readBody(request);
				// Every value goes after an `=`: nothing from the page can reach
				// the diff as a flag of its own.
				const baseDir = job(base, 'capture');
				const afterDir = job(after, 'capture');
				const noiseDir = noise ? job(noise, 'diff') : null;
				if (!baseDir || !afterDir || (noise && !noiseDir)) {
					return json(response, { error: 'base and after must be runs of this workspace' }, 400);
				}
				if (name !== undefined && !validName(name)) {
					return json(response, { error: 'bad diff name' }, 400);
				}
				const args = [BIN, 'diff', `--workspace=${workspace}`, '--force'];
				if (mode) args.push(`--mode=${mode}`);
				if (threshold) args.push(`--threshold=${threshold}`);
				if (noiseDir) args.push(`--noise=${noiseDir}`);
				if (name) args.push(`--name-diff=${name}`);
				args.push('--', baseDir, afterDir);
				const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
				child.unref();
				return json(response, {
					name: name ?? `${path.basename(baseDir)}--${path.basename(afterDir)}`,
				});
			}

			// A static copy of some jobs, as a zip the browser downloads.
			if (pathname === '/api/export.zip') {
				const refs = [
					...url.searchParams.getAll('diff').map((ref) => job(ref, 'diff')),
					...url.searchParams.getAll('run').map((ref) => job(ref, 'capture')),
				];
				if (!refs.length || refs.some((dir) => !dir)) {
					return json(response, { error: 'export takes runs and diffs of this workspace' }, 400);
				}
				const plan = exportPlan(workspace, refs, {
					all: url.searchParams.has('all'),
					runs: url.searchParams.has('runs'),
					png: url.searchParams.has('png'),
				});
				response.writeHead(200, {
					'content-type': 'application/zip',
					'content-disposition': `attachment; filename="${plan.name}.zip"`,
					'cache-control': 'no-store',
				});
				return writeZip(plan, response, plan.name);
			}

			if (pathname === '/file' || pathname === '/thumb') {
				const file = allowed(url.searchParams.get('p') ?? '');
				if (!file) {
					response.writeHead(403).end();
					return;
				}
				if (pathname === '/file') {
					return sendFile(response, file, { types: IMAGES });
				}
				return thumbnail(
					response,
					file,
					Number(url.searchParams.get('top') ?? 0),
					Math.min(Math.max(Number(url.searchParams.get('w') ?? 360), 64), 1200),
				);
			}

			response.writeHead(404).end();
		} catch (error) {
			if (!response.headersSent) {
				json(response, { error: error.message }, 500);
			} else {
				// A zip or a stream cut short: a reset tells the client, where an
				// end would read as complete.
				response.destroy();
			}
		}
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, resolve);
	});
	return {
		url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}`,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(resolve);
			}),
	};
};
