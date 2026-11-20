import { formatDuration } from './lib/progress.mjs';
import {
	api,
	bytes,
	crumbs,
	esc,
	pct,
	pill,
	routeToken,
	setCleanup,
	downloadExport,
	STATIC,
	view,
	when,
} from './shared.js';

export const home = async () => {
	crumbs.innerHTML = '';
	const stale = routeToken();
	let timer;
	// Jobs ticked for export, by kind and name, kept across refreshes.
	const chosen = new Set();
	// Disk use, fetched apart from the list: the first walk of a big
	// workspace takes a moment, and the list should not wait for it.
	let usage = null;
	let bySize = false;
	const sizeOf = new Map();
	const render = async () => {
		let data;
		try {
			data = await api('/api/jobs');
		} catch (error) {
			if (!stale()) view.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
			return;
		}
		if (stale()) {
			return;
		}
		if (STATIC && data.start && !location.hash) {
			location.replace(data.start);
			return;
		}
		document.getElementById('workspace').textContent =
			`${data.workspace}${usage ? ` · ${bytes(usage.total)}` : ''}`;
		const order = (jobs) =>
			bySize && usage
				? jobs.toSorted(
						(a, b) =>
							(sizeOf.get(`${b.kind}/${b.name}`)?.size ?? 0) -
							(sizeOf.get(`${a.kind}/${a.name}`)?.size ?? 0),
					)
				: jobs;
		const captures = order(data.jobs.filter((job) => job.kind === 'capture'));
		const diffs = order(data.jobs.filter((job) => job.kind === 'diff'));

		const sizeCell = (job) => {
			if (STATIC) return '';
			const size = sizeOf.get(`${job.kind}/${job.name}`);
			if (!size) return `<td class="muted">${usage ? '' : '...'}</td>`;
			const parts = [
				size.build &&
					`${bytes(size.size - size.build)} of shots, ${bytes(size.build)} of storybook build`,
				size.linked && 'linked in from elsewhere: sbshot rm only removes the link',
			].filter(Boolean);
			return `<td class="${size.linked ? 'muted' : ''}" title="${esc(parts.join('. '))}">${bytes(size.size)}${size.linked ? ' (linked)' : ''}</td>`;
		};

		const row = (job) => {
			const e = job.estimate;
			const running = ['running', 'building'].includes(job.status);
			const counts =
				job.kind === 'diff'
					? `${job.counts.changed} changed, ${job.counts.missing} missing, ${job.counts.same} same`
					: job.legacy
						? 'imported run'
						: `${job.counts.ok} ok, ${job.counts.busy} busy, ${job.counts.failed} failed`;
			const took =
				job.ended && job.started && !job.legacy ? formatDuration(job.ended - job.started) : '';
			const key = `${job.kind}/${job.name}`;
			return `<tr class="link" data-href="#/job/${esc(job.kind)}/${encodeURIComponent(job.name)}">
				${STATIC ? '' : `<td>${running ? '' : `<input type="checkbox" class="pick" data-key="${esc(key)}" title="export" ${chosen.has(key) ? 'checked' : ''} />`}</td>`}
				<td>${pill(job.status)}</td>
				<td class="mono">${esc(job.name)}</td>
				<td style="width:220px">${
					running
						? `<div class="bar"><span style="width:${pct(e.percent)}"></span></div>
					<div class="muted" style="font-size:12px">${e.done}/${esc(e.total)} ${pct(e.percent)} · eta ${formatDuration(e.eta)}</div>`
						: `<span class="muted">${job.total ? `${esc(job.total)} items` : ''}</span>`
				}</td>
				<td>${esc(counts)}</td>
				<td class="muted">${esc(when(job.started))}</td>
				<td class="muted">${esc(took)}</td>
				${sizeCell(job)}
			</tr>`;
		};

		const options = captures
			.map((job) => `<option value="${esc(job.name)}">${esc(job.name)}</option>`)
			.join('');
		const previous = {
			base: document.getElementById('cmp-base')?.value,
			after: document.getElementById('cmp-after')?.value,
			all: document.getElementById('ex-all')?.checked,
			runs: document.getElementById('ex-runs')?.checked,
		};
		const head = `<thead><tr>${STATIC ? '' : '<th></th>'}<th>Status</th><th>Name</th><th>Progress</th><th>Result</th><th>Started</th><th>Took</th>${
			STATIC
				? ''
				: `<th><a href="#" class="by-size" title="sort by size">${bySize ? 'Size ↓' : 'Size'}</a></th>`
		}</tr></thead>`;
		const disk =
			STATIC || !usage
				? ''
				: `<div class="muted disk">${[
						['runs', usage.runs],
						['diffs', usage.diffs],
						['orphan builds', usage.builds],
						['thumbnail cache', usage.cache],
						['other', usage.other],
					]
						.filter(([, size]) => size)
						.map(([label, size]) => `${esc(label)} ${bytes(size)}`)
						.join(' · ')}${
						usage.linked ? ` · linked from elsewhere ${bytes(usage.linked)}, not counted` : ''
					} · <span class="mono">sbshot rm &lt;name&gt;</span> frees a run with its build</div>`;
		const compare = `
			<h2>Compare two runs</h2>
			<div class="panel form-grid">
				<label>baseline <select id="cmp-base">${options}</select></label>
				<label>after <select id="cmp-after">${options}</select></label>
				<label>mode <select id="cmp-mode">
					<option>green</option><option>green-parallel</option><option>red</option><option>red-parallel</option>
				</select></label>
				<label>threshold <input id="cmp-threshold" value="0.063" size="6" /></label>
				<label>noise floor <select id="cmp-noise"><option value="">none</option>${diffs
					.map((job) => `<option>${esc(job.name)}</option>`)
					.join('')}</select></label>
				<button class="primary" id="cmp-go">Run diff</button>
				<span id="cmp-msg" class="muted"></span>
			</div>`;
		const exporter = `
			<h2>Export</h2>
			<div class="panel form-grid">
				<span id="ex-count" class="muted"></span>
				<label><input type="checkbox" id="ex-all" ${previous.all ? 'checked' : ''} /> identical pairs too</label>
				<label><input type="checkbox" id="ex-runs" ${previous.runs ? 'checked' : ''} /> every shot of the runs a diff compared</label>
				<a class="button primary" id="ex-go">Download zip</a>
			</div>`;

		const runs = `
			<h2>Runs</h2>
			<div class="panel">${
				captures.length
					? `<table>${head}<tbody>${captures.map(row).join('')}</tbody></table>`
					: `<div class="empty-state">No runs yet. Start one with <span class="mono">sbshot capture &lt;storybook&gt;</span>.</div>`
			}</div>`;

		view.innerHTML = `
			${disk}
			${STATIC && !captures.length ? '' : runs}
			${STATIC ? '' : compare}
			<h2>Diffs</h2>
			<div class="panel">${
				diffs.length
					? `<table>${head}<tbody>${diffs.map(row).join('')}</tbody></table>`
					: `<div class="empty-state">No diffs yet.</div>`
			}</div>
			${STATIC ? '' : exporter}`;

		view.querySelectorAll('tr.link').forEach((tr) => {
			tr.onclick = () => {
				location.hash = tr.dataset.href;
			};
		});
		if (STATIC) {
			return;
		}
		view.querySelectorAll('.by-size').forEach((link) => {
			link.onclick = (event) => {
				event.preventDefault();
				bySize = !bySize;
				render();
			};
		});

		// The zip is a plain download: the server streams it as it reads the files.
		const exportLink = () => {
			const params = new URLSearchParams();
			for (const key of chosen) {
				const [kind, ...name] = key.split('/');
				params.append(kind === 'diff' ? 'diff' : 'run', name.join('/'));
			}
			if (document.getElementById('ex-all').checked) params.set('all', '1');
			if (document.getElementById('ex-runs').checked) params.set('runs', '1');
			const go = document.getElementById('ex-go');
			go.classList.toggle('disabled', !chosen.size);
			go.href = chosen.size ? `/api/export.zip?${params}` : '#';
			document.getElementById('ex-count').textContent = chosen.size
				? `${chosen.size} ticked`
				: 'tick runs and diffs above to put them in a static site';
		};
		view.querySelectorAll('.pick').forEach((box) => {
			box.onclick = (event) => event.stopPropagation();
			box.onchange = () => {
				if (box.checked) chosen.add(box.dataset.key);
				else chosen.delete(box.dataset.key);
				exportLink();
			};
		});
		document.getElementById('ex-all').onchange = exportLink;
		document.getElementById('ex-runs').onchange = exportLink;
		document.getElementById('ex-go').onclick = (event) => {
			event.preventDefault();
			if (!chosen.size) return;
			downloadExport(event.currentTarget.href).catch((error) => {
				document.getElementById('ex-count').textContent = error.message;
			});
		};
		exportLink();

		const base = document.getElementById('cmp-base');
		const after = document.getElementById('cmp-after');
		if (captures.length > 1) {
			base.value = previous.base ?? captures[1].name;
			after.value = previous.after ?? captures[0].name;
		}
		document.getElementById('cmp-go').onclick = async () => {
			const message = document.getElementById('cmp-msg');
			try {
				const { name } = await api('/api/diffs', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						base: base.value,
						after: after.value,
						mode: document.getElementById('cmp-mode').value,
						threshold: document.getElementById('cmp-threshold').value,
						noise: document.getElementById('cmp-noise').value || undefined,
					}),
				});
				message.textContent = 'started';
				setTimeout(() => {
					location.hash = `#/job/diff/${encodeURIComponent(name)}`;
				}, 700);
			} catch (error) {
				message.textContent = error.message;
			}
		};
	};
	await render();
	if (STATIC || stale()) {
		return;
	}
	const measure = async () => {
		try {
			usage = await api('/api/usage');
		} catch {
			return; // a viewer older than this page: no sizes
		}
		sizeOf.clear();
		for (const row of usage.jobs) sizeOf.set(`${row.kind}/${row.name}`, row);
		// Not under someone typing in the compare form: the list's own refresh
		// draws the sizes once they leave it.
		const typing =
			view.contains(document.activeElement) && document.activeElement !== document.body;
		if (!stale() && !typing) render();
	};
	measure();
	const sizes = setInterval(measure, 30_000);
	// The list only refreshes while nobody is using the compare form.
	timer = setInterval(() => {
		if (!view.contains(document.activeElement) || document.activeElement === document.body) {
			render();
		}
	}, 3000);
	setCleanup(() => {
		clearInterval(timer);
		clearInterval(sizes);
	});
};
