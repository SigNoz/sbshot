import { formatDuration } from './lib/progress.mjs';
import {
	api,
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
		document.getElementById('workspace').textContent = data.workspace;
		const captures = data.jobs.filter((job) => job.kind === 'capture');
		const diffs = data.jobs.filter((job) => job.kind === 'diff');

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
		const head = `<thead><tr>${STATIC ? '' : '<th></th>'}<th>Status</th><th>Name</th><th>Progress</th><th>Result</th><th>Started</th><th>Took</th></tr></thead>`;
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
	// The list only refreshes while nobody is using the compare form.
	timer = setInterval(() => {
		if (!view.contains(document.activeElement) || document.activeElement === document.body) {
			render();
		}
	}, 3000);
	setCleanup(() => clearInterval(timer));
};
