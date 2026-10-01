import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';

/**
 * The caption band both capture and diff stamp on their
 * output, and the ImageMagick plumbing under it. A shot records the band's
 * height in `shots.json` so the diff can crop it back off before comparing:
 * otherwise two runs whose captions differ would report the caption as a change.
 */
export const CONFIG_KEYS = [
	'args',
	'clock',
	'width',
	'height',
	'grow',
	'motion',
	'settle',
	'ignore',
	'highlight',
	'crop',
];

let tools;

const detect = () =>
	(tools ??= {
		seven: spawnSync('magick', ['-version']).status === 0,
		six: spawnSync('convert', ['-version']).status === 0,
	});

export const hasMagick = () => {
	const { seven, six } = detect();
	return seven || six;
};

/** Whether this ImageMagick was built with WebP writing. */
let webp;
export const writesWebp = () => {
	try {
		webp ??= hasMagick() && /^\s*WEBP\*?\s+\S+\s+rw/m.test(magick(['-list', 'format']).toString());
	} catch {
		webp = false;
	}
	return webp;
};

export const requireMagick = () => {
	if (hasMagick()) {
		return;
	}
	console.error(
		'ImageMagick not found. Install it (brew install imagemagick, apt install imagemagick).',
	);
	process.exit(1);
};

// ImageMagick 6 has no `magick`: its tools are separate binaries.
const commandLine = (args) =>
	detect().seven
		? ['magick', ...args]
		: ['identify', 'montage'].includes(args[0])
			? args
			: ['convert', ...args];

export const magick = (args, input) => {
	const [command, ...rest] = commandLine(args);
	const result = spawnSync(command, rest, {
		input,
		maxBuffer: 1024 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(`${command} ${rest.join(' ')}: ${result.stderr}`);
	}
	return result.stdout;
};

/** `magick` without blocking the event loop, for callers with pages in flight. */
export const magickAsync = (args, input) =>
	new Promise((resolve, reject) => {
		const [command, ...rest] = commandLine(args);
		const child = spawn(command, rest);
		const stdout = [];
		const stderr = [];
		child.stdout.on('data', (chunk) => stdout.push(chunk));
		child.stderr.on('data', (chunk) => stderr.push(chunk));
		child.on('error', reject);
		child.on('close', (status) =>
			status === 0
				? resolve(Buffer.concat(stdout))
				: reject(new Error(`${command} ${rest.join(' ')}: ${Buffer.concat(stderr)}`)),
		);
		child.stdin.end(input);
	});

/**
 * ImageMagick's built-in default is a serif that reads as a book, not as a
 * screenshot label, so the band asks for what is installed: a sans for the
 * heading, a mono for the lines that carry ids, args and numbers. An
 * unrecognised name is fatal to `convert`, hence the check against the list it
 * reports; a machine with none of them keeps the default.
 */
const FONTS = {
	heading: [
		'Helvetica-Bold',
		'DejaVu-Sans-Bold',
		'Liberation-Sans-Bold',
		'Arial-Bold',
		'Noto-Sans-Bold',
		'DejaVu-Sans',
		'Liberation-Sans',
	],
	body: ['Menlo', 'DejaVu-Sans-Mono', 'Liberation-Mono', 'JetBrainsMono-NF-Regular', 'Courier'],
};

let installed;

const fontArgs = (role) => {
	installed ??= new Set(
		[
			...magick(['-list', 'font'])
				.toString()
				.matchAll(/^\s*Font:\s*(\S+)/gm),
		].map(([, name]) => name),
	);
	const font = FONTS[role].find((name) => installed.has(name));
	return font ? ['-font', font] : [];
};

/** Readable at fit-to-width, whatever the image is. */
export const pointsize = (width) => Math.min(Math.max(Math.round(width / 45), 24), 140);

export const bodyFont = () => fontArgs('body');

/**
 * `label:` and `caption:` expand ImageMagick's escapes (`%`, backslash) and
 * read a file when the text starts with @, leading whitespace skipped, so
 * story names and arg values (a storybook's own text) go through none of it.
 */
export const literal = (text) =>
	String(text)
		.replaceAll('\\', '\\\\')
		.replaceAll('%', '%%')
		.replace(/^(\s*)@/, '$1\\@');

/** The gutter is the opposite of the theme, so the band keeps an edge. */
export const palette = (theme) =>
	theme === 'light'
		? { background: '#101014', foreground: '#f4f4f5' }
		: { background: '#f4f4f5', foreground: '#101014' };

export const settingsLine = (config, keys = CONFIG_KEYS) =>
	keys
		.filter((key) => config?.[key])
		.map((key) => `${key}:${config[key]}`)
		.join('  ');

/**
 * Writes `from` to `to` with `lines` above it, and returns how many rows that
 * added — which is what a reader has to crop off to get the original back, so
 * the band must never change the width. Each line is a `caption:` at the
 * image's own width, wrapping instead of widening the canvas: a run whose
 * caption is longer must still produce a shot the next run's shot pairs with.
 * Type size follows the width, since a three-tile montage of 1680px shots is
 * over 5000px wide and is read at fit-to-width.
 */
export const stamp = async ({ lines, from, to, theme }) => {
	const { background, foreground } = palette(theme);
	const [width, before] = (await magickAsync(['identify', '-format', '%w %h', from]))
		.toString()
		.split(' ')
		.map(Number);
	const heading = pointsize(width);
	const spacer = ['-size', `${width}x${Math.round(heading * 0.4)}`, `xc:${background}`];

	const after = await magickAsync([
		'-background',
		background,
		'-fill',
		foreground,
		'-gravity',
		'center',
		...spacer,
		...lines.flatMap((line, index) => [
			...fontArgs(index ? 'body' : 'heading'),
			'-size',
			`${width}x`,
			'-pointsize',
			String(index ? Math.round(heading * 0.62) : heading),
			`caption:${literal(line)}`,
		]),
		...spacer,
		from,
		'-append',
		// 8-bit, as the shot was, and no timestamp chunks, so the same caption on
		// the same pixels writes the same bytes.
		'-define',
		'png:exclude-chunks=date,time',
		'-write',
		`PNG32:${to}`,
		'-format',
		'%h',
		'info:',
	]);

	return Number(after) - before;
};

/**
 * One image of every crop, each over its label, two to a row. `montage
 * -label` sizes every tile to the widest image, so a long label runs under
 * the next one: each crop is composed with its label first, and the sheet is
 * a montage of finished tiles.
 */
export const contactSheet = ({ crops, sheet, theme }) => {
	const { background, foreground } = palette(theme);
	const sorted = [...crops].sort((a, b) =>
		a.file.localeCompare(b.file, undefined, { numeric: true }),
	);
	const tiles = sorted.map(({ file, label }, index) => {
		const tile = path.join(path.dirname(file), `.tile-${index}.png`);
		magick([
			'-background',
			background,
			'-fill',
			foreground,
			...bodyFont(),
			'-pointsize',
			'16',
			file,
			`label:${literal(label)}`,
			'-gravity',
			'center',
			'-append',
			tile,
		]);
		return tile;
	});
	try {
		magick([
			'montage',
			'-background',
			background,
			'-tile',
			'2x',
			'-geometry',
			'+16+16',
			...tiles,
			sheet,
		]);
	} finally {
		tiles.forEach((tile) => rmSync(tile, { force: true }));
	}
};
