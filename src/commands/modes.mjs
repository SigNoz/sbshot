import { existsSync, readdirSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';

import { launch, loadPlaywright, resolvePlaywright } from '../playwright.mjs';
import { buildProject, serveStatic } from '../storybook.mjs';
import { workspaceDir } from '../workspace.mjs';

const HELP = `usage: sbshot modes <storybook> [--json]

Prints what a storybook can be shot in, read from its preview at runtime:
the toolbar globals with their values and defaults, the project's Chromatic
modes, and whether the preview reads ?storyClock.

<storybook> is a URL, a storybook build (has index.json), or a project with
.storybook/, in which case the newest workspace build of that project is used.`;

/** A toolbar item is a bare value or `{ value, title }`. */
const itemValue = (item) => (item && typeof item === 'object' ? item.value : item);

/**
 * What a capture can vary, out of the preview's project annotations. A global
 * set only through `initialGlobals` is listed when an addon did not put it
 * there (addon-themes keeps its theme list in a decorator, not in
 * `globalTypes`), so it still shows with its default.
 */
export const summarize = ({ globalTypes = {}, initialGlobals = {}, parameters = {} }) => {
	const globals = Object.entries(globalTypes).map(([name, type]) => ({
		name,
		description: type.description ?? '',
		values: (type.toolbar?.items ?? []).map(itemValue).filter((v) => v != null),
		initial: initialGlobals[name] ?? type.defaultValue ?? null,
	}));
	if (!globalTypes.theme && typeof initialGlobals.theme === 'string') {
		globals.unshift({
			name: 'theme',
			description: 'set by initialGlobals only; values not declared',
			values: [],
			initial: initialGlobals.theme,
		});
	}
	const modes = Object.entries(parameters.chromatic?.modes ?? {}).map(([name, mode]) => {
		const { viewport, ...modeGlobals } = mode ?? {};
		return { name, globals: modeGlobals, viewport: viewport ?? null };
	});
	return { globals, modes };
};

/** How each global is set on a capture. */
const flagOf = (name) =>
	name === 'theme' ? '--theme' : name === 'motion' ? '--motion' : '--globals';

export const format = ({ globals, modes, clock, settleHook }) => {
	const lines = [];
	if (globals.length) {
		lines.push('globals (* = default)');
		const width = Math.max(...globals.map((global) => global.name.length));
		for (const global of globals) {
			const values = global.values.length
				? global.values.map((value) => (value === global.initial ? `${value}*` : value)).join(' ')
				: `${global.initial ?? '?'}*`;
			lines.push(
				`  ${global.name.padEnd(width)}  ${values.padEnd(20)} ${flagOf(global.name).padEnd(10)}${
					global.description ? ` ${global.description.split(/(?<=\.)\s/)[0]}` : ''
				}`,
			);
		}
	} else {
		lines.push('globals: none declared, --theme and --motion change nothing');
	}
	if (modes.length) {
		lines.push('chromatic modes');
		const width = Math.max(...modes.map((mode) => mode.name.length));
		for (const mode of modes) {
			const set = Object.entries(mode.globals).map(([k, v]) => `${k}:${v}`);
			if (mode.viewport?.width) {
				set.push(`${mode.viewport.width}${mode.viewport.height ? `x${mode.viewport.height}` : ''}`);
			}
			lines.push(`  ${mode.name.padEnd(width)}  ${set.join(' ')}`);
		}
	} else {
		lines.push('chromatic modes: none at project level');
	}
	lines.push(
		clock
			? 'clock: the preview reads ?storyClock, --clock works'
			: 'clock: nothing reads ?storyClock, --clock changes nothing and dates move between runs',
	);
	lines.push(settleHook ? 'settle hook: window.__sbshotSettle is defined' : 'settle hook: none');
	return lines.join('\n');
};

/** The newest build in the workspace that sbshot made from `project`. */
const workspaceBuild = (workspace, project) => {
	const builds = path.join(workspace, 'builds');
	if (!existsSync(builds)) {
		return null;
	}
	return (
		readdirSync(builds, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(builds, entry.name))
			.filter((dir) => buildProject(dir) === project)
			.map((dir) => ({ dir, mtime: statSync(dir).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime)[0]?.dir ?? null
	);
};

export const modes = async (argv) => {
	const { values: opts, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			workspace: { type: 'string', short: 'w' },
			json: { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h', default: false },
		},
	});
	if (opts.help || !positionals[0]) {
		console.log(HELP);
		return opts.help ? 0 : 1;
	}

	const [source] = positionals;
	const isUrl = /^https?:\/\//.test(source);
	let staticDir = null;
	if (!isUrl) {
		if (existsSync(path.join(source, 'index.json'))) {
			staticDir = source;
		} else if (existsSync(path.join(source, '.storybook'))) {
			staticDir = workspaceBuild(workspaceDir(opts.workspace), path.resolve(source));
			if (!staticDir) {
				console.error(
					`no build of ${source} in the workspace yet. Make one with 'sbshot list ${source}', or pass a URL.`,
				);
				return 1;
			}
			console.error(`reading ${staticDir}`);
		} else {
			console.error(
				`${source}: not a URL, a storybook build (no index.json) or a project (no .storybook/)`,
			);
			return 1;
		}
	}

	const server = staticDir ? await serveStatic(staticDir) : null;
	const base = server?.url ?? source.replace(/\/$/, '');
	const browser = await launch(await loadPlaywright(resolvePlaywright()));
	try {
		const page = await browser.newPage();
		// The clock is read by the preview's own code, in preview-head.html or in
		// a bundle, so every script and page it loads is searched for the name.
		let clock = false;
		const reads = [];
		page.on('response', (response) => {
			const type = response.request().resourceType();
			if (!clock && ['document', 'script'].includes(type)) {
				reads.push(
					response
						.text()
						.then((text) => {
							clock ||= text.includes('storyClock');
						})
						.catch(() => {}),
				);
			}
		});
		await page.goto(`${base}/iframe.html`, { waitUntil: 'domcontentloaded' });
		await page.waitForFunction(
			() => window.__STORYBOOK_PREVIEW__?.storyStoreValue?.projectAnnotations,
			undefined,
			{ timeout: 120_000 },
		);
		const { annotations, settleHook } = await page.evaluate(() => {
			const { globalTypes, initialGlobals, parameters } =
				window.__STORYBOOK_PREVIEW__.storyStoreValue.projectAnnotations;
			// Functions and other values JSON cannot carry are dropped on the way.
			return {
				annotations: JSON.parse(
					JSON.stringify({
						globalTypes,
						initialGlobals,
						parameters: { chromatic: parameters?.chromatic },
					}),
				),
				settleHook: typeof window.__sbshotSettle === 'function',
			};
		});
		await Promise.all(reads);
		const result = { ...summarize(annotations), clock, settleHook };
		console.log(opts.json ? JSON.stringify(result, null, 2) : format(result));
		return 0;
	} catch (error) {
		console.error(`cannot read the preview at ${base}: ${error.message.split('\n')[0]}`);
		return 1;
	} finally {
		await browser.close();
		await server?.close();
	}
};
