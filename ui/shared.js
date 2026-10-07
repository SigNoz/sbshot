/** What every view shares: the page's fixed elements, formatting, the API, and a job's live state. */
import { estimate, formatDuration, initialState, reduce } from './lib/progress.mjs';

export const view = document.getElementById('view');
export const crumbs = document.getElementById('crumbs');
export const lightbox = document.getElementById('lightbox');

export const esc = (value) =>
	String(value ?? '').replace(
		/[&<>"']/g,
		(char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
	);

/**
 * A page from `sbshot export`: no server, the API answers are JSON files
 * beside the page and the images sit under `files/`. Nothing can be changed.
 */
export const STATIC = document.documentElement.hasAttribute('data-static');

const staticUrl = (url) =>
	url === '/api/jobs'
		? 'api/jobs.json'
		: url.replace(/^\/api\/jobs\/(capture|diff)\/([^/]+)$/, 'api/$1/$2.json');

export const api = async (url, options) => {
	if (STATIC && options?.method) {
		throw new Error('this is a read-only export');
	}
	const response = await fetch(STATIC ? staticUrl(url) : url, options);
	if (!response.ok) {
		throw new Error(`${url}: ${response.status}`);
	}
	return response.json();
};

/**
 * Starts an export download. A viewer started before `export` existed still
 * serves these pages from disk but has no such route, and the browser would
 * save its bare 404 as a file: ask first, where a current server says 400.
 */
export const downloadExport = async (url) => {
	const probe = await fetch('/api/export.zip');
	if (probe.status === 404) {
		throw new Error('this viewer is older than export: restart it (sbshot ui)');
	}
	location.href = url;
};

// An export may hold its shots as WebP, but for the few too tall for it.
const site = STATIC ? await fetch('api/jobs.json').then((response) => response.json()) : null;
const keptPng = new Set(site?.png ?? []);
const sitePath = (dir, rel) => {
	let file = `${dir}/${rel}`;
	if (site?.images === 'webp' && file.endsWith('.png') && !keptPng.has(file)) {
		file = `${file.slice(0, -4)}.webp`;
	}
	return file.split('/').map(encodeURIComponent).join('/');
};
export const fileUrl = (dir, rel) =>
	STATIC ? sitePath(dir, rel) : `/file?p=${encodeURIComponent(`${dir}/${rel}`)}`;
export const thumbUrl = (dir, rel, top = 0, width = 360) =>
	STATIC
		? sitePath(dir, rel)
		: `/thumb?${new URLSearchParams({ p: `${dir}/${rel}`, top: Number(top) || 0, w: Number(width) || 360 })}`;

export const download = (blob, file) => {
	const link = document.createElement('a');
	link.href = URL.createObjectURL(blob);
	link.download = file;
	link.click();
	setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};

/**
 * Puts a PNG in the clipboard, or saves it as `file` where the page has no
 * clipboard (plain http off localhost). `png` is a promise of the blob:
 * handing the promise over keeps the click's permission while the image
 * loads. Resolves to 'copied' or 'saved'.
 */
export const copyPng = async (png, file) => {
	if (navigator.clipboard?.write) {
		await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
		return 'copied';
	}
	download(await png, file);
	return 'saved';
};

export const pct = (value, digits = 1) => `${(value * 100).toFixed(digits)}%`;
export const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString() : '');
export const when = (ms) => (ms ? new Date(ms).toLocaleString() : '');
export const bytes = (value) =>
	value > 1e9 ? `${(value / 1e9).toFixed(1)} GB` : `${Math.round(value / 1e6)} MB`;
export const pill = (status, text = status) =>
	`<span class="pill ${esc(status)}">${esc(text)}</span>`;

/** Closes whatever stream or timer the current view opened. */
let cleanup = () => {};
export const setCleanup = (fn) => {
	cleanup = fn;
};
let route = 0;
export const leaveView = () => {
	cleanup();
	cleanup = () => {};
	route += 1;
};

/**
 * Taken when a view starts: whether the page has moved to another view
 * since. A view checks it after each await, and stops there when it has, so
 * it neither draws over the next view nor leaves a stream open behind it.
 */
export const routeToken = () => {
	const token = route;
	return () => token !== route;
};

/**
 * Streams a job's events into a folded state. `onChange` runs at most every
 * `every` ms, and once more when the job ends.
 */
export const follow = (kind, name, onChange, every = 300) => {
	if (STATIC) {
		// An export holds the state already folded, and the job has ended.
		fetch(`api/${kind}/${encodeURIComponent(name)}.state.json`)
			.then((response) => response.json())
			.then(onChange);
		return () => {};
	}
	let state = initialState();
	let pending = false;
	let last = 0;
	const flush = () => {
		pending = false;
		last = Date.now();
		onChange(state);
	};
	const schedule = () => {
		if (pending) {
			return;
		}
		pending = true;
		setTimeout(flush, Math.max(every - (Date.now() - last), 0));
	};
	const source = new EventSource(`/api/jobs/${kind}/${encodeURIComponent(name)}/events?from=0`);
	source.onmessage = (message) => {
		for (const event of JSON.parse(message.data)) {
			reduce(state, event);
		}
		schedule();
	};
	source.addEventListener('reset', () => {
		state = initialState();
	});
	source.addEventListener('done', () => {
		source.close();
		flush();
	});
	return () => source.close();
};

/** A line chart of `values` (0..max), as an SVG path. */
const spark = (series, { height = 60, width = 600 } = {}) => {
	const lines = series
		.filter((line) => line.values.length > 1)
		.map(({ values, color, max }) => {
			const top = max ?? Math.max(...values, 1);
			const step = width / (values.length - 1);
			const d = values
				.map(
					(value, index) =>
						`${index ? 'L' : 'M'}${(index * step).toFixed(1)},${(height - (value / top) * (height - 4) - 2).toFixed(1)}`,
				)
				.join('');
			return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" />`;
		})
		.join('');
	return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${lines}</svg>`;
};

/** Completions per bucket over the run, for the throughput line. */
const throughput = (state, buckets = 60) => {
	const start = state.started;
	const end = state.ended ?? Date.now();
	if (!start || end <= start) {
		return [];
	}
	const size = (end - start) / buckets;
	const counts = Array.from({ length: buckets }, () => 0);
	for (const key of state.completed) {
		const item = state.items[key];
		if (item?.finished) {
			counts[Math.min(Math.floor((item.finished - start) / size), buckets - 1)] += 1;
		}
	}
	return counts;
};

const buildHero = (state) => {
	const spent = Date.now() - state.build.started;
	const expected = state.build.expected;
	return `<div class="hero panel">
		<div class="headline">
			<span class="percent">${expected ? pct(Math.min(spent / expected, 0.99), 0) : formatDuration(spent)}</span>
			${pill('building')}
			<span>building the storybook for ${formatDuration(spent)}</span>
			<span class="muted">${
				expected
					? spent < expected
						? `about ${formatDuration(expected - spent)} left, the last build took ${formatDuration(expected)}`
						: `longer than the last build (${formatDuration(expected)})`
					: 'no earlier build to compare with'
			}</span>
		</div>
		<div class="bar big"><span style="width:${expected ? pct(Math.min(spent / expected, 1)) : '0%'}"></span></div>
		<div class="logs">${esc(
			state.logs
				.slice(-14)
				.map((log) => log.line)
				.join('\n'),
		)}</div>
	</div>`;
};

export const heroStats = (state) => {
	if (state.status === 'building' && state.build) {
		return { e: estimate(state), html: buildHero(state) };
	}
	const e = estimate(state);
	const sample = state.samples.at(-1);
	const running = state.status === 'running';
	const stat = (label, value, sub = '') =>
		`<div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`;
	const capture = state.kind === 'capture';
	return {
		e,
		html: `
		<div class="hero panel">
			<div class="headline">
				<span class="percent">${pct(e.percent)}</span>
				<span>${pill(state.status)}</span>
				<span>${e.done} of ${esc(e.total)} ${capture ? 'stories' : 'pairs'}</span>
				${running ? `<span class="muted">about ${formatDuration(e.eta)} left, done around ${clock(e.finishAt)}${e.confidence === 'rough' ? ' (rough: no history run to price it)' : ''}</span>` : ''}
				${e.stale ? `<span class="pill failed">no event for ${formatDuration(Date.now() - state.lastEvent)}</span>` : ''}
			</div>
			<div class="bar big" title="count done, and work done (lighter)">
				<span class="work" style="width:${pct(e.workPercent)}"></span>
				<span style="width:${pct(e.percent)}"></span>
			</div>
			<div class="stats">
				${stat('Elapsed', state.started ? formatDuration(e.elapsed) : '-', state.started ? `since ${clock(state.started)}` : 'not recorded')}
				${stat('Remaining', running ? formatDuration(e.eta) : '-', running ? `${e.remaining} left` : '')}
				${stat('Finishes', running ? clock(e.finishAt) : clock(state.ended), running ? 'estimated' : state.ended ? 'ended' : '')}
				${state.started ? stat('Rate', `${e.rate.toFixed(1)}/min`, `${e.parallelism.toFixed(1)} at once`) : ''}
				${
					capture
						? `${stat('OK', state.counts.ok)}
				${stat('Busy', state.counts.busy, 'never held still')}
				${stat('Failed', state.counts.failed, `${state.counts.retries} retried`)}
				${sample ? stat('Pages', `${sample.pages}/${sample.limit}`, `${sample.browsers} browser(s)`) : ''}
				${sample ? stat('CPU', pct(sample.cpu, 0), `${bytes(sample.memFree)} free`) : ''}`
						: `${stat('Changed', state.counts.changed)}
				${stat('Missing', state.counts.missing)}
				${stat('Same', state.counts.same)}`
				}
				${e.scale !== 1 ? stat('Vs history', `${e.scale.toFixed(2)}x`, 'duration ratio') : ''}
			</div>
			${
				capture && state.samples.length > 1
					? `<div>${spark([
							{ values: throughput(state), color: '#4c8dff' },
							{ values: state.samples.map((s) => s.cpu), color: '#e0a800', max: 1 },
							{ values: state.samples.map((s) => s.pages), color: '#2fbf71' },
						])}<div class="muted" style="font-size:12px"><span style="color:#4c8dff">shots over time</span> · <span style="color:#e0a800">cpu</span> · <span style="color:#2fbf71">pages open</span></div></div>`
					: ''
			}
		</div>`,
	};
};
