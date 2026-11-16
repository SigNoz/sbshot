import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

import { serveSizes } from '../src/sizes.mjs';
import { diskUsage } from '../src/usage.mjs';

const put = (file, size) => {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, Buffer.alloc(size, 1));
};

/** A raw request, so the Host header is the one given. */
const send = (url, { method = 'GET', path: rawPath = '/', headers = {}, body } = {}) =>
	new Promise((resolve, reject) => {
		const { hostname, port } = new URL(url);
		const req = request({ hostname, port, method, path: rawPath, headers }, (response) => {
			const chunks = [];
			response.on('data', (chunk) => chunks.push(chunk));
			response.on('end', () =>
				resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }),
			);
		});
		req.on('error', reject);
		req.end(body);
	});

const JSON_HEADERS = { 'content-type': 'application/json' };

test('the sizes page lists each workspace with its total and biggest jobs, and opens only those it lists', async () => {
	const root = mkdtempSync(path.join(import.meta.dirname, '.tmp-'));
	const workspace = path.join(root, 'ws');
	const empty = path.join(root, 'empty');
	for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
		put(path.join(workspace, `runs/${name}/dark/x.png`), 10_000 * (name.charCodeAt(0) - 96));
		writeFileSync(
			path.join(workspace, `runs/${name}/sbshot.json`),
			JSON.stringify({ kind: 'capture', name, status: 'done', started: 2 }),
		);
	}
	put(path.join(workspace, '.cache/thumbs/t.jpg'), 5_000);
	mkdirSync(path.join(empty, 'runs'), { recursive: true });
	const opened = [];
	const server = await serveSizes({
		workspaces: [workspace, empty],
		viewer: async (dir) => {
			opened.push(dir);
			return 'http://127.0.0.1:9';
		},
	});
	try {
		const { hostname, port } = new URL(server.url);
		assert.equal(hostname, '127.0.0.1');

		const listed = await send(server.url, { path: '/api/workspaces' });
		assert.equal(listed.status, 200);
		const [first, second] = JSON.parse(listed.body);
		assert.equal(first.workspace, workspace);
		assert.equal(first.total, await diskUsage(workspace));
		assert.equal(first.total, first.runs + first.diffs + first.builds + first.cache + first.other);
		assert.equal(first.jobs, 6);
		assert.equal(first.images, 6);
		assert.deepEqual(
			first.topJobs.map((job) => job.name),
			['f', 'e', 'd', 'c', 'b'],
		);
		assert.equal(Object.keys(first.topJobs[0]).sort().join(), 'imageBytes,kind,linked,name,size');
		assert.ok(first.topJobs[0].size >= first.topJobs[0].imageBytes);
		assert.equal(second.workspace, empty);
		assert.equal(second.jobs, 0);
		assert.deepEqual(second.topJobs, []);

		// The page is the viewer's, marked for the sizes view, and its scripts are served.
		const page = await send(server.url);
		assert.equal(page.status, 200);
		assert.match(page.body, /<html data-sizes /);
		for (const file of ['/app.js', '/sizes.js', '/sizes.css', '/shared.js', '/lib/progress.mjs']) {
			assert.equal((await send(server.url, { path: file })).status, 200, file);
		}
		assert.equal((await send(server.url, { path: '/..%2fpackage.json' })).status, 404);

		// A path the page was not given is never opened, whatever it is.
		const open = (workspaceRef, headers = JSON_HEADERS) =>
			send(server.url, {
				method: 'POST',
				path: '/api/workspaces/open',
				headers,
				body: JSON.stringify({ workspace: workspaceRef }),
			});
		for (const refused of [root, `${workspace}/../ws`, `${workspace}/`, '', 7, null]) {
			assert.equal((await open(refused)).status, 400, String(refused));
		}
		assert.deepEqual(opened, []);

		// A listed one is, by its exact path.
		const accepted = await open(empty);
		assert.equal(accepted.status, 200);
		assert.deepEqual(JSON.parse(accepted.body), { url: 'http://127.0.0.1:9' });
		assert.deepEqual(opened, [empty]);

		// A foreign Host is DNS rebinding, and a post must be JSON from this origin.
		const foreign = { host: `evil.test:${port}` };
		assert.equal(
			(await send(server.url, { path: '/api/workspaces', headers: foreign })).status,
			403,
		);
		assert.equal((await send(server.url, { headers: foreign })).status, 403);
		assert.equal((await open(empty, { ...JSON_HEADERS, ...foreign })).status, 403);
		assert.equal((await open(empty, { 'content-type': 'text/plain' })).status, 403);
		assert.equal((await open(empty, { ...JSON_HEADERS, origin: 'http://evil.test' })).status, 403);
		assert.deepEqual(opened, [empty]);
	} finally {
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
});
