/**
 * The diff page's current view drawn at the shots' own resolution: a PNG for
 * the still views, a GIF for blink. What is drawn follows the page's CSS
 * (`.side`, `.stack`, `.changebox`), not its size on screen.
 */
import { encodeGif } from './gif.js';

const GAP = 8;
const LABEL = 24;
const BLINK = 600;

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** A shot without its caption band, or null when the pair has no such shot. */
const load = async (source) => {
	if (!source) return null;
	const image = new Image();
	image.src = source.src;
	await image.decode();
	return {
		image,
		top: source.top,
		width: image.naturalWidth,
		height: Math.max(image.naturalHeight - source.top, 1),
	};
};

const canvasOf = (width, height) => {
	const canvas = document.createElement('canvas');
	canvas.width = Math.round(width);
	canvas.height = Math.round(height);
	const context = canvas.getContext('2d');
	context.fillStyle = css('--bg');
	context.fillRect(0, 0, canvas.width, canvas.height);
	return { canvas, context };
};

/** A shot scaled to `width`, or the placeholder text where it is missing. */
const drawShot = (context, shot, x, y, width, height, missing) => {
	if (shot) {
		const scaled = (shot.height * width) / shot.width;
		context.drawImage(shot.image, 0, shot.top, shot.width, shot.height, x, y, width, scaled);
		return;
	}
	context.fillStyle = css('--panel');
	context.fillRect(x, y, width, height);
	context.fillStyle = css('--muted');
	context.font = '14px system-ui, sans-serif';
	context.textAlign = 'center';
	context.fillText(missing, x + width / 2, y + Math.min(height / 2, 150));
	context.textAlign = 'left';
};

const drawLabel = (context, text, x, y, width) => {
	context.fillStyle = css('--panel');
	context.fillRect(x, y, width, LABEL);
	context.fillStyle = css('--muted');
	context.font = '12px system-ui, sans-serif';
	context.textBaseline = 'middle';
	context.fillText(text, x + 6, y + LABEL / 2);
	context.textBaseline = 'alphabetic';
};

/** The change box over a tile of `width` x `height` showing the pair. */
const drawBox = (context, pair, x, y, width, height) => {
	if (!pair.box || !pair.width || !pair.height) return;
	const scale = width / pair.width;
	const box = {
		x: x + pair.box.x * scale,
		y: y + pair.box.y * scale,
		width: Math.max(pair.box.width * scale, width * 0.003),
		height: Math.max(pair.box.height * scale, height * 0.003),
	};
	context.save();
	context.beginPath();
	context.rect(x, y, width, height);
	context.rect(box.x, box.y, box.width, box.height);
	context.fillStyle = 'rgba(0, 0, 0, 0.18)';
	context.fill('evenodd');
	context.setLineDash([6, 4]);
	context.lineWidth = 2;
	context.strokeStyle = '#ff2d55';
	context.strokeRect(box.x, box.y, box.width, box.height);
	context.restore();
};

const png = (canvas) =>
	new Promise((resolve, reject) =>
		canvas.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new Error('the view is too large to draw'))),
			'image/png',
		),
	);

/**
 * `sources` holds `{ src, top }` for `base`, `after` and `diff`, null for a
 * missing one; `view` is the page's mode, box toggle, swipe split and onion
 * opacity. Resolves to `{ blob, type }`.
 */
export const snapshot = async (pair, sources, view) => {
	const [base, after, diff] = await Promise.all([
		load(sources.base),
		load(sources.after),
		load(sources.diff),
	]);
	const box = (context, x, y, width, height) =>
		view.box && drawBox(context, pair, x, y, width, height);

	if (view.mode === 'diff') {
		const shot = diff ?? after ?? base;
		const width = shot?.width ?? pair.width ?? 800;
		const height = shot ? (shot.height * width) / shot.width : 300;
		const { canvas, context } = canvasOf(width, height);
		drawShot(context, diff, 0, 0, width, height, 'no diff image: the pair is identical');
		box(context, 0, 0, width, height);
		return { blob: await png(canvas), type: 'png' };
	}

	if (view.mode === 'side' || view.mode === 'side3') {
		const tiles = [
			['baseline', base, 'missing in baseline'],
			['after', after, 'missing in after'],
			...(view.mode === 'side3' ? [['diff', diff, 'no diff image: the pair is identical']] : []),
		];
		const column = Math.max(...tiles.map(([, shot]) => shot?.width ?? 0)) || pair.width || 800;
		const tall = Math.max(
			300,
			...tiles.map(([, shot]) => (shot ? (shot.height * column) / shot.width : 0)),
		);
		const { canvas, context } = canvasOf(
			tiles.length * column + (tiles.length - 1) * GAP,
			LABEL + tall,
		);
		tiles.forEach(([label, shot, missing], index) => {
			const x = index * (column + GAP);
			const height = shot ? (shot.height * column) / shot.width : 300;
			drawLabel(context, label, x, 0, column);
			drawShot(context, shot, x, LABEL, column, height, missing);
			box(context, x, LABEL, column, height);
		});
		return { blob: await png(canvas), type: 'png' };
	}

	// The stacked views: the after shot sets the size, the baseline is drawn
	// over it at the same width and cut to it.
	const width = after?.width ?? base?.width ?? pair.width ?? 800;
	const height = after ? after.height : base ? (base.height * width) / base.width : 300;
	const stack = (context, y, { baseline = true, alpha = 1, split = 100 } = {}) => {
		drawShot(context, after, 0, y, width, height, 'missing in after');
		if (baseline && base) {
			context.save();
			context.beginPath();
			context.rect(0, y, (width * split) / 100, height);
			context.clip();
			context.globalAlpha = alpha;
			drawShot(context, base, 0, y, width, height);
			context.restore();
		}
		box(context, 0, y, width, height);
	};

	if (view.mode === 'blink') {
		const frames = [true, false].map((baseline) => {
			const { context } = canvasOf(width, LABEL + height);
			drawLabel(context, baseline ? 'baseline' : 'after', 0, 0, width);
			stack(context, LABEL, { baseline });
			return context.getImageData(0, 0, context.canvas.width, context.canvas.height).data;
		});
		return {
			blob: encodeGif(frames, Math.round(width), Math.round(LABEL + height), BLINK),
			type: 'gif',
		};
	}

	const { canvas, context } = canvasOf(width, height);
	if (view.mode === 'swipe') {
		stack(context, 0, { split: view.split });
		context.fillStyle = css('--accent');
		context.fillRect((width * view.split) / 100 - 1, 0, 2, height);
	} else {
		stack(context, 0, { alpha: view.opacity / 100 });
	}
	return { blob: await png(canvas), type: 'png' };
};
