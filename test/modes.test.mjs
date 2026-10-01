import assert from 'node:assert/strict';
import { test } from 'node:test';

import { format, summarize } from '../src/commands/modes.mjs';

test('modes lists toolbar globals with their defaults and the chromatic modes', () => {
	const result = summarize({
		globalTypes: {
			theme: { toolbar: { items: [{ value: 'dark', title: 'Dark' }, 'light'] } },
			locale: { description: 'Language. Picks the strings.', toolbar: { items: ['en', 'pt'] } },
		},
		initialGlobals: { theme: 'dark', locale: 'en', outline: false },
		parameters: {
			chromatic: { modes: { light: { theme: 'light', viewport: { width: 1280 } } } },
		},
	});
	assert.deepEqual(
		result.globals.map((g) => [g.name, g.values, g.initial]),
		[
			['theme', ['dark', 'light'], 'dark'],
			['locale', ['en', 'pt'], 'en'],
		],
	);
	assert.deepEqual(result.modes, [
		{ name: 'light', globals: { theme: 'light' }, viewport: { width: 1280 } },
	]);
	const text = format({ ...result, clock: false, settleHook: false });
	assert.match(text, /theme\s+dark\* light\s+--theme/);
	assert.match(text, /locale\s+en\* pt\s+--globals\s+Language\.$/m);
	assert.match(text, /light\s+theme:light 1280$/m);
	assert.match(text, /nothing reads \?storyClock/);
});

test('a theme set only by initialGlobals still shows, and no globals says so', () => {
	const { globals } = summarize({ initialGlobals: { theme: 'light' } });
	assert.deepEqual(
		globals.map((g) => [g.name, g.values, g.initial]),
		[['theme', [], 'light']],
	);
	assert.match(
		format({ ...summarize({}), clock: true, settleHook: true }),
		/globals: none declared/,
	);
});
