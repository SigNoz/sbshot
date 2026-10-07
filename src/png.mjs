import { closeSync, openSync, readSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import path from 'node:path';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Samples per pixel of each colour type. */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * The most pixels this decodes itself, 1 GiB of RGBA. A header past it is a
 * broken or hostile file, which ImageMagick reads under its own limits.
 */
const MAX_PIXELS = 2 ** 28;

/** The chunks of a PNG, or `null` when it is not one or a chunk runs past the end. */
const chunks = (buffer) => {
	if (!buffer.subarray(0, 8).equals(SIGNATURE)) {
		return null;
	}

	const found = { IDAT: [] };
	for (let offset = 8; offset + 8 <= buffer.length;) {
		const length = buffer.readUInt32BE(offset);
		if (offset + 12 + length > buffer.length) {
			return null;
		}
		const type = buffer.toString('latin1', offset + 4, offset + 8);
		const data = buffer.subarray(offset + 8, offset + 8 + length);
		if (type === 'IDAT') {
			found.IDAT.push(data);
		} else {
			found[type] ??= data;
		}
		if (type === 'IEND') {
			break;
		}
		offset += 12 + length;
	}
	return found.IHDR?.length === 13 ? found : null;
};

/**
 * Whether two PNGs hold the same image, read off the header and the compressed
 * pixel data alone. Ancillary chunks such as a timestamp are ignored, and two
 * encoders that compress the same pixels differently simply answer false.
 */
export const sameImage = (a, b) => {
	const [left, right] = [chunks(a), chunks(b)];
	return (
		!!left?.IHDR &&
		!!right?.IHDR &&
		left.IHDR.equals(right.IHDR) &&
		Buffer.concat(left.IDAT).equals(Buffer.concat(right.IDAT))
	);
};

/** Width and height from a PNG's header, or `null` when it is not a PNG. */
export const sizeOf = (buffer) => {
	const header = chunks(buffer)?.IHDR;
	return header ? { width: header.readUInt32BE(0), height: header.readUInt32BE(4) } : null;
};

/**
 * The pixels of a PNG as 8-bit RGBA, or `null` for a PNG this does not read
 * (sub-byte, interlaced, damaged, huge), which the caller hands to
 * ImageMagick. A 16-bit sample is scaled the way ImageMagick's `-depth 8`
 * does.
 */
export const decodePng = (buffer) => {
	const found = chunks(buffer);
	const header = found?.IHDR;
	if (!header) {
		return null;
	}

	const width = header.readUInt32BE(0);
	const height = header.readUInt32BE(4);
	const [depth, colorType, , , interlace] = header.subarray(8);
	const channels = CHANNELS[colorType];
	// A tRNS on a grey or RGB image is a colour key, which this does not apply.
	if (
		(depth !== 8 && depth !== 16) ||
		!channels ||
		(depth === 16 && colorType === 3) ||
		(colorType === 3 && !found.PLTE) ||
		interlace !== 0 ||
		(found.tRNS && colorType !== 3) ||
		!width ||
		!height ||
		width * height > MAX_PIXELS
	) {
		return null;
	}

	const bytes = channels * (depth / 8);
	const stride = width * bytes;
	let raw;
	try {
		raw = inflateSync(Buffer.concat(found.IDAT), { maxOutputLength: (stride + 1) * height });
	} catch {
		return null;
	}
	if (raw.length !== (stride + 1) * height) {
		return null;
	}
	const unfiltered = Buffer.alloc(stride * height);

	for (let row = 0; row < height; row += 1) {
		const filter = raw[row * (stride + 1)];
		const source = row * (stride + 1) + 1;
		const target = row * stride;
		const above = target - stride;
		for (let column = 0; column < stride; column += 1) {
			const left = column >= bytes ? unfiltered[target + column - bytes] : 0;
			const up = row > 0 ? unfiltered[above + column] : 0;
			const corner = row > 0 && column >= bytes ? unfiltered[above + column - bytes] : 0;
			let value = raw[source + column];
			if (filter === 1) {
				value += left;
			} else if (filter === 2) {
				value += up;
			} else if (filter === 3) {
				value += (left + up) >> 1;
			} else if (filter === 4) {
				const estimate = left + up - corner;
				const toLeft = Math.abs(estimate - left);
				const toUp = Math.abs(estimate - up);
				const toCorner = Math.abs(estimate - corner);
				value += toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner;
			}
			unfiltered[target + column] = value;
		}
	}

	let pixels = unfiltered;
	if (depth === 16) {
		pixels = Buffer.alloc(unfiltered.length / 2);
		for (let index = 0; index < pixels.length; index += 1) {
			pixels[index] = Math.round(unfiltered.readUInt16BE(index * 2) / 257);
		}
	}

	if (colorType === 6) {
		return { width, height, data: pixels };
	}

	const data = Buffer.alloc(width * height * 4);
	const palette = found.PLTE;
	const alpha = found.tRNS;
	for (let pixel = 0; pixel < width * height; pixel += 1) {
		const from = pixel * channels;
		const to = pixel * 4;
		if (colorType === 3) {
			// An index past the palette reads as black rather than as nothing.
			const entry = pixels[from];
			data[to] = palette[entry * 3] ?? 0;
			data[to + 1] = palette[entry * 3 + 1] ?? 0;
			data[to + 2] = palette[entry * 3 + 2] ?? 0;
			data[to + 3] = alpha && entry < alpha.length ? alpha[entry] : 255;
		} else if (colorType === 2) {
			data[to] = pixels[from];
			data[to + 1] = pixels[from + 1];
			data[to + 2] = pixels[from + 2];
			data[to + 3] = 255;
		} else {
			data[to] = pixels[from];
			data[to + 1] = pixels[from];
			data[to + 2] = pixels[from];
			data[to + 3] = colorType === 4 ? pixels[from + 1] : 255;
		}
	}
	return { width, height, data };
};

/** Every PNG under `dir`, as paths relative to it. Dotfiles are scratch. */
export const listPngs = async (dir, prefix = '') => {
	const entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const rel = path.join(prefix, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listPngs(dir, rel)));
		} else if (entry.name.endsWith('.png') && !entry.name.startsWith('.')) {
			files.push(rel);
		}
	}
	return files;
};

/** Width and height from the IHDR chunk every PNG opens with, or zeros for a file that is no PNG. */
export const dimensionsOf = (file) => {
	const header = Buffer.alloc(24);
	const fd = openSync(file, 'r');
	try {
		return readSync(fd, header, 0, 24, 0) === 24 &&
			header.subarray(0, 8).equals(SIGNATURE) &&
			header.toString('latin1', 12, 16) === 'IHDR'
			? { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
			: { width: 0, height: 0 };
	} finally {
		closeSync(fd);
	}
};

/** Width times height. */
export const pixelsOf = (file) => {
	const { width, height } = dimensionsOf(file);
	return width * height;
};
