/**
 * An animated GIF from RGBA frames of one size, looping forever. The frames
 * share one palette, so a pixel that does not change between frames keeps its
 * colour: a per-frame palette would make identical regions flicker.
 */

const key = (r, g, b) => (r << 16) | (g << 8) | b;
const bin = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/** Up to 256 colours for the frames, and the index of every pixel. */
const quantize = (frames) => {
	const exact = new Map();
	for (const data of frames) {
		for (let i = 0; i < data.length && exact.size <= 256; i += 4) {
			const color = key(data[i], data[i + 1], data[i + 2]);
			if (!exact.has(color)) exact.set(color, exact.size);
		}
	}
	if (exact.size <= 256) {
		const palette = [...exact.keys()].map((color) => [
			color >> 16,
			(color >> 8) & 255,
			color & 255,
		]);
		const indices = frames.map((data) => {
			const out = new Uint8Array(data.length / 4);
			for (let i = 0; i < out.length; i += 1) {
				out[i] = exact.get(key(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]));
			}
			return out;
		});
		return { palette, indices };
	}

	// Median cut over 15-bit bins, each bin standing for the mean of its pixels.
	// A box is split where its colours spread the most, so a small accent
	// colour keeps its own entry beside a large background.
	const count = new Uint32Array(32768);
	const sum = new Float64Array(32768 * 3);
	for (const data of frames) {
		for (let i = 0; i < data.length; i += 4) {
			const b = bin(data[i], data[i + 1], data[i + 2]);
			count[b] += 1;
			sum[b * 3] += data[i];
			sum[b * 3 + 1] += data[i + 1];
			sum[b * 3 + 2] += data[i + 2];
		}
	}
	const bins = [];
	for (let b = 0; b < 32768; b += 1) {
		if (count[b])
			bins.push({
				n: count[b],
				c: [sum[b * 3] / count[b], sum[b * 3 + 1] / count[b], sum[b * 3 + 2] / count[b]],
			});
	}
	const spread = (box) => {
		let best = { range: -1, channel: 0 };
		for (let channel = 0; channel < 3; channel += 1) {
			let low = 255;
			let high = 0;
			for (const item of box) {
				low = Math.min(low, item.c[channel]);
				high = Math.max(high, item.c[channel]);
			}
			if (high - low > best.range) best = { range: high - low, channel };
		}
		return best;
	};
	const boxes = [bins];
	while (boxes.length < 256) {
		let pick = -1;
		let widest = { range: 0 };
		boxes.forEach((box, index) => {
			if (box.length < 2) return;
			const found = spread(box);
			if (found.range > widest.range) {
				widest = found;
				pick = index;
			}
		});
		if (pick < 0) break;
		const box = boxes[pick].sort((a, b) => a.c[widest.channel] - b.c[widest.channel]);
		const total = box.reduce((acc, item) => acc + item.n, 0);
		let seen = 0;
		let cut = 1;
		while (cut < box.length - 1 && seen + box[cut - 1].n < total / 2) {
			seen += box[cut - 1].n;
			cut += 1;
		}
		boxes.splice(pick, 1, box.slice(0, cut), box.slice(cut));
	}
	const palette = boxes.map((box) => {
		const total = box.reduce((acc, item) => acc + item.n, 0);
		return [0, 1, 2].map((channel) =>
			Math.round(box.reduce((acc, item) => acc + item.c[channel] * item.n, 0) / total),
		);
	});
	const lookup = new Uint8Array(32768);
	for (let b = 0; b < 32768; b += 1) {
		if (!count[b]) continue;
		const [r, g, bl] = [
			sum[b * 3] / count[b],
			sum[b * 3 + 1] / count[b],
			sum[b * 3 + 2] / count[b],
		];
		let nearest = 0;
		let distance = Infinity;
		palette.forEach(([pr, pg, pb], index) => {
			const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - bl) ** 2;
			if (d < distance) {
				distance = d;
				nearest = index;
			}
		});
		lookup[b] = nearest;
	}
	const indices = frames.map((data) => {
		const out = new Uint8Array(data.length / 4);
		for (let i = 0; i < out.length; i += 1) {
			out[i] = lookup[bin(data[i * 4], data[i * 4 + 1], data[i * 4 + 2])];
		}
		return out;
	});
	return { palette, indices };
};

class Bytes {
	buffer = new Uint8Array(1 << 16);
	length = 0;
	push(...values) {
		for (const value of values) {
			if (this.length === this.buffer.length) {
				const grown = new Uint8Array(this.buffer.length * 2);
				grown.set(this.buffer);
				this.buffer = grown;
			}
			this.buffer[this.length++] = value;
		}
	}
	word(value) {
		this.push(value & 255, value >> 8);
	}
	text(value) {
		this.push(...[...value].map((char) => char.charCodeAt(0)));
	}
	bytes() {
		return this.buffer.subarray(0, this.length);
	}
}

/** The LZW stream of one frame, cut into the sub-blocks GIF wants. */
const lzw = (indices, minSize, out) => {
	const clear = 1 << minSize;
	const end = clear + 1;
	const data = new Bytes();
	let size = minSize + 1;
	let next = end + 1;
	let table = new Map();
	let bits = 0;
	let pending = 0;
	const emit = (code) => {
		pending |= code << bits;
		bits += size;
		while (bits >= 8) {
			data.push(pending & 255);
			pending >>= 8;
			bits -= 8;
		}
	};
	emit(clear);
	let prefix = indices[0];
	for (let i = 1; i < indices.length; i += 1) {
		const pixel = indices[i];
		const entry = (prefix << 8) | pixel;
		const code = table.get(entry);
		if (code !== undefined) {
			prefix = code;
			continue;
		}
		emit(prefix);
		if (next === 4096) {
			emit(clear);
			table = new Map();
			size = minSize + 1;
			next = end + 1;
		} else {
			if (next >= 1 << size) size += 1;
			table.set(entry, next++);
		}
		prefix = pixel;
	}
	emit(prefix);
	emit(end);
	if (bits > 0) data.push(pending & 255);

	out.push(minSize);
	const stream = data.bytes();
	for (let start = 0; start < stream.length; start += 255) {
		const block = stream.subarray(start, start + 255);
		out.push(block.length, ...block);
	}
	out.push(0);
};

/** `frames` are RGBA pixel arrays of `width` x `height`, each shown for `delay` ms. */
export const encodeGif = (frames, width, height, delay) => {
	const { palette, indices } = quantize(frames);
	const depth = Math.max(1, Math.ceil(Math.log2(palette.length)));
	const out = new Bytes();
	out.text('GIF89a');
	out.word(width);
	out.word(height);
	out.push(0xf0 | (depth - 1), 0, 0);
	for (let index = 0; index < 1 << depth; index += 1) {
		out.push(...(palette[index] ?? [0, 0, 0]));
	}
	// Loop forever.
	out.push(0x21, 0xff, 11);
	out.text('NETSCAPE2.0');
	out.push(3, 1, 0, 0, 0);
	for (const frame of indices) {
		out.push(0x21, 0xf9, 4, 0x04);
		out.word(Math.round(delay / 10));
		out.push(0, 0);
		out.push(0x2c);
		out.word(0);
		out.word(0);
		out.word(width);
		out.word(height);
		out.push(0);
		lzw(frame, Math.max(2, depth), out);
	}
	out.push(0x3b);
	return new Blob([out.bytes()], { type: 'image/gif' });
};
