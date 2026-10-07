import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffPair, maxDeltaFor } from '../src/pixels.mjs';

const image = (width, height, fill = [255, 255, 255, 255]) => {
	const data = Buffer.alloc(width * height * 4);
	for (let pos = 0; pos < data.length; pos += 4) {
		data.set(fill, pos);
	}
	return { width, height, data };
};

const paint = (img, x, y, rgba) => img.data.set(rgba, (y * img.width + x) * 4);

const options = {
	mode: 'green',
	maxDelta: maxDeltaFor(0.063),
	includeAA: false,
	highlight: [0, 224, 90],
};

test('identical images have no change', () => {
	assert.equal(diffPair(image(20, 20), image(20, 20), options).changed, 0);
});

test('a block that changes colour is counted and boxed', () => {
	const base = image(20, 20);
	const after = image(20, 20);
	for (let y = 5; y < 8; y += 1) {
		for (let x = 10; x < 14; x += 1) {
			paint(after, x, y, [0, 0, 0, 255]);
		}
	}
	const diff = diffPair(base, after, options);
	// The block's own corners read as antialiasing, as pixelmatch reads them.
	assert.ok(diff.changed >= 8 && diff.changed <= 12);
	assert.ok(diff.box.x >= 10 && diff.box.x + diff.box.width <= 14);
	assert.ok(diff.box.y >= 5 && diff.box.y + diff.box.height <= 8);
	assert.deepEqual([...diff.data.subarray((6 * 20 + 11) * 4, (6 * 20 + 11) * 4 + 3)], [0, 224, 90]);
});

test('a small shift in colour stays under the threshold', () => {
	const after = image(10, 10);
	paint(after, 5, 5, [250, 250, 250, 255]);
	assert.equal(diffPair(image(10, 10), after, options).changed, 0);
});

test('rows only one image has count as changed, and the box covers them', () => {
	const diff = diffPair(image(10, 10), image(10, 14), options);
	assert.equal(diff.changed, 40);
	assert.deepEqual(diff.box, { x: 0, y: 10, width: 10, height: 4 });
});

/** Pixels that differ from every neighbour, the same on every run. */
const noise = (width, height) => {
	const img = image(width, height);
	let seed = 7;
	for (let pos = 0; pos < img.data.length; pos += 4) {
		for (let channel = 0; channel < 3; channel += 1) {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			img.data[pos + channel] = seed >> 23;
		}
	}
	return img;
};

/** White above row 60, a grey line on it, black below: an edge in the antialiasing sense. */
const edge = (width, height) => {
	const img = image(width, height);
	for (let y = 60; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			paint(img, x, y, y === 60 ? [128, 128, 128, 255] : [0, 0, 0, 255]);
		}
	}
	return img;
};

test('a wider baseline does not hide changes in the part both shots share', () => {
	const after = noise(100, 100);
	const same = diffPair(edge(100, 100), after, options).changed;
	assert.equal(diffPair(edge(200, 100), after, options).changed, same + 100 * 100);
});

test('shots that grew and shrank count each extra pixel once', () => {
	const diff = diffPair(image(100, 10), image(10, 100), options);
	assert.equal(diff.changed, 900);
});
