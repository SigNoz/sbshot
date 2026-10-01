import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { LOOPBACK } from '../loopback.mjs';
import { serve } from '../server.mjs';
import { forgetViewer, recordViewer } from '../viewer.mjs';
import { workspaceDir } from '../workspace.mjs';

export const ui = async (argv) => {
	const { values: opts } = parseArgs({
		args: argv,
		options: {
			workspace: { type: 'string', short: 'w' },
			port: { type: 'string', default: process.env.SBSHOT_PORT ?? '7007' },
			host: { type: 'string', default: '127.0.0.1' },
			open: { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h', default: false },
		},
	});
	if (opts.help) {
		console.log(`usage: sbshot ui [--port 7007] [--host 127.0.0.1] [--open] [--workspace dir]

Serves the viewer: runs in progress with their ETA and shots as they land,
finished runs, and diffs with side-by-side, swipe, onion and blink compare.
Port 0 picks a free one.`);
		return 0;
	}
	const workspace = workspaceDir(opts.workspace);
	await mkdir(workspace, { recursive: true });
	if (!LOOPBACK.has(opts.host.toLowerCase())) {
		console.error(
			`warning: --host ${opts.host} is not loopback, and the viewer has no login. Anyone who can reach it can see every shot of the workspace, set verdicts and start diffs.`,
		);
	}
	let server;
	try {
		server = await serve({ workspace, port: Number(opts.port), host: opts.host });
	} catch (error) {
		if (error.code !== 'EADDRINUSE') {
			throw error;
		}
		server = await serve({ workspace, port: 0, host: opts.host });
	}
	await recordViewer(workspace, server.url);
	const stop = async () => {
		await forgetViewer(workspace);
		process.exit(0);
	};
	process.once('SIGINT', stop);
	process.once('SIGTERM', stop);
	console.log(`sbshot ui: ${server.url}  (workspace ${workspace})`);
	if (opts.open) {
		const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
		spawn(opener, [server.url], { stdio: 'ignore', detached: true })
			.on('error', () => {})
			.unref();
	}
	return new Promise(() => {});
};
