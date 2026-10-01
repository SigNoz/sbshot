# Making a Storybook shoot well

sbshot works on any Storybook 7 or newer without changes. A preview that
cooperates gets shots that are identical from one run to the next, which is
what makes a diff worth reading. This page lists what sbshot passes to the
preview and what the preview can do with it.

## What each story is opened with

Each story loads in a fresh page at

```
<storybook>/iframe.html?viewMode=story&id=<story-id>
  &storyClock=<iso date or live>
  &globals=theme:<theme>;motion:live;<--globals>
  &args=<--args>
```

`theme` is only there when `--theme` is given, `motion:live` only with
`--motion`. The browser context also asks for reduced motion unless
`--motion` is set, and videos are paused on their first frame.

Storage (cookies, IndexedDB, local storage, cache storage) is cleared
between stories. The browser context is kept, so the Storybook bundle stays
in its cache.

## Themes

`--theme dark,light` shoots every story once per theme and sets the
Storybook global `theme` to each value. A decorator that reads it is enough:

```js
// .storybook/preview.jsx
export const decorators = [
	(Story, { globals }) => (
		<ThemeProvider theme={globals.theme ?? 'dark'}>
			<Story />
		</ThemeProvider>
	),
];
```

The caption band of a shot is drawn in the colours opposite its theme, so
it keeps an edge against the page. A run without `--theme` is captioned as
dark.

## A frozen clock

Relative dates ("3 minutes ago"), charts over "the last hour" and anything
else built on the current time change between runs. sbshot passes a fixed
instant, `2026-06-15T12:00:00.000Z` unless `--clock` says otherwise, as the
`storyClock` query parameter. `--clock live` passes `live`.

The preview decides what to do with it. A version that freezes the date the
app renders from and keeps elapsed time working, in
`.storybook/preview-head.html`:

```html
<script>
	(() => {
		const asked = new URLSearchParams(location.search).get('storyClock');
		if (asked === 'live') return;
		const frozen = Date.parse(asked || '2026-06-15T12:00:00.000Z');
		if (Number.isNaN(frozen)) return;
		const RealDate = Date;
		const started = performance.now();
		class FrozenDate extends RealDate {
			constructor(...args) {
				super(...(args.length ? args : [frozen]));
			}
			static now() {
				return frozen + (performance.now() - started);
			}
		}
		Object.defineProperty(window, 'Date', { value: FrozenDate, writable: true });
	})();
</script>
```

`new Date()` always returns the frozen instant. `Date.now()` starts there and
keeps running, because code also uses it to measure elapsed time. A frozen
`Date.now()` breaks `lodash.debounce`, for example: it compares two readings
to decide the trailing call is due, sees no time pass, and never calls it.

The cost is that `Date.now()` has moved on by however long the page took to
load. Build mock timestamps from `new Date().getTime()` instead, or two shots
of the same story disagree on every one of them:

```js
// .storybook/storyNow.js
export const storyNow = () => new Date().getTime();

// in a story's mocks
const lastSeen = storyNow() - 3 * 60_000; // always "3 minutes ago"
```

## Holding animations still

The reduced-motion request only stops what the app turns off under
`prefers-reduced-motion`. An infinite CSS spinner or a transition the app
does not guard keeps moving, and the story ends up `busy` or differs between
runs. sbshot sets the global `motion` to `live` only with `--motion`, so a
preview can default it to `still` and park every animation on its last frame:

```js
// .storybook/preview.jsx
export default {
	initialGlobals: { motion: 'still' },
	afterEach: ({ globals }) => {
		document.documentElement.classList.toggle(
			'sb-still',
			globals.motion !== 'live',
		);
	},
};
```

```css
/* loaded by the preview */
html.sb-still *,
html.sb-still *::before,
html.sb-still *::after {
	animation-duration: 0s !important;
	animation-delay: 0s !important;
	animation-iteration-count: 1 !important;
	animation-fill-mode: forwards !important;
	animation-play-state: paused !important;
	transition-duration: 0s !important;
	transition-delay: 0s !important;
	caret-color: transparent !important;
}
```

`afterEach` runs after `play`, before sbshot looks for stable frames, so a
`play` function that clicks through a transition still sees it happen.

## Hiding what cannot hold still

Elements marked `data-shot-ignore` or `data-chromatic="ignore"`, and those
matching `--ignore <selector>`, are hidden (`visibility: hidden`) before the
shot. They keep their space, so the layout around them does not move.

## When a story is ready

sbshot waits, in order, for:

1. Storybook's own render phase to reach `finished` (after loaders,
   decorators and `play`). A story that errors is retried once, then
   reported failed.
2. No network request for 600 ms, and no visible `[aria-busy="true"]`
   element, for up to 15 seconds. A panel that shows a spinner before it
   sends its query is caught by the second check, so mark loading states
   with `aria-busy`.
3. Web fonts, two animation frames, then `--settle` milliseconds.
4. `window.__sbshotSettle()`, when the preview defines it (see below).
5. Two identical frames in a row, up to eight tries 400 ms apart. A story
   that never gets there is shot anyway and marked `busy`.

Steps 2 and 3 run again after every viewport resize, since a taller viewport
can bring panels into view that fetch only then.

## A settle hook

Some state only the preview can see, such as a virtualised list still
measuring its rows. Define a function that settles it; sbshot calls it
before looking for stable frames and waits for the promise it returns:

```js
window.__sbshotSettle = async () => {
	await virtualList.remeasure();
};
```

## Pinning a story's viewport

By default the viewport grows to fit the tallest inner scroller. A page
that sizes itself in `vh` grows with the viewport, so no height fits it:
sbshot notices, shoots it at `--height`, and notes `stopped chasing`. Such a
story does better with a fixed viewport:

```js
export const Dashboard = {
	parameters: { sbshot: { viewport: { height: 1725 } } },
};
```

`width` may be given too. `parameters.storyShots.viewport`, the name the
story-shots scripts used, is read as well.

## Builds for `--changed-since`

`--changed-since <ref>` needs the module graph of a build made with
`storybook build --stats-json`. Builds sbshot makes from a project always
have it. For a build made elsewhere, add the flag.

## Mock service workers

msw registers its worker once per page, and registering twice in one page
races. sbshot opens a fresh page per story for that reason, and serves
builds with the JavaScript content type the worker needs.
