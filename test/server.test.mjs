import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

import { serve } from '../src/server.mjs';
import { serveStatic } from '../src/storybook.mjs';

const put = (file, content = '') => {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
};

/** A raw request, so neither the path nor the headers are normalised on the way. */
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

test('the viewer refuses foreign hosts, non-JSON posts and flags as run names', async () => {
	const workspace = mkdtempSync(path.join(import.meta.dirname, '.tmp-'));
	put(path.join(workspace, 'runs/a/shots.json'), '{"shots":[]}');
	const server = await serve({ workspace });
	try {
		const { port } = new URL(server.url);
		assert.equal((await send(server.url, { path: '/api/jobs' })).status, 200);
		assert.equal(
			(await send(server.url, { path: '/api/jobs', headers: { host: `evil.test:${port}` } }))
				.status,
			403,
		);

		const body = JSON.stringify({ base: 'a', after: 'a' });
		const post = (headers, payload = body) =>
			send(server.url, { method: 'POST', path: '/api/diffs', headers, body: payload });
		assert.equal((await post({ 'content-type': 'text/plain' })).status, 403);
		assert.equal(
			(await post({ 'content-type': 'application/json', origin: 'http://evil.test' })).status,
			403,
		);
		const flag = JSON.stringify({ base: '--out=/tmp/x', after: 'a' });
		assert.equal((await post({ 'content-type': 'application/json' }, flag)).status, 400);
		const outside = JSON.stringify({ base: '..', after: 'a' });
		assert.equal((await post({ 'content-type': 'application/json' }, outside)).status, 400);
	} finally {
		await server.close();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test('the build server does not serve a sibling that shares its prefix', async () => {
	const dir = mkdtempSync(path.join(import.meta.dirname, '.tmp-'));
	put(path.join(dir, 'build/index.json'), '{}');
	put(path.join(dir, 'build-secret/key.txt'), 'secret');
	const server = await serveStatic(path.join(dir, 'build'));
	try {
		assert.equal((await send(server.url, { path: '/index.json' })).status, 200);
		const escaped = await send(server.url, { path: '/..%2fbuild-secret%2fkey.txt' });
		assert.equal(escaped.status, 403);
	} finally {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the viewer names jobs of its own workspace only, and writes verdicts on real pairs', async () => {
	const workspace = mkdtempSync(path.join(import.meta.dirname, '.tmp-'));
	const outside = mkdtempSync(path.join(import.meta.dirname, '.tmp-'));
	put(path.join(outside, 'diff.json'), '{"results":[{"file":"x.png"}]}');
	put(path.join(workspace, 'runs/a/shots.json'), '{"shots":[]}');
	const diff = path.join(workspace, 'diffs/d');
	put(path.join(diff, 'diff.json'), '{"results":[{"file":"dark/x.png","changed":1}]}');
	// A diff whose record claims the whole disk as its baseline.
	put(path.join(diff, 'sbshot.json'), JSON.stringify({ kind: 'diff', name: 'd', base: '/' }));
	put(path.join(workspace, 'runs/a/page.html'), '<script>alert(1)</script>');
	const server = await serve({ workspace });
	const json = { 'content-type': 'application/json' };
	try {
		for (const ref of [encodeURIComponent(outside), '%2E%2E', '..']) {
			assert.equal((await send(server.url, { path: `/api/jobs/diff/${ref}` })).status, 404, ref);
			const review = await send(server.url, {
				method: 'POST',
				path: `/api/jobs/diff/${ref}/review`,
				headers: json,
				body: JSON.stringify({ file: 'x.png', verdict: 'expected' }),
			});
			assert.equal(review.status, 404, ref);
		}
		assert.throws(() => readFileSync(path.join(outside, 'review.json')));

		const verdict = (file) =>
			send(server.url, {
				method: 'POST',
				path: '/api/jobs/diff/d/review',
				headers: json,
				body: JSON.stringify({ file, verdict: 'regression' }),
			});
		assert.equal((await verdict('dark/typo.png')).status, 400);
		assert.equal((await verdict('dark/x.png')).status, 200);

		for (const name of ['.', '..', 'latest', 'a/b']) {
			const started = await send(server.url, {
				method: 'POST',
				path: '/api/diffs',
				headers: json,
				body: JSON.stringify({ base: 'a', after: 'a', name }),
			});
			assert.equal(started.status, 400, name);
		}

		const file = (p) => send(server.url, { path: `/file?p=${encodeURIComponent(p)}` });
		assert.equal((await file('/etc/hostname')).status, 403);
		const page = await new Promise((resolve, reject) =>
			request(
				`${server.url}/file?p=${encodeURIComponent(path.join(workspace, 'runs/a/page.html'))}`,
				(response) => {
					response.resume();
					resolve(response.headers);
				},
			)
				.on('error', reject)
				.end(),
		);
		assert.equal(page['content-disposition'], 'attachment');
		assert.equal(page['x-content-type-options'], 'nosniff');
	} finally {
		await server.close();
		rmSync(workspace, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test('a viewer on a network address still refuses a rebound Host', async () => {
	const workspace = mkdtempSync(path.join(import.meta.dirname, '.tmp-'));
	const server = await serve({ workspace, host: '0.0.0.0' });
	try {
		const { port } = new URL(server.url);
		const at = (host) => send(server.url, { path: '/api/jobs', headers: { host } });
		assert.equal((await at(`evil.test:${port}`)).status, 403);
		assert.equal((await at(`127.0.0.1:${port}`)).status, 200);
		assert.equal((await at(`192.168.1.20:${port}`)).status, 200);
	} finally {
		await server.close();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test('the build server survives a bad escape and serves no link out of the build', async () => {
	const dir = mkdtempSync(path.join(import.meta.dirname, '.tmp-'));
	put(path.join(dir, 'build/index.json'), '{}');
	put(path.join(dir, 'secret/key.txt'), 'secret');
	symlinkSync(path.join(dir, 'secret'), path.join(dir, 'build/out'));
	const server = await serveStatic(path.join(dir, 'build'));
	try {
		assert.equal((await send(server.url, { path: '/%' })).status, 400);
		assert.equal((await send(server.url, { path: '/out/key.txt' })).status, 403);
		const { port } = new URL(server.url);
		const rebound = await send(server.url, {
			path: '/index.json',
			headers: { host: `evil.test:${port}` },
		});
		assert.equal(rebound.status, 403);
		assert.equal((await send(server.url, { path: '/index.json' })).status, 200);
	} finally {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
