import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { isMainThread, parentPort, threadId, Worker, workerData } from 'node:worker_threads';
import path from 'node:path';

import {
	bodyFont,
	CONFIG_KEYS,
	literal,
	magick,
	palette,
	pointsize,
	settingsLine,
	stamp,
} from './caption.mjs';
import { diffPair, hexToRgb, maxDeltaFor } from './pixels.mjs';
import { decodePng, sameImage, sizeOf } from './png.mjs';
import { readJson } from './workspace.mjs';

/**
 * The per-pair work, set up once per thread. `settings` is plain data so the
 * main thread can hand it to workers unchanged.
 */
export const createComparer = async (settings) => {
	const { baseDir, afterDir, outDir, mode, noCaption } = settings;
	const maxDelta = maxDeltaFor(settings.threshold);
	const highlight = hexToRgb(settings.tint || (mode.startsWith('green') ? '#00e05a' : '#ff003a'));
	const inBase = new Set(settings.baseFiles);
	const inAfter = new Set(settings.afterFiles);
	// What each run was and how it was configured, from the `shots.json` a
	// capture leaves beside its output. A directory assembled by hand has none
	// and gets no caption.
	const [baseRun, afterRun] = [baseDir, afterDir].map((dir) =>
		readJson(path.join(dir, 'shots.json')),
	);

	const byFile = (run) => new Map((run?.shots ?? []).map((shot) => [shot.file, shot]));
	const baseShots = byFile(baseRun);
	const afterShots = byFile(afterRun);
	const posix = (rel) => rel.split(path.sep).join('/');

	/** The settings the two runs disagree on: what a difference in the shots may be. */
	const changedKeys = CONFIG_KEYS.filter(
		(key) => (baseRun?.config?.[key] ?? '') !== (afterRun?.config?.[key] ?? ''),
	);
	const settingsOf = (run, keys) => settingsLine(run?.config, keys);
	const shotOf = (rel) => afterShots.get(posix(rel)) ?? baseShots.get(posix(rel));
	// Rows to crop off the top, which shots.json only claims: a whole number or none.
	const captionOf = (shots, rel) => {
		const rows = shots.get(posix(rel))?.caption;
		return Number.isSafeInteger(rows) && rows > 0 ? rows : 0;
	};
	const themeOf = (rel) => shotOf(rel)?.theme ?? rel.split(path.sep)[0];

	/** The first frame only: a file named .png may hold several, or be no PNG at all. */
	const decodeWithMagick = (file) => {
		const frame = `${file}[0]`;
		const [width, height] = magick(['identify', '-format', '%w %h', frame])
			.toString()
			.split(' ')
			.map(Number);
		const data = magick([frame, '-depth', '8', 'RGBA:-']);
		if (!(width > 0 && height > 0 && data.length === width * height * 4)) {
			throw new Error(`${file}: ImageMagick read ${width}x${height} and ${data.length} bytes`);
		}
		return { width, height, data };
	};

	/**
	 * `top` rows are dropped: a shot's caption is not what the runs are
	 * compared on. `top` is how many were, which a tile of the same shot crops.
	 */
	const readRgba = (file, top = 0, bytes = readFileSync(file)) => {
		const { width, height, data } = decodePng(bytes) ?? decodeWithMagick(file);
		return top > 0 && top < height
			? { width, height: height - top, data: data.subarray(top * width * 4), top }
			: { width, height, data, top: 0 };
	};

	const writeRgba = ({ width, height, data }, file) =>
		writeFile(
			file,
			magick(['-depth', '8', '-size', `${width}x${height}`, 'RGBA:-', 'png:-'], data),
		);

	/** ImageMagick's inline crop, so a tile shows the shot as it was compared. */
	const withoutCaption = (file, { width, height, top }) =>
		top > 0 ? `${file}[${width}x${height}+0+${top}]` : file;

	/** Story, then the settings both runs shared. */
	const header = (rel) => {
		const shot = shotOf(rel);
		const shared = settingsOf(
			afterRun,
			CONFIG_KEYS.filter((key) => !changedKeys.includes(key)),
		);
		return [
			shot ? `${shot.title}/${shot.name}` : rel.replace(/\.png$/, ''),
			[shot?.id ?? '', shot?.theme ?? '', shot?.status === 'busy' ? '(busy)' : '']
				.filter(Boolean)
				.join('  '),
			shared,
		].filter(Boolean);
	};

	const sideLabel = (side, run) => [side, settingsOf(run, changedKeys)].filter(Boolean).join('   ');

	const captionLines = (rel, lines) =>
		noCaption ? [] : [...header(rel), ...lines].filter(Boolean);

	/** The half-built tiles, under the output directory so nothing is left elsewhere. */
	const scratch = Object.fromEntries(
		['body', 'shot', 'missing'].map((name) => [
			name,
			path.join(outDir, `.sbshot-${process.pid}-${threadId}-${name}.png`),
		]),
	);

	const tile = (label, file, background) => [
		'(',
		`label:${literal(label)}`,
		file,
		'-gravity',
		'center',
		'-append',
		'-bordercolor',
		background,
		'-border',
		'12',
		')',
	];

	/** Writes the tiles side by side under one caption; returns the caption's rows. */
	const montage = async ({ tiles, width, background, foreground, caption, target, theme }) => {
		magick([
			'-background',
			background,
			'-fill',
			foreground,
			...bodyFont(),
			'-pointsize',
			String(Math.round(pointsize(width * 3) * 0.62)),
			...tiles.flat(),
			'-gravity',
			'north',
			'+append',
			caption.length ? scratch.body : target,
		]);
		return caption.length ? stamp({ lines: caption, from: scratch.body, to: target, theme }) : 0;
	};

	const placeholder = (file, { width, height }, text, { background, foreground }) =>
		magick([
			'-size',
			`${width}x${height}`,
			'-background',
			foreground,
			'-fill',
			background,
			'-gravity',
			'center',
			...bodyFont(),
			'-pointsize',
			String(pointsize(width * 3)),
			`label:${literal(text)}`,
			file,
		]);

	/** A plain image under its caption; returns the caption's rows. */
	const writeCaptioned = async (image, target, caption, theme) => {
		await writeRgba(image, caption.length ? scratch.body : target);
		return caption.length ? stamp({ lines: caption, from: scratch.body, to: target, theme }) : 0;
	};

	const parallel = mode.endsWith('-parallel');

	return async (rel) => {
		const started = Date.now();
		const afterFile = path.join(afterDir, rel);
		const baseFile = path.join(baseDir, rel);
		const target = path.join(outDir, rel);
		const output = posix(rel);
		const result = {
			file: output,
			baseCaption: captionOf(baseShots, rel),
			afterCaption: captionOf(afterShots, rel),
		};
		await mkdir(path.dirname(target), { recursive: true });

		// A story added, removed or renamed since the baseline has nothing to
		// compare against: the side that has it is written out and every one of
		// its pixels counts.
		if (!inBase.has(rel) || !inAfter.has(rel)) {
			const gone = inAfter.has(rel) ? 'previous' : 'current';
			const held = gone === 'previous' ? 'current' : 'previous';
			const run = gone === 'previous' ? afterRun : baseRun;
			const image = readRgba(
				gone === 'previous' ? afterFile : baseFile,
				gone === 'previous' ? result.afterCaption : result.baseCaption,
			);
			const theme = themeOf(rel);
			const colors = palette(theme);
			const caption = captionLines(rel, [`missing ${gone}`]);
			let outputCaption;

			if (parallel) {
				await writeRgba(image, scratch.shot);
				placeholder(scratch.missing, image, `missing ${gone}`, colors);
				const sides = {
					[held]: tile(sideLabel(held, run), scratch.shot, colors.background),
					[gone]: tile(
						sideLabel(gone, gone === 'previous' ? baseRun : afterRun),
						scratch.missing,
						colors.background,
					),
				};
				outputCaption = await montage({
					tiles: [sides.previous, sides.current, tile('diff', scratch.missing, colors.background)],
					width: image.width,
					...colors,
					caption,
					target,
					theme,
				});
			} else {
				outputCaption = await writeCaptioned(image, target, caption, theme);
			}

			const pixels = image.width * image.height;
			return {
				...result,
				changed: pixels,
				pixels,
				ratio: 1,
				note: `missing ${gone}`,
				output,
				outputCaption,
				width: image.width,
				height: image.height,
				duration: Date.now() - started,
			};
		}

		const baseBytes = readFileSync(baseFile);
		const afterBytes = readFileSync(afterFile);
		// The same image, caption included, has nothing to decode or to draw.
		if (sameImage(baseBytes, afterBytes)) {
			const { width, height } = sizeOf(afterBytes);
			const top = result.afterCaption;
			const visible = top > 0 && top < height ? height - top : height;
			return {
				...result,
				changed: 0,
				pixels: width * visible,
				ratio: 0,
				width,
				height: visible,
				duration: Date.now() - started,
			};
		}

		const base = readRgba(baseFile, result.baseCaption, baseBytes);
		const after = readRgba(afterFile, result.afterCaption, afterBytes);
		const diff = diffPair(base, after, {
			mode,
			maxDelta,
			includeAA: settings.includeAA,
			highlight,
		});
		const pixels = Math.max(base.width * base.height, after.width * after.height);
		if (!diff.changed) {
			return {
				...result,
				changed: 0,
				pixels,
				ratio: 0,
				width: after.width,
				height: after.height,
				duration: Date.now() - started,
			};
		}

		// With no tiles to label, a run's own settings go in the caption instead.
		const caption = captionLines(
			rel,
			parallel || !changedKeys.length
				? []
				: [sideLabel('previous', baseRun), sideLabel('current', afterRun)],
		);
		const theme = themeOf(rel);
		const { background, foreground } = palette(theme);

		let outputCaption;
		let plain;
		if (parallel) {
			// The montage is what a reader opens; the viewer lays its own tiles
			// out and wants the diff alone, so that is kept beside it.
			plain = posix(path.join('plain', rel));
			await mkdir(path.dirname(path.join(outDir, plain)), { recursive: true });
			await writeRgba(diff, path.join(outDir, plain));
			outputCaption = await montage({
				tiles: [
					tile(sideLabel('previous', baseRun), withoutCaption(baseFile, base), background),
					tile(sideLabel('current', afterRun), withoutCaption(afterFile, after), background),
					tile('diff', path.join(outDir, plain), background),
				],
				width: after.width,
				background,
				foreground,
				caption,
				target,
				theme,
			});
		} else {
			outputCaption = await writeCaptioned(diff, target, caption, theme);
		}

		return {
			...result,
			changed: diff.changed,
			pixels,
			ratio: diff.changed / pixels,
			box: diff.box,
			output,
			outputCaption,
			plain,
			width: after.width,
			height: after.height,
			duration: Date.now() - started,
		};
	};
};

/** Runs `createComparer` on a thread, one pair per message. */
export const comparerThread = (settings) =>
	new Worker(new URL(import.meta.url), { workerData: { sbshotDiff: true, settings } });

// A thread started by `comparerThread` runs this same module: it sets up the
// comparer from the main thread's settings and answers one pair per message.
if (!isMainThread && workerData?.sbshotDiff) {
	const compare = await createComparer(workerData.settings);
	parentPort.on('message', async (rel) => parentPort.postMessage(await compare(rel)));
}
