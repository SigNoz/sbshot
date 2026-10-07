import { spawn } from 'node:child_process';

/** A desktop notification, where the machine has a way to show one. Never fails the run. */
export const notify = (title, body) => {
	const command =
		process.platform === 'darwin'
			? [
					'osascript',
					[
						'-e',
						`display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`,
					],
				]
			: ['notify-send', ['--app-name=sbshot', title, body]];
	try {
		const child = spawn(command[0], command[1], {
			stdio: 'ignore',
			detached: true,
		});
		child.on('error', () => {});
		child.unref();
	} catch {
		/* no notifier */
	}
};
