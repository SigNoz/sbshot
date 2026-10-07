/**
 * Folds an `events.ndjson` stream into the state of a run or a diff, and
 * estimates when it ends. No Node imports: the UI loads this same file in the
 * browser, so the terminal and the page never disagree about a number.
 */

export const initialState = () => ({
	kind: null,
	name: null,
	status: 'pending',
	started: null,
	ended: null,
	lastEvent: null,
	total: 0,
	config: {},
	storybook: null,
	history: null,
	build: null,
	items: {},
	order: [],
	completed: [],
	active: {},
	counts: { ok: 0, busy: 0, failed: 0, retries: 0, changed: 0, missing: 0, same: 0 },
	samples: [],
	logs: [],
	summary: null,
});

const SAMPLE_KEEP = 600;
const LOG_KEEP = 200;

export const reduce = (state, event) => {
	state.lastEvent = event.t;
	switch (event.type) {
		case 'build-start':
			state.kind = event.kind ?? 'capture';
			state.name = event.name ?? state.name;
			state.status = 'building';
			state.build = { started: event.t, dir: event.dir, expected: event.expected };
			break;
		case 'build-end':
			if (state.build) {
				state.build.ended = event.t;
				state.build.ok = event.ok;
			}
			break;
		case 'start': {
			state.kind = event.kind;
			state.name = event.name;
			state.status = 'running';
			state.started = event.t;
			// A count, whatever the file says: the page and the terminal print it.
			state.total = Number.isSafeInteger(event.total) && event.total > 0 ? event.total : 0;
			state.config = event.config ?? {};
			state.storybook = event.storybook ?? null;
			state.history = event.history ?? null;
			state.historyParallelism = event.historyParallelism ?? null;
			state.base = event.base;
			state.after = event.after;
			for (const item of event.items ?? []) {
				state.items[item.key] = { ...item, status: 'queued' };
				state.order.push(item.key);
			}
			break;
		}
		case 'begin': {
			const item = state.items[event.key];
			if (item) {
				item.status = 'active';
				item.phase = 'goto';
				item.began = event.t;
				item.worker = event.worker;
				item.attempt = event.attempt;
				state.active[event.key] = true;
			}
			break;
		}
		case 'phase': {
			const item = state.items[event.key];
			if (item) {
				item.phase = event.phase;
			}
			break;
		}
		case 'shot': {
			const item = state.items[event.key];
			if (!item) {
				break;
			}
			Object.assign(item, {
				status: event.status,
				duration: event.duration,
				files: event.files,
				notes: event.notes,
				size: event.size,
				caption: event.caption,
				finished: event.t,
				phase: null,
			});
			delete state.active[event.key];
			state.counts[event.status] += 1;
			state.completed.push(event.key);
			break;
		}
		case 'retry': {
			const item = state.items[event.key];
			if (item) {
				item.status = 'queued';
				item.error = event.error;
				item.phase = null;
				delete state.active[event.key];
			}
			state.counts.retries += 1;
			break;
		}
		case 'fail': {
			const item = state.items[event.key];
			if (item) {
				item.status = 'failed';
				item.error = event.error;
				item.finished = event.t;
				item.duration = event.duration;
				item.phase = null;
				delete state.active[event.key];
			}
			state.counts.failed += 1;
			state.completed.push(event.key);
			break;
		}
		case 'pair': {
			const item = state.items[event.key];
			if (!item) {
				break;
			}
			const { type, t, key, ...result } = event;
			Object.assign(item, result, {
				status: event.note ? 'missing' : event.changed ? 'changed' : 'same',
				finished: t,
			});
			state.counts[item.status] += 1;
			state.completed.push(key);
			break;
		}
		case 'sample':
			state.samples.push(event);
			if (state.samples.length > SAMPLE_KEEP) {
				state.samples.splice(0, state.samples.length - SAMPLE_KEEP);
			}
			break;
		case 'log':
			state.logs.push(event);
			if (state.logs.length > LOG_KEEP) {
				state.logs.splice(0, state.logs.length - LOG_KEEP);
			}
			break;
		case 'end':
			state.status = event.status ?? 'done';
			state.ended = event.t;
			state.summary = event.summary ?? null;
			state.active = {};
			break;
		default:
			break;
	}
	return state;
};

export const fold = (events, state = initialState()) => events.reduce(reduce, state);

const median = (values) => {
	if (!values.length) {
		return null;
	}
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
};

/** How far back the throughput is measured. Long enough to smooth, short enough to follow the load. */
const WINDOW = 60_000;

/**
 * Time left, from the work left rather than the count left: the queue runs
 * slowest first, so the first minutes finish few long stories and a count
 * rate would put the end far too late.
 *
 * - Each item left is worth its duration in the history run, scaled by how
 *   this run's items compare with their history so far (a loaded machine is
 *   uniformly slower), or the median of this run when it has no history.
 * - The work is divided by the parallelism the run has actually delivered
 *   over the last minute: busy time finished per wall second.
 */
export const estimate = (state, now = Date.now()) => {
	const end = state.ended ?? now;
	const elapsed = state.started ? end - state.started : 0;
	const done = state.completed.length;
	const total = state.total || state.order.length;
	const percent = total ? done / total : 0;

	const finished = state.completed
		.map((key) => state.items[key])
		.filter((item) => item && item.duration > 0);

	const withHistory = finished.filter((item) => item.expected > 0);
	const scale =
		withHistory.length >= 3
			? withHistory.reduce((sum, item) => sum + item.duration, 0) /
				withHistory.reduce((sum, item) => sum + item.expected, 0)
			: 1;

	// The same story in another theme costs about the same, and is usually
	// shot first: the queue runs one theme after the other.
	const sibling = {};
	for (const item of finished) {
		if (item.id) {
			sibling[item.id] = Math.max(sibling[item.id] ?? 0, item.duration);
		}
	}

	// What is still running counts at what it has taken so far. Without it the
	// fast stories, which finish first, would price everything left.
	const activeItems = Object.keys(state.active)
		.map((key) => state.items[key])
		.filter(Boolean);
	const observed = [
		...finished.map((item) => item.duration),
		...activeItems.map((item) => now - (item.began ?? now)),
	];
	const fallback =
		(observed.length ? observed.reduce((sum, value) => sum + value, 0) / observed.length : null) ??
		median(
			Object.values(state.items)
				.map((item) => item.expected)
				.filter(Boolean),
		) ??
		(state.kind === 'diff' ? 300 : 8000);

	const costOf = (item) => (item.expected ? item.expected * scale : (sibling[item.id] ?? fallback));

	let remaining = 0;
	let remainingCount = 0;
	const running = [];
	const waiting = [];
	for (const key of state.order) {
		const item = state.items[key];
		if (item.status === 'queued') {
			const cost = costOf(item);
			remaining += cost;
			remainingCount += 1;
			waiting.push(cost);
		} else if (item.status === 'active') {
			// One past its price has shown it is slower than priced; the longer
			// it has run, the longer it is likely to go on.
			const spent = now - (item.began ?? now);
			const cost = costOf(item);
			const left = spent < cost ? cost - spent : Math.max(spent * 0.3, cost * 0.1);
			remaining += left;
			remainingCount += 1;
			running.push(left);
		}
	}

	const recent = finished.filter((item) => item.finished > end - WINDOW);
	const windowStart = Math.max(state.started ?? end, end - WINDOW);
	const span = end - windowStart;
	const delivered =
		recent.length >= 3 && span > 5000
			? recent.reduce((sum, item) => sum + item.duration, 0) / span
			: 0;
	const activeNow = activeItems.length;
	// While pages are still being added, what is open now says more about the
	// next minute than what finished in the last one.
	// A history run knows what this machine sustains over a whole run, ramp
	// and drain included, which the last minute of a young run cannot. It is
	// trusted less as this run's own record grows.
	const sustained = delivered || activeNow || 1;
	const weight = total ? Math.min(done / total, 1) : 1;
	const parallelism = Math.max(
		state.historyParallelism
			? weight * sustained + (1 - weight) * state.historyParallelism
			: sustained,
		1,
	);

	const isRunning = state.status === 'running';
	// The queue is played out over that many slots, in its own order: what
	// runs now finishes first, then each story waits for the first free slot.
	// That catches the end of a run, when the queue is empty, the pages go
	// idle one by one, and a single long story sets the finish.
	const simulate = () => {
		const slots = Math.max(Math.round(parallelism), 1);
		const free = running.slice(0, slots).sort((a, b) => a - b);
		// Stories past the slot count wait like queued ones.
		const pending = [...running.slice(slots), ...waiting];
		while (free.length < slots) {
			free.push(0);
		}
		let end = Math.max(0, ...free);
		for (const cost of pending) {
			// `free` stays sorted, so the first slot is the earliest free.
			const at = free.shift() + cost;
			end = Math.max(end, at);
			let index = free.findIndex((value) => value > at);
			if (index < 0) index = free.length;
			free.splice(index, 0, at);
		}
		return end;
	};
	const eta = isRunning && remainingCount ? simulate() : 0;
	const rate = elapsed > 0 ? (done / elapsed) * 60_000 : 0;
	const completedWork = finished.reduce((sum, item) => sum + item.duration, 0);

	return {
		total,
		done,
		remaining: remainingCount,
		active: activeNow,
		percent,
		workPercent:
			completedWork + remaining > 0 ? completedWork / (completedWork + remaining) : percent,
		elapsed,
		eta,
		finishAt: isRunning && eta ? now + eta : state.ended,
		rate,
		parallelism,
		scale,
		// Priced from a history run whose pace is known, or guessed from this
		// run alone, which runs short while pages ramp up and the queue drains.
		confidence: state.historyParallelism && withHistory.length >= 3 ? 'history' : 'rough',
		stale: isRunning && state.lastEvent ? now - state.lastEvent > 30_000 : false,
	};
};

export const formatDuration = (ms) => {
	if (!Number.isFinite(ms) || ms <= 0) {
		return '0s';
	}
	const seconds = Math.round(ms / 1000);
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (h) {
		return `${h}h${String(m).padStart(2, '0')}m`;
	}
	if (m) {
		return `${m}m${String(s).padStart(2, '0')}s`;
	}
	return `${s}s`;
};

/** One line a terminal or an agent can read at a glance. */
export const progressLine = (state, now = Date.now()) => {
	const e = estimate(state, now);
	const pct = (e.percent * 100).toFixed(1);
	const parts = [`${e.done}/${e.total} ${pct}%`, `elapsed ${formatDuration(e.elapsed)}`];
	if (state.status === 'running') {
		parts.push(`eta ${formatDuration(e.eta)}${e.confidence === 'rough' ? ' (rough)' : ''}`);
		parts.push(`${e.active} active`);
	}
	if (state.kind === 'capture') {
		const { ok, busy, failed, retries } = state.counts;
		parts.push(`ok ${ok} busy ${busy} failed ${failed} retries ${retries}`);
	} else if (state.kind === 'diff') {
		const { changed, missing, same } = state.counts;
		parts.push(`changed ${changed} missing ${missing} same ${same}`);
	}
	return parts.join('  ');
};
