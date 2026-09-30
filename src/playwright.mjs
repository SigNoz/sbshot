import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * Playwright is looked up next to this tool first (it is a dependency), then
 * from the directory the command runs in, then globally. `@playwright/test`
 * re-exports `chromium`, so an e2e install alone is enough.
 */
export const resolvePlaywright = () => {
	const specifiers = process.env.PLAYWRIGHT_MODULE
		? [process.env.PLAYWRIGHT_MODULE]
		: ['playwright', '@playwright/test', 'playwright-core'];

	const find = (roots) => {
		for (const specifier of specifiers) {
			for (const root of roots) {
				try {
					return createRequire(path.join(root, '-')).resolve(specifier);
				} catch {
					/* next candidate */
				}
			}
		}
		return null;
	};

	const local = find([import.meta.dirname, process.cwd()]);
	if (local) {
		return local;
	}
	const globalRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
	const global = globalRoot.status === 0 && find([path.dirname(globalRoot.stdout.trim())]);
	if (global) {
		return global;
	}
	throw new Error(
		'playwright not found. Reinstall sbshot (npm install -g @signozhq/sbshot), or set PLAYWRIGHT_MODULE.',
	);
};

/** The module `resolvePlaywright` found, whichever way it exports `chromium`. */
export const loadPlaywright = async (file) => {
	const module = await import(pathToFileURL(file).href);
	return module.chromium ? module : module.default;
};

/**
 * A playwright install carries no browser of its own, and the revision it wants
 * is often not the one that was downloaded, so an installed Chrome is the
 * fallback before giving up.
 */
export const launch = async (pw) => {
	if (process.env.CHROME_PATH) {
		return pw.chromium.launch({ executablePath: process.env.CHROME_PATH });
	}
	try {
		return await pw.chromium.launch();
	} catch (error) {
		try {
			return await pw.chromium.launch({ channel: 'chrome' });
		} catch {
			console.error(
				`${error.message.split('\n')[0]}\nRun 'npx playwright install chromium' or set CHROME_PATH to a browser binary.`,
			);
			return process.exit(1);
		}
	}
};
