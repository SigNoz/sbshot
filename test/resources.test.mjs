import assert from 'node:assert/strict';
import { test } from 'node:test';

import { vmStatAvailable } from '../src/resources.mjs';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     5382.
Pages active:                                 445029.
Pages inactive:                               438943.
Pages speculative:                              4552.
Pages throttled:                                   0.
Pages wired down:                             290283.
Pages purgeable:                               13176.
`;

test('vmStatAvailable counts the pages macOS reclaims on demand', () => {
	assert.equal(vmStatAvailable(VM_STAT), (5382 + 438943 + 4552 + 13176) * 16384);
});

test('vmStatAvailable reads 4 KiB pages when the header is missing', () => {
	assert.equal(vmStatAvailable('Pages free: 10.\nPages inactive: 5.\n'), 15 * 4096);
});
