import { spawn } from 'node:child_process';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { realpath, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { hostnameOf, LOOPBACK } from './loopback.mjs';
import { readJson } from './workspace.mjs';

const TYPES = {
	'.css': 'text/css',
	'.gif': 'image/gif',
	'.html': 'text/html',
	'.ico': 'image/x-icon',
	'.jpeg': 'image/jpeg',
	'.jpg': 'image/jpeg',
	'.js': 'text/javascript',
	'.json': 'application/json',
	'.map': 'application/json',
	'.mjs': 'text/javascript',
	'.mp4': 'video/mp4',
	'.otf': 'font/otf',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.ttf': 'font/ttf',
	'.txt': 'text/plain',
	'.wasm': 'application/wasm',
	'.webm': 'video/webm',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
};

/**
 * Serves a `storybook build` output on a free localhost port. The msw worker
 * only registers when served as JavaScript, hence the content types.
 *
 * The stories are not trusted: a file is served only when its real path,
 * links followed, is inside the build, and only to a request that names
 * localhost, so a story cannot read the machine through its own origin.
 */
export const serveStatic = async (root) => {
	const directory = realpathSync(path.resolve(root));
	await stat(path.join(directory, 'index.json'));
	const inside = (file) => file === directory || file.startsWith(`${directory}${path.sep}`);

	const handle = async (request, response) => {
		if (!LOOPBACK.has(hostnameOf(request))) {
			response.writeHead(403).end();
			return;
		}
		let file;
		try {
			const { pathname } = new URL(request.url, 'http://localhost');
			file = path.join(directory, decodeURIComponent(pathname));
		} catch {
			response.writeHead(400).end();
			return;
		}
		if (!inside(file)) {
			response.writeHead(403).end();
			return;
		}

		try {
			if ((await stat(file)).isDirectory()) {
				file = path.join(file, 'index.html');
			}
			file = await realpath(file);
			if (!inside(file)) {
				response.writeHead(403).end();
				return;
			}
			const { size } = await stat(file);
			response.writeHead(200, {
				'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
				'content-length': size,
				// A build does not change under a run, and a context kept across
				// stories only reuses the preview bundle from its cache when told so.
				'cache-control': 'max-age=31536000, immutable',
			});
			createReadStream(file).pipe(response);
		} catch {
			response.writeHead(404).end();
		}
	};

	// A request that throws must not take the capture down with it.
	const server = createServer((request, response) => {
		handle(request, response).catch(() => {
			if (!response.headersSent) response.writeHead(500);
			response.end();
		});
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		url: `http://localhost:${server.address().port}`,
		close: () =>
			new Promise((resolve) => {
				// A kept-alive socket would hold the close for its whole timeout.
				server.closeAllConnections();
				server.close(resolve);
			}),
	};
};

/** The storybook binary of a project, without a package manager shim in the way. */
const storybookBin = (project) => {
	const local = path.join(project, 'node_modules', '.bin', 'storybook');
	return existsSync(local) ? local : 'storybook';
};

export const buildStorybook = (project, outDir, log) =>
	new Promise((resolve, reject) => {
		const logFile = `${outDir}.log`;
		const child = spawn(storybookBin(project), ['build', '-o', outDir, '--stats-json', '--quiet'], {
			cwd: project,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const output = [];
		const collect = (chunk) => {
			output.push(chunk);
			// Progress bars redraw with escapes and carriage returns; the log
			// keeps the text.
			const text = stripVTControlCharacters(chunk.toString()).replace(/\r/g, '\n');
			for (const line of text.split('\n')) {
				if (line.trim()) {
					log.emit('log', { level: 'build', line: line.slice(0, 400) });
				}
			}
		};
		child.stdout.on('data', collect);
		child.stderr.on('data', collect);
		child.on('error', reject);
		child.on('close', async (status) => {
			await writeFile(logFile, Buffer.concat(output));
			if (status === 0) {
				// So a later run off this build knows which tree `--changed-since` diffs.
				await writeFile(
					path.join(outDir, BUILD_RECORD),
					`${JSON.stringify({ project, built: Date.now() })}\n`,
				);
				resolve();
			} else {
				reject(new Error(`storybook build exited ${status}, see ${logFile}`));
			}
		});
	});

const BUILD_RECORD = 'sbshot-build.json';

/** The project a build was made from, when sbshot made it. */
export const buildProject = (staticDir) =>
	readJson(path.join(staticDir, BUILD_RECORD))?.project ?? null;

/**
 * Whether a story id can be a file name. Storybook's own ids are letters,
 * digits and dashes, but the ids come from whatever serves `index.json`, and
 * each one becomes `<run>/<theme>/<id>.png`: no separator, no leading dot.
 */
export const fileSafeId = (id) =>
	typeof id === 'string' && /^[\p{L}\p{N}_][\p{L}\p{M}\p{N}_.-]*$/u.test(id);

/**
 * The stories of an `index.json` a capture shoots, sorted by id. `stories`
 * are id or `Title/Name` substrings (any may match), `title` a title prefix,
 * `name` a story name substring. A story whose id is not `fileSafeId` is left
 * out.
 */
export const selectStories = (index, { stories = [], title = '', name = '' }) =>
	Object.values(index.entries)
		.filter((entry) => {
			if (entry.type !== 'story' || !fileSafeId(entry.id)) {
				return false;
			}
			if (title && !entry.title.startsWith(title)) {
				return false;
			}
			if (name && !entry.name.toLowerCase().includes(name.toLowerCase())) {
				return false;
			}
			if (!stories.length) {
				return true;
			}
			const haystack = `${entry.id} ${entry.title}/${entry.name}`.toLowerCase();
			return stories.some((match) => haystack.includes(match.toLowerCase()));
		})
		.map(({ id, title, name, importPath }) => ({ id, title, name, importPath }))
		.sort((a, b) => a.id.localeCompare(b.id));
