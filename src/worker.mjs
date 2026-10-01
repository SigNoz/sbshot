import { mkdir, rename, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

import { stamp } from './caption.mjs';
import { launch, loadPlaywright } from './playwright.mjs';
import { shotPaths } from './workspace.mjs';

/**
 * A shooting process: one browser, a fresh page per story the coordinator
 * sends. Everything it needs arrives as JSON in `SBSHOT_SETTINGS`, so this
 * file has no flags of its own. It reports back over the IPC channel:
 * `ready`, `load` (its event loop busyness), `phase` and `loaded` while a story
 * runs, and `result` when it ends.
 */
const settings = JSON.parse(process.env.SBSHOT_SETTINGS);
const {
	base,
	outDir,
	flat,
	width: WIDTH,
	height: HEIGHT,
	maxHeight: MAX_HEIGHT,
	grow,
	settle: SETTLE,
	clock,
	motion,
	ignore: ignoreSelectors,
	highlight: highlightSelector,
	crop: cropSelector,
	args: storyArgs,
	globals: extraGlobals,
	captioning,
	configLine,
	playwrightModule,
} = settings;

const send = (message) => process.connected && process.send(message);

const { dirOf, shotFile } = shotPaths(outDir, flat);

/**
 * `[data-shot-ignore]` and `--ignore` hide what cannot be settled, the local
 * half of Chromatic's `data-chromatic="ignore"`.
 */
const ignoreCss = (ignore) => {
	const extra = ignore ? `, ${ignore}` : '';
	return `[data-shot-ignore], [data-chromatic='ignore']${extra} {
	visibility: hidden !important;
}`;
};

/**
 * Contexts a finished story handed back. A page per story is what dodges msw's
 * worker re-registration race; the context around it can stay, and keeps the
 * storybook bundle in its HTTP and code caches.
 */
const idleContexts = [];

const shoot = async (key, story, theme) => {
	const started = Date.now();
	const phase = (name) => send({ type: 'phase', key, phase: name });
	const dir = dirOf(theme);
	const cropDir = path.join(dir, 'crops');
	// Kept apart until the story succeeds, so a retry does not record it twice.
	const recorded = [];
	const cropped = [];
	const notes = [];

	const context =
		idleContexts.pop() ??
		(await browser.newContext({
			reducedMotion: motion ? 'no-preference' : 'reduce',
		}));
	const page = await context.newPage();
	await page.setViewportSize({ width: WIDTH, height: HEIGHT });
	let failed = false;

	// Added before the page loads rather than with `addStyleTag` after it: a
	// frame the preview's CSP refuses at that moment rejects `addStyleTag`.
	await page.addInitScript((css) => {
		if (window === window.top) {
			document.addEventListener('DOMContentLoaded', () => {
				const style = document.createElement('style');
				style.textContent = css;
				document.head.append(style);
			});
		}
	}, ignoreCss(ignoreSelectors));

	// react-query retries and msw both keep requests going long after load, so
	// the settle waits on the page being quiet rather than on a fixed delay.
	let inFlight = 0;
	let lastActivity = Date.now();
	page.on('request', () => {
		inFlight += 1;
		lastActivity = Date.now();
	});
	const done = () => {
		inFlight = Math.max(inFlight - 1, 0);
		lastActivity = Date.now();
	};
	page.on('requestfinished', done);
	page.on('requestfailed', done);

	// A panel that has not sent its query yet shows a spinner the network
	// cannot see, so a visible `aria-busy` counts as not quiet either.
	const busyOnScreen = () =>
		page.evaluate(() =>
			[...document.querySelectorAll('[aria-busy="true"]')].some(
				(element) => element.getClientRects().length > 0,
			),
		);
	const quiet = async () => {
		await page.evaluate(() => document.fonts.ready);
		const quietUntil = Date.now() + 15_000;
		while (
			Date.now() < quietUntil &&
			(inFlight > 0 || Date.now() - lastActivity < 600 || (await busyOnScreen()))
		) {
			await page.waitForTimeout(200);
		}
	};

	// A resize brings panels into view that start fetching only then, so every
	// resize waits for the network again.
	const settle = async () => {
		await quiet();
		await page.evaluate(
			() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
		);
		await page.waitForTimeout(SETTLE);
	};

	// The height the rounds had reached when the page turned out to grow with
	// the viewport, kept only to flag the story.
	let chasing = 0;

	const url = new URL(`${base}/iframe.html`);
	url.searchParams.set('viewMode', 'story');
	url.searchParams.set('id', story.id);
	// The preview owns the clock and the motion state, so both are asked for in
	// the URL rather than injected here.
	url.searchParams.set('storyClock', clock);
	const globals = [theme && `theme:${theme}`, motion && 'motion:live', extraGlobals]
		.filter(Boolean)
		.join(';');
	if (globals) {
		url.searchParams.set('globals', globals);
	}
	if (storyArgs) {
		url.searchParams.set('args', storyArgs);
	}

	try {
		await page.goto(url.href, { waitUntil: 'domcontentloaded' });
		phase('render');

		// Storybook's own render phase is the readiness signal: it reaches
		// `finished` only once the loaders, the decorators and the story's `play`
		// are all done, which a DOM check cannot see.
		await page.waitForFunction(
			() =>
				(window.__STORYBOOK_PREVIEW__?.storyRenders ?? []).some((render) =>
					['finished', 'errored', 'aborted'].includes(render.phase),
				) || document.body.classList.contains('sb-show-errordisplay'),
			undefined,
			{ timeout: 120_000 },
		);
		send({ type: 'loaded', key });

		// A `play` that timed out leaves the story half way, which is not a
		// state worth a shot. Failing it puts it back in the queue.
		if (
			await page.evaluate(
				() =>
					(window.__STORYBOOK_PREVIEW__?.storyRenders ?? []).some(
						(render) => render.phase === 'errored',
					) || document.body.classList.contains('sb-show-errordisplay'),
			)
		) {
			throw new Error('the story errored while rendering');
		}

		if (!motion) {
			// Videos and GIFs are parked on their first frame, as Chromatic does.
			await page.evaluate(() =>
				document.querySelectorAll('video').forEach((video) => video.pause?.()),
			);
		}

		// A story can pin its viewport with `parameters.storyShots.viewport`
		// (or `parameters.sbshot.viewport`), `{ width?, height? }`.
		const pinned = await page.evaluate(() => {
			const parameters = window.__STORYBOOK_PREVIEW__?.storyRenders?.at(-1)?.story?.parameters;
			return parameters?.sbshot?.viewport ?? parameters?.storyShots?.viewport;
		});
		if (pinned) {
			await page.setViewportSize({
				width: pinned.width ?? WIDTH,
				height: pinned.height ?? HEIGHT,
			});
			notes.push(`viewport ${page.viewportSize().width}x${page.viewportSize().height} pinned`);
		}

		phase('settle');
		await settle();

		// The width is the fixed dimension and the height follows the page, the
		// way a Chromatic viewport does. `scrollers` grows the viewport until the
		// tallest in-flow inner scroller fits. A page that sizes a panel in `vh`
		// grows with the viewport, so no height fits it and the rounds only
		// chase: such a page is shot at `--height` with its own scrollbar.
		if (grow !== 'none' && !pinned) {
			phase('grow');
			let height = HEIGHT;
			let fits = false;
			for (let round = 0; round < 3 && !fits; round += 1) {
				const needed = Math.min(
					MAX_HEIGHT,
					Math.ceil(
						await page.evaluate((withScrollers) => {
							const document_ = Math.max(
								document.documentElement.scrollHeight,
								document.body.scrollHeight,
							);
							if (!withScrollers) {
								return document_;
							}

							// Popups are skipped: they are out of the flow, and a tall
							// dropdown would otherwise drag the shot to a height nothing
							// on the page itself needs.
							const inFlow = (element) => {
								for (
									let node = element;
									node && node !== document.documentElement;
									node = node.parentElement
								) {
									const { position } = getComputedStyle(node);
									if (position === 'fixed' || position === 'absolute') {
										return false;
									}
								}
								return true;
							};

							return [...document.querySelectorAll('*')].reduce((tallest, element) => {
								const { overflowY } = getComputedStyle(element);
								if (
									!['auto', 'scroll', 'overlay'].includes(overflowY) ||
									element.scrollHeight - element.clientHeight <= 1 ||
									!inFlow(element)
								) {
									return tallest;
								}

								const box = element.getBoundingClientRect();
								const above = box.top + window.scrollY;
								const below = Math.max(0, document_ - (box.bottom + window.scrollY));
								return Math.max(tallest, above + element.scrollHeight + below);
							}, document_);
						}, grow === 'scrollers'),
					),
				);
				fits = needed <= height;
				if (fits) {
					break;
				}

				height = Math.ceil(needed);
				await page.setViewportSize({ width: WIDTH, height });
				await settle();
			}

			if (!fits && height !== HEIGHT) {
				chasing = height;
				height = HEIGHT;
				await page.setViewportSize({ width: WIDTH, height });
				await settle();
			}
		}

		// Hooks the preview may expose to settle what only it can see, such as a
		// virtualised list still measuring. SigNoz's is kept by its old name.
		await page.evaluate(() => window.__sbshotSettle?.() ?? window.__signozSnapPinnedScrollers?.());
		await quiet();

		// A page that is still moving is shot twice in a row until two frames
		// come back identical. The frames are compared as JPEG, which Chromium
		// encodes far faster than PNG; only the kept frame is lossless.
		phase('stable');
		const frame = () => page.screenshot({ type: 'jpeg', quality: 90 });
		let previous = await frame();
		let stable = false;
		for (let attempt = 0; attempt < 8 && !stable; attempt += 1) {
			await page.waitForTimeout(400);
			const next = await frame();
			stable = next.equals(previous);
			previous = next;
		}
		phase('write');
		const shot = await page.screenshot();
		const size = page.viewportSize();

		/**
		 * The band goes on the shot itself so a single screenshot says what it
		 * is, and its height is returned so a diff can take it back off. The
		 * temporary is written beside the shot: a rename across filesystems
		 * fails with EXDEV.
		 */
		const caption = async (target, lines) => {
			if (!captioning) {
				return 0;
			}

			const temporary = path.join(path.dirname(target), `.caption-${path.basename(target)}`);
			const rows = await stamp({
				lines: [
					`${story.title}/${story.name}`,
					[story.id, theme ?? 'default', stable ? '' : '(busy)'].filter(Boolean).join('  '),
					...lines,
				].filter(Boolean),
				from: target,
				to: temporary,
				theme: theme ?? 'dark',
			});
			await rename(temporary, target);
			return rows;
		};

		const file = path.join(dir, `${story.id}.png`);
		await writeFile(file, shot);

		const record = (relative, captionRows, extra) =>
			recorded.push({
				file: shotFile(theme, relative),
				id: story.id,
				title: story.title,
				name: story.name,
				theme: theme ?? 'default',
				status: stable ? 'ok' : 'busy',
				caption: captionRows,
				...extra,
			});

		const mainCaption = await caption(file, [configLine]);
		record(`${story.id}.png`, mainCaption, {
			duration: Date.now() - started,
			width: size.width,
			height: size.height,
		});

		// The crops are taken before anything is drawn over the page, so a
		// component's own shot carries no ring and no label.
		if (cropSelector) {
			phase('crop');
			await mkdir(cropDir, { recursive: true });

			// What is below the fold of a chased page is laid out but never
			// painted, so the crops are taken at the height the rounds reached.
			if (chasing) {
				await page.setViewportSize({ width: WIDTH, height: chasing });
				await settle();
			}

			const matches = page.locator(cropSelector);
			let kept = 0;
			for (let index = 0; index < (await matches.count()); index += 1) {
				const element = matches.nth(index);
				// A group whose children are all conditional renders as a 0x0 box.
				const box = await element.boundingBox();
				if (!box || box.width < 1 || box.height < 1) {
					continue;
				}

				kept += 1;
				const relative = `${story.id}--${kept}.png`;
				// The scroll that brings an element into view needs a frame before
				// the crop, or the region comes back unpainted.
				await element.scrollIntoViewIfNeeded({ timeout: 15_000 });
				await page.waitForTimeout(250);
				await element.screenshot({
					path: path.join(cropDir, relative),
					timeout: 15_000,
				});
				cropped.push({
					file: path.join(cropDir, relative),
					label: `${story.title}/${story.name}  #${kept}`,
				});
				record(path.posix.join('crops', relative), 0);
			}
			notes.push(`${kept} cropped`);

			if (chasing) {
				await page.setViewportSize({ width: WIDTH, height: HEIGHT });
				await settle();
			}
		}

		if (highlightSelector) {
			phase('highlight');
			const ringed = await page.evaluate(
				([selector, padding]) => {
					const layer = document.createElement('div');
					layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
					let drawn = 0;
					for (const element of document.querySelectorAll(selector)) {
						const box = element.getBoundingClientRect();
						if (box.width < 1 || box.height < 1) {
							continue;
						}

						drawn += 1;
						const ring = document.createElement('div');
						ring.style.cssText = `position:fixed;box-sizing:border-box;border:3px solid #ff003a;border-radius:4px;left:${
							box.left - padding
						}px;top:${box.top - padding}px;width:${
							box.width + padding * 2
						}px;height:${box.height + padding * 2}px`;
						layer.append(ring);
					}
					document.documentElement.append(layer);
					window.__sbshotHighlight = layer;
					return drawn;
				},
				[highlightSelector, 6],
			);

			const highlighted = path.join(dir, `${story.id}--highlight.png`);
			await writeFile(highlighted, await page.screenshot());
			record(
				`${story.id}--highlight.png`,
				await caption(highlighted, [`${ringed} highlighted`, configLine]),
			);
			notes.push(`${ringed} highlighted`);
			await page.evaluate(() => {
				window.__sbshotHighlight?.remove();
				delete window.__sbshotHighlight;
			});
		}
		if (chasing) {
			notes.push(`viewport-sized content, stopped chasing ${chasing}px`);
		}
		return {
			recorded,
			cropped,
			notes,
			status: stable ? 'ok' : 'busy',
			size,
			caption: mainCaption,
			duration: Date.now() - started,
		};
	} catch (error) {
		failed = true;
		return {
			failed,
			error: error.message.split('\n')[0],
			duration: Date.now() - started,
		};
	} finally {
		// The next story on this context starts with no storage of this one's.
		// A context a story failed in is not trusted with another.
		const cleared =
			!failed &&
			(await context
				.newCDPSession(page)
				.then((session) =>
					session.send('Storage.clearDataForOrigin', {
						origin: new URL(base).origin,
						storageTypes: 'cookies,indexeddb,local_storage,cache_storage',
					}),
				)
				.then(
					() => true,
					() => false,
				));
		await page.close().catch(() => {});
		if (cleared) {
			idleContexts.push(context);
		} else {
			await context.close().catch(() => {});
		}
	}
};

const browser = await launch(await loadPlaywright(playwrightModule));

// How busy this process's event loop is, which is where every CDP message and
// every screenshot of its pages is decoded.
let last = performance.eventLoopUtilization();
setInterval(() => {
	const now = performance.eventLoopUtilization();
	send({ type: 'load', load: performance.eventLoopUtilization(now, last).utilization });
	last = now;
}, 1000).unref();

process.on('message', async ({ key, story, theme }) =>
	send({ type: 'result', key, ...(await shoot(key, story, theme)) }),
);
process.on('disconnect', async () => {
	await browser.close();
	process.exit(0);
});
send({ type: 'ready' });
