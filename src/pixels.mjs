/**
 * The comparison itself, Chromatic's: a pixel counts as changed when its YIQ
 * distance from the baseline pixel is over `threshold` of the largest distance
 * two colours can have, and pixels that are only antialiasing around an
 * otherwise identical edge do not count. `threshold` is their `diffThreshold`
 * and its default is theirs too. This is pixelmatch's maths, inlined so a pair
 * can skip its identical rows with a memcmp.
 */
export const MAX_YIQ_DELTA = 35_215;

export const maxDeltaFor = (threshold) => MAX_YIQ_DELTA * threshold * threshold;

export const hexToRgb = (hex) => {
	const value = Number.parseInt(hex.replace('#', ''), 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/* The pixelmatch colour maths, which is what Chromatic's threshold is scaled to. */
export const y = (r, g, b) => r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
const i = (r, g, b) => r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
const q = (r, g, b) => r * 0.21147017 - g * 0.52261711 + b * 0.31114694;

/** Squared YIQ distance, signed by which pixel is brighter. */
export const colorDelta = (a, b, posA, posB, yOnly = false) => {
	let r1 = a[posA];
	let g1 = a[posA + 1];
	let b1 = a[posA + 2];
	const a1 = a[posA + 3];
	let r2 = b[posB];
	let g2 = b[posB + 1];
	let b2 = b[posB + 2];
	const a2 = b[posB + 3];

	if (a1 === a2 && r1 === r2 && g1 === g2 && b1 === b2) {
		return 0;
	}

	// Anything translucent is composited over the same mid grey in both images,
	// so a difference in alpha alone still registers.
	if (a1 < 255) {
		const alpha = a1 / 255;
		r1 = r1 * alpha + 255 * (1 - alpha) * 0.5;
		g1 = g1 * alpha + 255 * (1 - alpha) * 0.5;
		b1 = b1 * alpha + 255 * (1 - alpha) * 0.5;
	}
	if (a2 < 255) {
		const alpha = a2 / 255;
		r2 = r2 * alpha + 255 * (1 - alpha) * 0.5;
		g2 = g2 * alpha + 255 * (1 - alpha) * 0.5;
		b2 = b2 * alpha + 255 * (1 - alpha) * 0.5;
	}

	const deltaY = y(r1, g1, b1) - y(r2, g2, b2);
	if (yOnly) {
		return deltaY;
	}

	const deltaI = i(r1, g1, b1) - i(r2, g2, b2);
	const deltaQ = q(r1, g1, b1) - q(r2, g2, b2);
	return 0.5053 * deltaY * deltaY + 0.299 * deltaI * deltaI + 0.1957 * deltaQ * deltaQ;
};

/**
 * True when the pixel sits on an edge that is drawn one subpixel over rather
 * than moved: it is the darkest or lightest of its neighbours in one image, and
 * the other image has a pixel around there doing the same job. The two may
 * differ in size, so each is read with its own.
 */
const antialiased = (a, x1, y1, width, height, b, bWidth, bHeight) => {
	const x0 = Math.max(x1 - 1, 0);
	const y0 = Math.max(y1 - 1, 0);
	const x2 = Math.min(x1 + 1, width - 1);
	const y2 = Math.min(y1 + 1, height - 1);
	const pos = (y1 * width + x1) * 4;
	let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
	let min = 0;
	let max = 0;
	let minX = 0;
	let minY = 0;
	let maxX = 0;
	let maxY = 0;

	for (let x = x0; x <= x2; x += 1) {
		for (let yy = y0; yy <= y2; yy += 1) {
			if (x === x1 && yy === y1) {
				continue;
			}

			const delta = colorDelta(a, a, pos, (yy * width + x) * 4, true);
			if (delta === 0) {
				zeroes += 1;
				if (zeroes > 2) {
					return false;
				}
			} else if (delta < min) {
				min = delta;
				minX = x;
				minY = yy;
			} else if (delta > max) {
				max = delta;
				maxX = x;
				maxY = yy;
			}
		}
	}

	if (min === 0 || max === 0) {
		return false;
	}

	return (
		(hasManySiblings(a, minX, minY, width, height) &&
			hasManySiblings(b, minX, minY, bWidth, bHeight)) ||
		(hasManySiblings(a, maxX, maxY, width, height) &&
			hasManySiblings(b, maxX, maxY, bWidth, bHeight))
	);
};

/** Whether the pixel has at least three identical neighbours; never for one outside the image. */
const hasManySiblings = (img, x1, y1, width, height) => {
	if (x1 >= width || y1 >= height) {
		return false;
	}
	const x0 = Math.max(x1 - 1, 0);
	const y0 = Math.max(y1 - 1, 0);
	const x2 = Math.min(x1 + 1, width - 1);
	const y2 = Math.min(y1 + 1, height - 1);
	const pos = (y1 * width + x1) * 4;
	let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;

	for (let x = x0; x <= x2; x += 1) {
		for (let yy = y0; yy <= y2; yy += 1) {
			if (x === x1 && yy === y1) {
				continue;
			}

			const other = (yy * width + x) * 4;
			if (
				img[pos] === img[other] &&
				img[pos + 1] === img[other + 1] &&
				img[pos + 2] === img[other + 2] &&
				img[pos + 3] === img[other + 3]
			) {
				zeroes += 1;
				if (zeroes > 2) {
					return true;
				}
			}
		}
	}

	return false;
};

/**
 * The changed pixels of the pair, painted over the after shot. The `red` modes
 * fade the shot out first, the way a pixelmatch diff reads; the `green` ones
 * leave it alone, the way Chromatic's does.
 */
export const diffPair = (base, after, { mode, maxDelta, includeAA, highlight }) => {
	const width = Math.min(base.width, after.width);
	const height = Math.min(base.height, after.height);
	const rowBytes = width * 4;
	const changedAt = [];
	// Where the changes are, so a viewer can jump to them on a tall page.
	const box = { left: Infinity, top: Infinity, right: -1, bottom: -1 };

	for (let row = 0; row < height; row += 1) {
		const baseRow = row * base.width * 4;
		const afterRow = row * after.width * 4;
		// Most rows of a pair are untouched, and a memcmp says so at once.
		if (
			base.data
				.subarray(baseRow, baseRow + rowBytes)
				.equals(after.data.subarray(afterRow, afterRow + rowBytes))
		) {
			continue;
		}

		for (let column = 0; column < width; column += 1) {
			const basePos = baseRow + column * 4;
			const afterPos = afterRow + column * 4;
			const delta = colorDelta(base.data, after.data, basePos, afterPos);
			if (Math.abs(delta) <= maxDelta) {
				continue;
			}
			if (
				!includeAA &&
				(antialiased(
					base.data,
					column,
					row,
					base.width,
					base.height,
					after.data,
					after.width,
					after.height,
				) ||
					antialiased(
						after.data,
						column,
						row,
						after.width,
						after.height,
						base.data,
						base.width,
						base.height,
					))
			) {
				continue;
			}

			changedAt.push(afterPos);
			box.left = Math.min(box.left, column);
			box.right = Math.max(box.right, column);
			box.top = Math.min(box.top, row);
			box.bottom = Math.max(box.bottom, row);
		}
	}

	// A shot that grew or shrank has no counterpart for the extra rows and
	// columns, so all of them are a change: counted over the larger shot, which
	// is what the ratio divides by.
	const extra = Math.max(base.width * base.height, after.width * after.height) - width * height;

	const changed = changedAt.length + extra;
	if (!changed) {
		return { changed };
	}
	if (extra) {
		box.left = Math.min(box.left, base.width === after.width ? 0 : width);
		box.top = Math.min(box.top, base.height === after.height ? 0 : height);
		box.right = Math.max(box.right, Math.max(base.width, after.width) - 1);
		box.bottom = Math.max(box.bottom, Math.max(base.height, after.height) - 1);
	}

	const out = Buffer.from(after.data);
	if (!mode.startsWith('green')) {
		for (let pos = 0; pos < out.length; pos += 4) {
			const grey = y(out[pos], out[pos + 1], out[pos + 2]);
			const value = 255 + (grey - 255) * 0.1;
			out[pos] = value;
			out[pos + 1] = value;
			out[pos + 2] = value;
			out[pos + 3] = 255;
		}
	}
	for (const pos of changedAt) {
		out[pos] = highlight[0];
		out[pos + 1] = highlight[1];
		out[pos + 2] = highlight[2];
		out[pos + 3] = 255;
	}

	return {
		data: out,
		width: after.width,
		height: after.height,
		changed,
		box: {
			x: box.left,
			y: box.top,
			width: box.right - box.left + 1,
			height: box.bottom - box.top + 1,
		},
	};
};
