import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { test } from 'node:test';

import { decodePng, sameImage, sizeOf } from '../src/png.mjs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const chunk = (type, data = Buffer.alloc(0)) => {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
};

const header = (width, height, colorType = 6) => {
	const data = Buffer.alloc(13);
	data.writeUInt32BE(width, 0);
	data.writeUInt32BE(height, 4);
	data[8] = 8;
	data[9] = colorType;
	return chunk('IHDR', data);
};

/** An 8-bit PNG of `rows`, each a filter byte of 0 and its samples. */
const png = (width, height, rows, { colorType = 6, extra = [] } = {}) =>
	Buffer.concat([
		SIGNATURE,
		header(width, height, colorType),
		...extra,
		chunk('IDAT', deflateSync(Buffer.concat(rows.map((row) => Buffer.from([0, ...row]))))),
		chunk('IEND'),
	]);

test('a plain RGBA PNG decodes', () => {
	const image = decodePng(png(2, 1, [[255, 0, 0, 255, 0, 0, 255, 128]]));
	assert.deepEqual([...image.data], [255, 0, 0, 255, 0, 0, 255, 128]);
});

test('a damaged or oversized PNG is left to ImageMagick instead of throwing', () => {
	const good = png(2, 1, [[1, 2, 3, 4, 5, 6, 7, 8]]);
	// Cut inside the IDAT chunk.
	assert.equal(decodePng(good.subarray(0, good.length - 20)), null);
	// A palette image with no palette.
	assert.equal(decodePng(png(1, 1, [[0]], { colorType: 3 })), null);
	// Pixel data that is not zlib.
	const garbage = Buffer.concat([
		SIGNATURE,
		header(1, 1),
		chunk('IDAT', Buffer.from('nope')),
		chunk('IEND'),
	]);
	assert.equal(decodePng(garbage), null);
	// Fewer rows than the header says.
	assert.equal(decodePng(png(1, 2, [[1, 2, 3, 4]])), null);
	// A header that asks for more memory than any shot needs.
	assert.equal(decodePng(png(65535, 65535, [[0, 0, 0, 0]])), null);
});

test('a PNG cut inside its header has no size and is never the same image', () => {
	const cut = png(2, 1, [[1, 2, 3, 4, 5, 6, 7, 8]]).subarray(0, 20);
	assert.equal(sizeOf(cut), null);
	assert.equal(sameImage(cut, cut), false);
});
