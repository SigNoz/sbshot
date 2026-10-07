import { spawn } from 'node:child_process';
import { closeSync, openSync, realpathSync, statSync } from 'node:fs';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { LOOPBACK } from './loopback.mjs';
import { alive, readJson } from './workspace.mjs';

/**
 * One viewer per workspace, outliving the command that started it. `sbshot ui`
 * records itself in `<workspace>/ui.json`; `--ui` on a capture or a diff reuses
 * that one when it still answers, and starts a detached one if not.
 */
const recordFile = (workspace) => path.join(workspace, 'ui.json');
const lockFile = (workspace) => path.join(workspace, 'ui.lock');

const real = (dir) => {
	try {
		return realpathSync(dir);
	} catch {
		return null;
	}
};

/**
 * The viewer recorded for this workspace, when it answers as one. The record
 * is a file in the workspace, which may have come with the project and may
 * outlive its process, so only a loopback http address is asked, and only an
 * answer that names this workspace counts.
 */
export const runningViewer = async (workspace) => {
	const record = readJson(recordFile(workspace));
	let url;
	try {
		url = new URL(record.url);
	} catch {
		return null;
	}
	if (
		url.protocol !== 'http:' ||
		!LOOPBACK.has(url.hostname) ||
		url.origin !== record.url ||
		!alive(record.pid, record.started)
	) {
		return null;
	}
	try {
		const response = await fetch(`${url.origin}/api/jobs`, { signal: AbortSignal.timeout(2000) });
		const { workspace: served } = await response.json();
		return typeof served === 'string' && real(served) === real(workspace) ? record : null;
	} catch {
		return null;
	}
};

export const recordViewer = (workspace, url) =>
	writeFile(
		recordFile(workspace),
		`${JSON.stringify({ pid: process.pid, url, started: Date.now() })}\n`,
	);

export const forgetViewer = (workspace) => rm(recordFile(workspace), { force: true });

/**
 * Whether this command gets to start the viewer. Another one that holds the
 * lock is starting it already; a lock older than a start ever takes was left
 * by a command that died.
 */
const claim = async (lock) => {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await (await open(lock, 'wx')).close();
			return true;
		} catch (error) {
			if (error.code !== 'EEXIST') throw error;
		}
		try {
			if (Date.now() - statSync(lock).mtimeMs < 30_000) return false;
		} catch {
			/* released meanwhile */
		}
		await rm(lock, { force: true });
	}
	return false;
};

export const ensureViewer = async (workspace, port) => {
	const running = await runningViewer(workspace);
	if (running) {
		return running.url;
	}
	await mkdir(workspace, { recursive: true });
	const lock = lockFile(workspace);
	const starter = await claim(lock);
	try {
		if (starter) {
			const log = openSync(path.join(workspace, 'ui.log'), 'a');
			try {
				spawn(
					process.execPath,
					[
						path.resolve(import.meta.dirname, '..', 'bin', 'sbshot.mjs'),
						'ui',
						'--workspace',
						workspace,
						...(port ? ['--port', String(port)] : []),
					],
					{ detached: true, stdio: ['ignore', log, log] },
				).unref();
			} finally {
				closeSync(log);
			}
		}
		// The viewer writes its record once it listens; whichever command
		// started it, the first one that answers is the one.
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const record = await runningViewer(workspace);
			if (record) {
				return record.url;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	} finally {
		if (starter) await rm(lock, { force: true });
	}
	throw new Error(`the viewer did not start, see ${path.join(workspace, 'ui.log')}`);
};
