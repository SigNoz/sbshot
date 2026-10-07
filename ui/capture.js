import { formatDuration, initialState } from './lib/progress.mjs';
import {
	api,
	copyPng,
	crumbs,
	esc,
	fileUrl,
	follow,
	heroStats,
	lightbox,
	pill,
	routeToken,
	setCleanup,
	STATIC,
	thumbUrl,
	view,
} from './shared.js';

/** A finished run from the older scripts: its shots.json is all there is. */
const stateFromShots = (name, shots) => {
	const state = initialState();
	state.kind = 'capture';
	state.name = name;
	state.status = 'done';
	for (const shot of shots.shots) {
		if (shot.file.includes('/crops/') || shot.file.endsWith('--highlight.png')) {
			continue;
		}
		const key = `${shot.theme}/${shot.id}`;
		state.items[key] = {
			key,
			id: shot.id,
			title: shot.title,
			name: shot.name,
			theme: shot.theme,
			file: shot.file,
			files: [shot.file],
			status: shot.status,
			duration: shot.duration,
			caption: shot.caption,
		};
		state.order.push(key);
		state.completed.push(key);
		state.counts[shot.status] += 1;
	}
	state.total = state.order.length;
	return state;
};

export const captureView = async (name, params) => {
	crumbs.innerHTML = `<a href="#/">workspace</a> / run <span class="mono">${esc(name)}</span>`;
	const stale = routeToken();
	let data;
	try {
		data = await api(`/api/jobs/capture/${encodeURIComponent(name)}`);
	} catch (error) {
		if (!stale()) view.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
		return;
	}
	if (stale()) {
		return;
	}
	const dir = data.dir;
	const filters = {
		status: params.get('status') ?? 'done',
		theme: '',
		search: '',
		sort: 'newest',
	};

	view.innerHTML = `
		<div id="hero"></div>
		<div class="columns">
			<div>
				<div class="toolbar">
					<select id="f-status">
						<option value="done">shot</option><option value="all">all</option><option value="ok">ok</option>
						<option value="busy">busy</option><option value="failed">failed</option>
						<option value="active">in flight</option><option value="queued">queued</option>
					</select>
					<select id="f-theme"><option value="">every theme</option></select>
					<select id="f-sort">
						<option value="newest">newest first</option><option value="oldest">oldest first</option>
						<option value="slowest">slowest first</option><option value="id">by id</option>
					</select>
					<input id="f-search" placeholder="filter by id or title" size="30" />
					<span id="f-count" class="muted"></span>
					<span style="flex:1"></span>
					${STATIC ? '' : '<select id="cmp-with"><option value="">diff against...</option></select>'}
				</div>
				<div class="grid" id="grid"></div>
			</div>
			<div>
				<div class="panel active-list" id="active"></div>
				<div class="panel" id="failures" style="margin-top:16px"></div>
				<div class="panel" id="slowest" style="margin-top:16px"></div>
				<div class="panel" id="config" style="margin-top:16px"></div>
			</div>
		</div>`;

	const $ = (id) => document.getElementById(id);
	$('f-status').value = filters.status;
	const cards = new Map();
	let state;

	const card = (item) => {
		const element = document.createElement('div');
		element.className = `card ${item.status}`;
		element.dataset.key = item.key;
		element.onclick = () => openShot(state.items[item.key]);
		return element;
	};

	const fillCard = (element, item) => {
		const stamp = `${item.status}|${item.phase ?? ''}|${item.duration ?? ''}`;
		if (element.dataset.stamp === stamp) {
			return;
		}
		element.dataset.stamp = stamp;
		element.className = `card ${item.status}`;
		const file = item.files?.[0] ?? item.file;
		const shot = ['ok', 'busy'].includes(item.status);
		element.innerHTML = `
			${
				shot
					? `<div class="thumb"><img loading="lazy" src="${thumbUrl(dir, file, item.caption ?? 0)}" alt="" style="width:100%;height:100%;object-fit:cover;object-position:top" /></div>`
					: `<div class="thumb empty">${esc(item.status === 'active' ? (item.phase ?? 'starting') : item.status === 'failed' ? (item.error ?? 'failed') : 'queued')}</div>`
			}
			<div class="meta">
				<div class="title" title="${esc(item.title)}/${esc(item.name)}">${esc(item.title)}/<b>${esc(item.name)}</b></div>
				<div class="line"><span class="mono muted">${esc(item.theme)}</span>
				<span>${item.duration ? `<span class="muted">${formatDuration(item.duration)}</span> ` : ''}${pill(item.status)}</span></div>
			</div>`;
	};

	const visible = () => {
		const search = filters.search.toLowerCase();
		const items = state.order
			.map((key) => state.items[key])
			.filter((item) => {
				if (filters.status === 'done' && !['ok', 'busy', 'failed'].includes(item.status))
					return false;
				if (!['all', 'done'].includes(filters.status) && item.status !== filters.status)
					return false;
				if (filters.theme && item.theme !== filters.theme) return false;
				if (search && !`${item.id} ${item.title}/${item.name}`.toLowerCase().includes(search))
					return false;
				return true;
			});
		const finished = (item) => item.finished ?? 0;
		const sorters = {
			newest: (a, b) => finished(b) - finished(a),
			oldest: (a, b) => (finished(a) || Infinity) - (finished(b) || Infinity),
			slowest: (a, b) => (b.duration ?? 0) - (a.duration ?? 0),
			id: (a, b) => a.key.localeCompare(b.key),
		};
		return items.sort(sorters[filters.sort]);
	};

	/**
	 * Inserts new cards where they belong and leaves the others in place, so
	 * only a shot that just landed animates in.
	 */
	const renderGrid = () => {
		const grid = $('grid');
		const items = visible();
		$('f-count').textContent = `${items.length} shown`;
		const wanted = new Set(items.map((item) => item.key));
		for (const [key, element] of cards) {
			if (!wanted.has(key)) {
				element.remove();
				cards.delete(key);
			}
		}
		let cursor = grid.firstElementChild;
		for (const item of items.slice(0, 1500)) {
			let element = cards.get(item.key);
			if (!element) {
				element = card(item);
				cards.set(item.key, element);
			}
			fillCard(element, item);
			if (element === cursor) {
				cursor = cursor.nextElementSibling;
			} else {
				grid.insertBefore(element, cursor);
			}
		}
		if (!items.length) {
			grid.innerHTML = `<div class="empty-state">${state.status === 'building' ? 'building the storybook...' : 'nothing here yet'}</div>`;
			cards.clear();
		} else {
			grid.querySelector('.empty-state')?.remove();
		}
	};

	const renderSide = () => {
		const now = Date.now();
		const active = Object.keys(state.active)
			.map((key) => state.items[key])
			.filter(Boolean)
			.sort((a, b) => (a.began ?? 0) - (b.began ?? 0));
		$('active').innerHTML = `<h2 style="margin-top:0">In flight (${active.length})</h2>${
			active.length
				? active
						.map((item) => {
							const spent = now - (item.began ?? now);
							const expected = item.expected ?? 0;
							const slow = expected && spent > expected * 2;
							return `<div class="row ${slow ? 'slow' : ''}" title="${esc(item.key)}">
								<span class="name">${esc(item.key)}</span>
								<span class="muted">${esc(item.phase ?? '')}</span>
								<span>${formatDuration(spent)}${expected ? ` / ${formatDuration(expected)}` : ''}
									${expected ? `<div class="bar"><span style="width:${Math.min(spent / expected, 1) * 100}%;${slow ? 'background:var(--busy)' : ''}"></span></div>` : ''}</span>
							</div>`;
						})
						.join('')
				: `<div class="muted">${state.status === 'building' ? `building storybook for ${formatDuration(now - state.build.started)}` : 'nothing running'}</div>`
		}`;

		const failed = state.order
			.map((key) => state.items[key])
			.filter((item) => item.status === 'failed' || (item.error && item.status !== 'failed'));
		$('failures').innerHTML =
			`<h2 style="margin-top:0">Failures and retries (${failed.length})</h2>${
				failed.length
					? failed
							.map(
								(item) =>
									`<div style="padding:4px 0;border-bottom:1px solid var(--line)">${pill(item.status === 'failed' ? 'failed' : 'busy', item.status === 'failed' ? 'failed' : 'retried')} <span class="mono">${esc(item.key)}</span><div class="muted mono">${esc(item.error)}</div></div>`,
							)
							.join('')
					: '<div class="muted">none</div>'
			}`;

		const slowest = state.completed
			.map((key) => state.items[key])
			.filter((item) => item?.duration)
			.sort((a, b) => b.duration - a.duration)
			.slice(0, 12);
		$('slowest').innerHTML = `<h2 style="margin-top:0">Slowest</h2>${
			slowest.length
				? `<table>${slowest
						.map(
							(item) =>
								`<tr><td class="mono" style="word-break:break-all">${esc(item.key)}</td><td>${formatDuration(item.duration)}</td><td class="muted">${
									item.expected ? `was ${formatDuration(item.expected)}` : ''
								}</td></tr>`,
						)
						.join('')}</table>`
				: '<div class="muted">nothing finished yet</div>'
		}`;

		$('config').innerHTML = `<h2 style="margin-top:0">Run</h2>
			<div class="mono muted" style="word-break:break-all">
				${state.storybook ? `storybook ${esc(state.storybook)}<br>` : ''}
				${state.history ? `history ${esc(state.history)}<br>` : ''}
				${Object.entries(state.config)
					.filter(([, value]) => value)
					.map(([key, value]) => `${esc(key)}: ${esc(value)}`)
					.join('<br>')}
				<br>dir ${esc(dir)}
			</div>`;
	};

	const render = () => {
		$('hero').innerHTML = heroStats(state).html;
		renderSide();
		renderGrid();
	};

	const themeSelect = () => {
		const themes = [...new Set(Object.values(state.items).map((item) => item.theme))];
		const select = $('f-theme');
		if (select.options.length - 1 !== themes.length) {
			select.innerHTML = `<option value="">every theme</option>${themes
				.map((theme) => `<option>${esc(theme)}</option>`)
				.join('')}`;
			select.value = filters.theme;
		}
	};

	for (const [id, key] of [
		['f-status', 'status'],
		['f-theme', 'theme'],
		['f-sort', 'sort'],
	]) {
		$(id).onchange = (event) => {
			filters[key] = event.target.value;
			renderGrid();
		};
	}
	$('f-search').oninput = (event) => {
		filters.search = event.target.value;
		renderGrid();
	};

	if (!STATIC)
		api('/api/jobs').then(({ jobs }) => {
			if (stale()) return;
			const others = jobs.filter((job) => job.kind === 'capture' && job.name !== name);
			$('cmp-with').innerHTML = `<option value="">diff against...</option>${others
				.map((job) => `<option value="${esc(job.name)}">${esc(job.name)} as baseline</option>`)
				.join('')}`;
			$('cmp-with').onchange = async (event) => {
				if (!event.target.value) return;
				const { name: diffName } = await api('/api/diffs', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ base: event.target.value, after: name }),
				});
				setTimeout(() => {
					location.hash = `#/job/diff/${encodeURIComponent(diffName)}`;
				}, 700);
			};
		});

	/** The key of the shot the lightbox shows. */
	let shown;

	/** The shots the grid shows that have an image, in its order. */
	const openable = () => visible().filter((item) => item.files?.length);

	const openShot = (item) => {
		if (!item?.files?.length) return;
		shown = item.key;
		const list = openable();
		const index = list.findIndex((other) => other.key === item.key);
		const images = item.files.filter((file) => !file.includes('/crops/'));
		lightbox.hidden = false;
		lightbox.innerHTML = `<button class="close">close (esc)</button><div class="inner">
			<div class="toolbar">${pill(item.status)} <span class="mono">${esc(item.key)}</span>
			<span class="muted">${item.duration ? formatDuration(item.duration) : ''} ${item.size ? esc(`${item.size.width}x${item.size.height}`) : ''} ${esc((item.notes ?? []).join(', '))}</span>
			${item.files.map((file) => `<a href="${fileUrl(dir, file)}" target="_blank">${esc(file)}</a>`).join(' ')}
			<span style="flex:1"></span>
			${index >= 0 ? `<span class="muted">${index + 1} of ${list.length} · j/k or arrows</span>` : ''}
			${images.length ? '<button class="copy">copy image (y)</button>' : ''}</div>
			${images.map((file) => `<img src="${fileUrl(dir, file)}" alt="" style="margin-bottom:16px" />`).join('')}
		</div>`;
		lightbox.scrollTop = 0;
		lightbox.querySelector('.close').onclick = () => {
			lightbox.hidden = true;
		};
		const copy = lightbox.querySelector('.copy');
		if (copy) copy.onclick = () => copyShot(images[0], copy);
	};

	const step = (by) => {
		const list = openable();
		const index = list.findIndex((item) => item.key === shown);
		if (index >= 0 && list[index + by]) openShot(list[index + by]);
	};

	/** The file as a PNG: itself, or redrawn where an export holds it as WebP. */
	const pngOf = async (url) => {
		const blob = await fetch(url).then((response) => response.blob());
		if (blob.type === 'image/png') return blob;
		const image = await createImageBitmap(blob);
		const canvas = document.createElement('canvas');
		canvas.width = image.width;
		canvas.height = image.height;
		canvas.getContext('2d').drawImage(image, 0, 0);
		return new Promise((resolve, reject) =>
			canvas.toBlob(
				(png) => (png ? resolve(png) : reject(new Error('the shot is too large to draw'))),
				'image/png',
			),
		);
	};

	/** Copies the shot as the lightbox shows it, caption band included. */
	const copyShot = async (file, button) => {
		const say = (text) => {
			button.textContent = text;
			setTimeout(() => {
				if (button.isConnected) button.textContent = 'copy image (y)';
			}, 2000);
		};
		button.textContent = 'copying...';
		try {
			say(await copyPng(pngOf(fileUrl(dir, file)), file.replaceAll('/', '--')));
		} catch (error) {
			say(error.message);
		}
	};

	const onKey = (event) => {
		if (lightbox.hidden) return;
		const keys = {
			j: () => step(1),
			ArrowRight: () => step(1),
			k: () => step(-1),
			ArrowLeft: () => step(-1),
			y: () => lightbox.querySelector('.copy')?.click(),
		};
		if (keys[event.key]) {
			keys[event.key]();
			event.preventDefault();
		}
	};
	document.addEventListener('keydown', onKey);

	if (data.job?.legacy && data.shots) {
		state = stateFromShots(name, data.shots);
		themeSelect();
		render();
		setCleanup(() => document.removeEventListener('keydown', onKey));
		return;
	}

	state = initialState();
	render();
	const stop = follow('capture', name, (next) => {
		state = next;
		themeSelect();
		render();
	});
	// The in-flight timers tick even when no event arrives.
	const tick = setInterval(() => {
		if (state && ['running', 'building'].includes(state.status)) {
			$('hero').innerHTML = heroStats(state).html;
			renderSide();
		}
	}, 1000);
	setCleanup(() => {
		stop();
		clearInterval(tick);
		document.removeEventListener('keydown', onKey);
	});
};
