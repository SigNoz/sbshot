import { initialState } from './lib/progress.mjs';
import {
	api,
	copyPng,
	crumbs,
	download,
	esc,
	fileUrl,
	follow,
	heroStats,
	pct,
	pill,
	routeToken,
	setCleanup,
	downloadExport,
	STATIC,
	view,
} from './shared.js';
import { snapshot } from './snapshot.js';

const HOVER_ZOOM = 2.5;

const MODES = [
	['diff', 'diff'],
	['side', 'side by side'],
	['side3', 'before | after | diff'],
	['swipe', 'swipe'],
	['onion', 'onion skin'],
	['blink', 'blink'],
];

/**
 * An image shown without the caption band a capture stamped on top: the
 * wrapper takes the content's aspect ratio and the image slides up by the
 * band. Percent margins resolve against the width, which is what makes the
 * shift scale with the image.
 */
const cropped = (src, top, onReady) => {
	const wrap = document.createElement('div');
	wrap.className = 'crop';
	const img = new Image();
	img.decoding = 'async';
	img.onload = () => {
		const { naturalWidth: width, naturalHeight: height } = img;
		wrap.style.aspectRatio = `${width} / ${Math.max(height - top, 1)}`;
		img.style.marginTop = `-${(top / width) * 100}%`;
		onReady?.({ width, height: height - top });
	};
	img.src = src;
	wrap.append(img);
	return wrap;
};

export const diffView = async (name, params) => {
	crumbs.innerHTML = `<a href="#/">workspace</a> / diff <span class="mono">${esc(name)}</span>`;
	const $ = (id) => document.getElementById(id);
	const stale = routeToken();
	let data = await api(`/api/jobs/diff/${encodeURIComponent(name)}`).catch(() => null);
	if (stale()) {
		return;
	}
	if (!data) {
		view.innerHTML = '<div class="empty-state">no such diff</div>';
		return;
	}
	let review = data.review ?? {};
	let tags = data.tags ?? {};
	// A tag the file names, never one the object inherits (`?tag=__proto__`).
	const tagFiles = (tag) => {
		const files = Object.hasOwn(tags, tag) && tags[tag]?.files;
		return Array.isArray(files) ? files : [];
	};
	const tagsOf = (file) => Object.keys(tags).filter((tag) => tagFiles(tag).includes(file));
	let state = initialState();
	const ui = {
		mode: localStorage.getItem('sbshot.mode') ?? 'swipe',
		box: localStorage.getItem('sbshot.box') !== 'off',
		zoom: localStorage.getItem('sbshot.zoom') === 'on',
		actual: false,
		split: 50,
		opacity: 50,
		selected: params.get('file'),
		search: '',
		theme: '',
		// Tags name the pairs to look at, the identical ones included. A pair
		// is shown when it holds every tag picked, so `fix,dark` is the fix in
		// the dark theme.
		tags: (params.get('tag') ?? '').split(',').filter(Boolean),
		status: params.get('tag') ? 'all' : 'changed',
		hideFlaky: false,
		reviewed: 'all',
	};

	view.innerHTML = `
		<div id="hero"></div>
		<div class="diff-layout" style="margin-top:16px">
			<div class="panel pair-list" style="padding:0">
				<div style="padding:10px;border-bottom:1px solid var(--line);display:grid;gap:6px">
					<input id="d-search" placeholder="filter" />
					<div class="form-grid">
						<select id="d-status"><option value="changed">changed + missing</option><option value="all">all pairs</option><option value="missing">missing only</option><option value="same">same</option></select>
						<select id="d-theme"><option value="">every theme</option></select>
					</div>
					<div class="form-grid">
						<select id="d-review"><option value="all">any verdict</option><option value="pending">pending</option><option value="expected">expected</option><option value="regression">regression</option><option value="flaky">flaky</option></select>
						<label><input type="checkbox" id="d-flaky" /> hide flaky</label>
					</div>
					<div id="d-tags" class="tag-picker"></div>
					<div id="d-tag-note" class="muted" style="font-size:12px"></div>
					<div id="d-count" class="muted" style="font-size:12px"></div>
					${STATIC ? '' : `<a class="muted" style="font-size:12px" id="d-export" href="/api/export.zip?diff=${encodeURIComponent(name)}">download as a static site (zip)</a>`}
				</div>
				<div id="pairs"></div>
			</div>
			<div class="viewer">
				<div class="toolbar" id="modes"></div>
				<div class="toolbar" id="pair-bar"></div>
				<div class="stage" id="stage"><div class="empty-state">pick a pair</div></div>
				<div class="muted" style="margin-top:8px;font-size:12px">
					<span class="kbd">j</span>/<span class="kbd">k</span> next/previous
					<span class="kbd">1</span>-<span class="kbd">6</span> view
					${STATIC ? '' : '<span class="kbd">e</span> expected <span class="kbd">r</span> regression <span class="kbd">f</span> flaky <span class="kbd">c</span> clear'}
					<span class="kbd">b</span> change box <span class="kbd">z</span> jump to change <span class="kbd">a</span> actual size <span class="kbd">h</span> hover zoom <span class="kbd">y</span> copy view
				</div>
			</div>
		</div>`;

	const pairs = () => {
		const results =
			data.diff?.results ??
			state.order.map((key) => state.items[key]).filter((item) => item.status !== 'queued');
		const search = ui.search.toLowerCase();
		return results
			.filter((pair) => {
				const status = pair.note ? 'missing' : pair.changed ? 'changed' : 'same';
				if (ui.status === 'changed' && status === 'same') return false;
				if (!['all', 'changed'].includes(ui.status) && status !== ui.status) return false;
				if (ui.theme && !pair.file.startsWith(`${ui.theme}/`)) return false;
				if (ui.hideFlaky && pair.flaky) return false;
				if (ui.tags.some((tag) => !tagFiles(tag).includes(pair.file))) return false;
				const verdict = review[pair.file]?.verdict ?? 'pending';
				if (ui.reviewed !== 'all' && verdict !== ui.reviewed) return false;
				if (search && !pair.file.toLowerCase().includes(search)) return false;
				return true;
			})
			.sort((a, b) => b.changed - a.changed || a.file.localeCompare(b.file));
	};

	const baseDir = () => data.diff?.base ?? state.base;
	const afterDir = () => data.diff?.after ?? state.after;

	const renderList = () => {
		const list = pairs();
		const reviewed = list.filter((pair) => review[pair.file]).length;
		$('d-count').textContent = `${list.length} pairs, ${reviewed} reviewed`;
		$('pairs').innerHTML = list
			.map((pair) => {
				const status = pair.note ? 'missing' : pair.changed ? 'changed' : 'same';
				const verdict = review[pair.file]?.verdict;
				return `<div class="pair ${pair.file === ui.selected ? 'selected' : ''}" data-file="${esc(pair.file)}">
					<span class="file">${esc(pair.file)}</span>
					<span class="line">${pill(status, pair.note ?? status)}
					<span class="muted">${pair.changed ? `${esc(Number(pair.changed).toLocaleString())} px · ${pct(pair.ratio ?? 0, 2)}` : ''}</span>
					${pair.flaky ? pill('flaky') : ''} ${verdict ? pill(verdict) : ''}
					${tagsOf(pair.file)
						.map((tag) => pill('tag', tag))
						.join(' ')}</span>
				</div>`;
			})
			.join('');
		$('pairs')
			.querySelectorAll('.pair')
			.forEach((element) => {
				element.onclick = () => select(element.dataset.file);
			});
		if (!ui.selected && list.length) {
			select(list[0].file);
		}
	};

	const renderModes = () => {
		$('modes').innerHTML = `${MODES.map(
			([mode, label], index) =>
				`<button data-mode="${mode}" class="${ui.mode === mode ? 'on' : ''}">${index + 1} ${esc(label)}</button>`,
		).join('')}
			<span style="flex:1"></span>
			<button id="t-box" class="${ui.box ? 'on' : ''}">change box</button>
			<button id="t-zoom">jump to change</button>
			<button id="t-actual" class="${ui.actual ? 'on' : ''}">actual size</button>
			<label><input type="checkbox" id="t-hover" ${ui.zoom ? 'checked' : ''} /> zoom on hover</label>
			<button id="t-copy">${copyLabel()}</button>`;
		$('modes')
			.querySelectorAll('[data-mode]')
			.forEach((button) => {
				button.onclick = () => setMode(button.dataset.mode);
			});
		$('t-box').onclick = () => {
			ui.box = !ui.box;
			localStorage.setItem('sbshot.box', ui.box ? 'on' : 'off');
			renderModes();
			renderStage();
		};
		$('t-zoom').onclick = () => jumpToChange();
		$('t-copy').onclick = () => copyView();
		$('t-hover').onchange = (event) => {
			ui.zoom = event.target.checked;
			localStorage.setItem('sbshot.zoom', ui.zoom ? 'on' : 'off');
			renderStage();
		};
		$('t-actual').onclick = () => {
			ui.actual = !ui.actual;
			renderModes();
			renderStage();
		};
	};

	const setMode = (mode) => {
		ui.mode = mode;
		localStorage.setItem('sbshot.mode', mode);
		renderModes();
		renderStage();
	};

	// Blink is an animation, and a clipboard only takes a still PNG.
	const copyLabel = () => (ui.mode === 'blink' ? 'save gif' : 'copy image');

	const current = () => pairs().find((pair) => pair.file === ui.selected);

	const boxOverlay = (pair) => {
		if (!ui.box || !pair.box || !pair.width || !pair.height) return null;
		const overlay = document.createElement('div');
		overlay.className = 'changebox';
		const { x, y, width, height } = pair.box;
		Object.assign(overlay.style, {
			left: `${(x / pair.width) * 100}%`,
			top: `${(y / pair.height) * 100}%`,
			width: `${Math.max((width / pair.width) * 100, 0.3)}%`,
			height: `${Math.max((height / pair.height) * 100, 0.3)}%`,
		});
		return overlay;
	};

	// The holder keeps its layout size, so the mouse position inside it is the
	// point of the content to magnify; only the content inside is scaled.
	const zoomable = (element) => {
		if (!ui.zoom) return element;
		const holder = document.createElement('div');
		holder.className = 'hover-zoom';
		holder.append(element);
		holder.onmousemove = (event) => {
			const rect = holder.getBoundingClientRect();
			element.style.transformOrigin = `${event.clientX - rect.left}px ${event.clientY - rect.top}px`;
			element.style.transform = `scale(${HOVER_ZOOM})`;
		};
		holder.onmouseleave = () => {
			element.style.transform = '';
		};
		return holder;
	};

	/** The pair's three images and the caption band on top of each, null where there is none. */
	const sourcesOf = (pair) => ({
		base:
			pair.note === 'missing previous'
				? null
				: { src: fileUrl(baseDir(), pair.file), top: pair.baseCaption ?? 0 },
		after:
			pair.note === 'missing current'
				? null
				: { src: fileUrl(afterDir(), pair.file), top: pair.afterCaption ?? 0 },
		diff: pair.plain
			? { src: fileUrl(data.dir, pair.plain), top: 0 }
			: pair.output && !pair.note
				? { src: fileUrl(data.dir, pair.output), top: pair.outputCaption ?? 0 }
				: null,
	});

	/**
	 * Copies the view as it is now: the mode, the change box, the swipe line
	 * and the onion opacity. Blink is saved as a GIF instead, and so is a PNG
	 * where the page has no clipboard (plain http off localhost).
	 */
	const copyView = async () => {
		const pair = current();
		if (!pair) return;
		const button = $('t-copy');
		const say = (text) => {
			button.textContent = text;
			setTimeout(() => {
				if (button.isConnected) button.textContent = copyLabel();
			}, 2000);
		};
		const view = { mode: ui.mode, box: ui.box, split: ui.split, opacity: ui.opacity };
		const file = `${pair.file.replace(/\.png$/, '').replaceAll('/', '--')}--${ui.mode}`;
		button.textContent = 'drawing...';
		const shot = snapshot(pair, sourcesOf(pair), view);
		try {
			if (ui.mode !== 'blink') {
				say(
					await copyPng(
						shot.then(({ blob }) => blob),
						`${file}.png`,
					),
				);
				return;
			}
			const { blob, type } = await shot;
			download(blob, `${file}.${type}`);
			say('saved');
		} catch (error) {
			say(error.message);
		}
	};

	let blinkTimer;
	const renderStage = () => {
		clearInterval(blinkTimer);
		const stage = $('stage');
		const pair = current();
		if (!pair) {
			stage.innerHTML = '<div class="empty-state">pick a pair</div>';
			$('pair-bar').innerHTML = '';
			return;
		}
		const verdict = review[pair.file];
		$('pair-bar').innerHTML = `<span class="mono">${esc(pair.file)}</span>
			<span class="muted">${pair.changed ? `${esc(Number(pair.changed).toLocaleString())} px changed (${pct(pair.ratio ?? 0, 3)})` : 'no change'}
			${pair.width ? ` · ${esc(`${pair.width}x${pair.height}`)}` : ''}</span>
			${tagsOf(pair.file)
				.map((tag) => pill('tag', tag))
				.join(' ')}
			<span style="flex:1"></span>
			${
				STATIC
					? verdict
						? pill(verdict.verdict)
						: ''
					: `${['expected', 'regression', 'flaky']
							.map(
								(value) =>
									`<button data-verdict="${value}" class="${verdict?.verdict === value ? 'on' : ''}">${value}</button>`,
							)
							.join('')}
			<button data-verdict="clear">clear</button>`
			}`;
		$('pair-bar')
			.querySelectorAll('[data-verdict]')
			.forEach((button) => {
				button.onclick = () => setVerdict(button.dataset.verdict);
			});

		const shots = sourcesOf(pair);
		const base = () =>
			shots.base ? cropped(shots.base.src, shots.base.top) : placeholderTile('missing in baseline');
		const after = () =>
			shots.after ? cropped(shots.after.src, shots.after.top) : placeholderTile('missing in after');
		const diffImage = () =>
			shots.diff
				? cropped(shots.diff.src, shots.diff.top)
				: placeholderTile('no diff image: the pair is identical');

		const frame = document.createElement('div');
		frame.style.width =
			ui.actual && pair.width
				? `${pair.width * (ui.mode.startsWith('side') ? (ui.mode === 'side3' ? 3 : 2) : 1)}px`
				: '100%';
		const withBox = (element) => {
			const holder = document.createElement('div');
			holder.style.position = 'relative';
			holder.append(element);
			const overlay = boxOverlay(pair);
			if (overlay) holder.append(overlay);
			return holder;
		};
		const labelled = (label, element) => {
			const holder = document.createElement('div');
			holder.innerHTML = `<div class="label">${esc(label)}</div>`;
			holder.append(withBox(element));
			return holder;
		};

		if (ui.mode === 'diff') {
			frame.append(zoomable(withBox(diffImage())));
		} else if (ui.mode === 'side' || ui.mode === 'side3') {
			const grid = document.createElement('div');
			grid.className = `side ${ui.mode === 'side3' ? 'three' : 'two'}`;
			grid.append(labelled('baseline', base()), labelled('after', after()));
			if (ui.mode === 'side3') grid.append(labelled('diff', diffImage()));
			frame.append(zoomable(grid));
		} else {
			// The after shot sets the size; the baseline sits under or over it.
			const stack = document.createElement('div');
			stack.className = 'stack';
			const bottom = document.createElement('div');
			bottom.className = 'layer';
			bottom.append(after());
			const top = document.createElement('div');
			top.className = 'layer';
			top.style.overflow = 'hidden';
			top.append(base());
			stack.append(bottom, top);
			const overlay = boxOverlay(pair);
			if (overlay) stack.append(overlay);

			const controls = document.createElement('div');
			controls.className = 'toolbar';
			if (ui.mode === 'swipe') {
				const handle = document.createElement('div');
				handle.className = 'swipe-handle';
				stack.append(handle);
				const apply = () => {
					top.style.clipPath = `inset(0 ${100 - ui.split}% 0 0)`;
					handle.style.left = `${ui.split}%`;
				};
				apply();
				stack.onmousemove = (event) => {
					const rect = stack.getBoundingClientRect();
					ui.split = Math.min(Math.max(((event.clientX - rect.left) / rect.width) * 100, 0), 100);
					apply();
				};
				controls.innerHTML =
					'<span class="muted">baseline on the left of the line, after on the right. Move the mouse over the image.</span>';
			} else if (ui.mode === 'onion') {
				top.style.opacity = ui.opacity / 100;
				controls.innerHTML = `<span class="muted">after</span><input type="range" min="0" max="100" value="${ui.opacity}" id="onion" style="width:300px" /><span class="muted">baseline</span>`;
				controls.querySelector('#onion').oninput = (event) => {
					ui.opacity = Number(event.target.value);
					top.style.opacity = ui.opacity / 100;
				};
			} else {
				let showBase = true;
				const label = document.createElement('span');
				label.className = 'pill';
				controls.append(label);
				const flip = () => {
					top.style.visibility = showBase ? 'visible' : 'hidden';
					label.textContent = showBase ? 'baseline' : 'after';
					showBase = !showBase;
				};
				flip();
				blinkTimer = setInterval(flip, 600);
			}
			frame.append(controls, zoomable(stack));
		}
		stage.replaceChildren(frame);
	};

	const placeholderTile = (text) => {
		const element = document.createElement('div');
		element.className = 'empty-state';
		element.style.minHeight = '300px';
		element.textContent = text;
		return element;
	};

	const jumpToChange = () => {
		const pair = current();
		const stage = $('stage');
		const overlay = stage.querySelector('.changebox');
		if (!pair?.box || !overlay) return;
		const stageRect = stage.getBoundingClientRect();
		const rect = overlay.getBoundingClientRect();
		stage.scrollTop += rect.top - stageRect.top - 60;
		stage.scrollLeft += rect.left - stageRect.left - 60;
	};

	// A comma is legal in a query and tag names never hold one, so the link
	// keeps the `?tag=a,b` shape `sbshot tag` prints.
	const syncUrl = () => {
		const query = new URLSearchParams({
			...(ui.tags.length && { tag: ui.tags.join(',') }),
			...(ui.selected && { file: ui.selected }),
		});
		history.replaceState(
			null,
			'',
			`#/job/diff/${encodeURIComponent(name)}?${String(query).replaceAll('%2C', ',')}`,
		);
	};

	const select = (file) => {
		ui.selected = file;
		syncUrl();
		$('pairs')
			.querySelectorAll('.pair')
			.forEach((element) => {
				element.classList.toggle('selected', element.dataset.file === file);
				if (element.dataset.file === file) element.scrollIntoView({ block: 'nearest' });
			});
		$('stage').scrollTop = 0;
		renderStage();
	};

	const move = (step) => {
		const list = pairs();
		const index = list.findIndex((pair) => pair.file === ui.selected);
		const next = list[Math.min(Math.max(index + step, 0), list.length - 1)];
		if (next) select(next.file);
	};

	const setVerdict = async (verdict) => {
		const pair = current();
		if (!pair || STATIC) return;
		review = await api(`/api/jobs/diff/${encodeURIComponent(name)}/review`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ file: pair.file, verdict }),
		});
		renderList();
		renderStage();
	};

	const onKey = (event) => {
		if (['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) return;
		const keys = {
			j: () => move(1),
			ArrowDown: () => move(1),
			k: () => move(-1),
			ArrowUp: () => move(-1),
			e: () => setVerdict('expected'),
			r: () => setVerdict('regression'),
			f: () => setVerdict('flaky'),
			c: () => setVerdict('clear'),
			b: () => $('t-box').click(),
			z: () => jumpToChange(),
			a: () => $('t-actual').click(),
			h: () => $('t-hover').click(),
			y: () => copyView(),
		};
		if (/^[1-6]$/.test(event.key)) {
			setMode(MODES[Number(event.key) - 1][0]);
			event.preventDefault();
		} else if (keys[event.key]) {
			keys[event.key]();
			event.preventDefault();
		}
	};
	document.addEventListener('keydown', onKey);

	const themeOptions = () => {
		const results = data.diff?.results ?? Object.values(state.items);
		const themes = [...new Set(results.map((pair) => (pair.file ?? pair.key).split('/')[0]))];
		$('d-theme').innerHTML =
			`<option value="">every theme</option>${themes.map((theme) => `<option>${esc(theme)}</option>`).join('')}`;
		$('d-theme').value = ui.theme;
	};

	const tagOptions = () => {
		const names = Object.keys(tags).sort();
		names.unshift(...ui.tags.filter((tag) => !names.includes(tag)));
		const picker = $('d-tags');
		picker.hidden = !names.length;
		picker.innerHTML = `${names
			.map(
				(tag) =>
					`<button class="pill tag ${ui.tags.includes(tag) ? 'on' : ''}" data-tag="${esc(tag)}" title="${esc((Object.hasOwn(tags, tag) && tags[tag]?.note) || '')}">${esc(tag)} ${tagFiles(tag).length}</button>`,
			)
			.join('')}${ui.tags.length ? '<button class="pill" data-clear>any tag</button>' : ''}`;
		picker.querySelectorAll('[data-tag]').forEach((button) => {
			const { tag } = button.dataset;
			button.onclick = () =>
				pickTags(
					ui.tags.includes(tag) ? ui.tags.filter((name) => name !== tag) : [...ui.tags, tag],
				);
		});
		picker.querySelector('[data-clear]')?.addEventListener('click', () => pickTags([]));
		$('d-tag-note').innerHTML = ui.tags
			.filter((tag) => Object.hasOwn(tags, tag) && tags[tag]?.note)
			.map((tag) => `<div><span class="mono">${esc(tag)}</span>: ${esc(tags[tag].note)}</div>`)
			.join('');
	};

	// Picking the first tag shows the identical pairs too, and dropping the
	// last goes back to the changed ones; in between the status stays put.
	const pickTags = (next) => {
		if (!next.length !== !ui.tags.length) {
			ui.status = next.length ? 'all' : 'changed';
			$('d-status').value = ui.status;
		}
		ui.tags = next;
		ui.selected = null;
		syncUrl();
		tagOptions();
		renderList();
	};

	// Tags usually come from an agent while the page is open: pick them up
	// whenever the human comes back to the tab.
	const refresh = async () => {
		const next = await api(`/api/jobs/diff/${encodeURIComponent(name)}`).catch(() => null);
		if (!next?.diff || stale()) return;
		review = next.review ?? review;
		tags = next.tags ?? tags;
		tagOptions();
		renderList();
		renderStage();
	};
	if (!STATIC) window.addEventListener('focus', refresh);

	$('d-search').oninput = (event) => {
		ui.search = event.target.value;
		renderList();
	};
	$('d-status').onchange = (event) => {
		ui.status = event.target.value;
		renderList();
	};
	$('d-theme').onchange = (event) => {
		ui.theme = event.target.value;
		renderList();
	};
	$('d-review').onchange = (event) => {
		ui.reviewed = event.target.value;
		renderList();
	};
	$('d-flaky').onchange = (event) => {
		ui.hideFlaky = event.target.checked;
		renderList();
	};

	if (!STATIC) {
		$('d-export').onclick = (event) => {
			event.preventDefault();
			downloadExport(event.currentTarget.href).catch((error) => {
				event.target.textContent = error.message;
			});
		};
	}

	renderModes();
	themeOptions();
	tagOptions();
	$('d-status').value = ui.status;
	renderList();
	renderStage();

	const stop = follow('diff', name, async (next) => {
		state = next;
		$('hero').innerHTML = heroStats(state).html;
		if (state.status !== 'running' && !data.diff) {
			data = await api(`/api/jobs/diff/${encodeURIComponent(name)}`);
			if (stale()) return;
			review = data.review ?? review;
			tags = data.tags ?? tags;
			themeOptions();
			tagOptions();
			renderStage();
		}
		renderList();
	});
	setCleanup(() => {
		stop();
		clearInterval(blinkTimer);
		document.removeEventListener('keydown', onKey);
		window.removeEventListener('focus', refresh);
	});
};
