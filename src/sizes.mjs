import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

import { hostnameOf, LOOPBACK } from './loopback.mjs';
import { workspaceUsage } from './usage.mjs';
import { ensureViewer } from './viewer.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const UI = path.join(ROOT, 'ui');

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
};

/** Far more than the one path an open request carries. */
const BODY_LIMIT = 64 * 1024;

/** Workspaces walked at once: each walk already stats a directory's entries together. */
const WALKS = 4;

/** How many of a workspace's biggest jobs the page lists when its row opens. */
const TOP_JOBS = 5;

/**
 * The file behind a UI path, as the viewer serves it: a flat script or
 * stylesheet of `ui/`, and the one source file the page shares with the CLI.
 * The page itself is answered apart, since it carries a marker.
 */
const asset = (pathname) => {
	if (pathname === '/lib/progress.mjs') {
		return path.join(ROOT, 'src', 'progress.mjs');
	}
	return /^\/[\w-]+\.(js|css)$/.test(pathname) ? path.join(UI, pathname) : null;
};

/**
 * What the page needs of a workspace's usage: everything but the per-job and
 * per-build lists, which are the size of the workspace, plus how many there
 * are and the biggest jobs.
 */
const summarize = ({ jobs, orphanBuilds, ...usage }) => ({
	...usage,
	orphanBuildCount: orphanBuilds.length,
	jobs: jobs.length,
	topJobs: jobs
		.toSorted((a, b) => b.size - a.size)
		.slice(0, TOP_JOBS)
		.map(({ kind, name, size, imageBytes, linked }) => ({ kind, name, size, imageBytes, linked })),
});

/**
 * Serves the page behind `sbshot du --open` on the loopback interface: the
 * disk each of `workspaces` takes, and a button that opens its viewer. Only
 * the workspaces named here can be opened, never a path the page sends.
 * `viewer` is what starts or finds a workspace's viewer.
 */
export const serveSizes = async ({ workspaces, port = 0, viewer = ensureViewer }) => {
	const known = new Set(workspaces);
	const host = '127.0.0.1';

	// One usage instance per workspace, kept: each remembers what it measured.
	const measures = new Map(workspaces.map((dir) => [dir, workspaceUsage(dir)]));
	const measureOne = async (dir) => {
		try {
			return summarize(await measures.get(dir)());
		} catch (error) {
			return { workspace: dir, error: error.message };
		}
	};

	// Every page that asks while a scan is on shares it.
	let scanning = null;
	const scan = async () => {
		const results = [];
		let next = 0;
		const worker = async () => {
			while (next < workspaces.length) {
				const index = next;
				next += 1;
				results[index] = await measureOne(workspaces[index]);
			}
		};
		await Promise.all(Array.from({ length: Math.min(WALKS, workspaces.length) }, worker));
		return results;
	};
	const usages = () => {
		scanning ??= scan().finally(() => {
			scanning = null;
		});
		return scanning;
	};

	const json = (response, body, status = 200) => {
		response.writeHead(status, {
			'content-type': 'application/json',
			'cache-control': 'no-store',
		});
		response.end(JSON.stringify(body));
	};

	const sendFile = async (response, file) => {
		try {
			const { size } = await stat(file);
			response.writeHead(200, {
				'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
				'content-length': size,
				'cache-control': 'no-cache',
				'x-content-type-options': 'nosniff',
			});
			createReadStream(file).pipe(response);
		} catch {
			response.writeHead(404).end();
		}
	};

	/** The viewer's page, marked so `app.js` shows the sizes view instead of the workspace's jobs. */
	const sendPage = async (response) => {
		const html = (await readFile(path.join(UI, 'index.html'), 'utf8'))
			.replace(/<html\b/, '<html data-sizes')
			.replace('<title>sbshot</title>', '<title>sbshot disk use</title>');
		response.writeHead(200, {
			'content-type': TYPES['.html'],
			'cache-control': 'no-cache',
			'x-content-type-options': 'nosniff',
		});
		response.end(html);
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

	/**
	 * Any page open in the browser can send requests to this server. A foreign
	 * Host header is DNS rebinding, and a POST must be JSON (which a
	 * cross-origin page cannot send without a preflight this server never
	 * answers) from this page's own origin.
	 */
	const trusted = (request) => {
		if (!LOOPBACK.has(hostnameOf(request))) {
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
		const { pathname } = new URL(request.url, 'http://localhost');
		if (!trusted(request)) {
			response.writeHead(403).end();
			return;
		}
		try {
			if (pathname === '/api/workspaces/open' && request.method === 'POST') {
				let body;
				try {
					body = await readBody(request);
				} catch (error) {
					return json(response, { error: error.message }, 400);
				}
				if (typeof body?.workspace !== 'string' || !known.has(body.workspace)) {
					return json(response, { error: 'not one of the workspaces on this page' }, 400);
				}
				return json(response, { url: await viewer(body.workspace) });
			}

			if (request.method !== 'GET' && request.method !== 'HEAD') {
				response.writeHead(405).end();
				return;
			}
			if (pathname === '/') {
				return await sendPage(response);
			}
			const assetFile = asset(pathname);
			if (assetFile) {
				return await sendFile(response, assetFile);
			}
			if (pathname === '/api/workspaces') {
				return json(response, await usages());
			}
			response.writeHead(404).end();
		} catch (error) {
			if (!response.headersSent) {
				json(response, { error: error.message }, 500);
			} else {
				response.destroy();
			}
		}
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, resolve);
	});
	return {
		url: `http://${host}:${server.address().port}`,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(resolve);
			}),
	};
};
