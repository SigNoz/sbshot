/** The page behind `sbshot du --open`: what each workspace takes, a click from its viewer. */
import { api, bytes, crumbs, esc, routeToken, view } from './shared.js';

// The pieces of a workspace's total, as `workspaceUsage` splits it. The
// colours live in sizes.css, by the key.
const PARTS = [
	['runs', 'runs'],
	['diffs', 'diffs'],
	['builds', 'orphan builds'],
	['cache', 'thumbnail cache'],
	['other', 'other'],
];

const share = (part, whole) => {
	const percent = (part / whole) * 100;
	return percent < 1 ? '<1%' : `${percent.toFixed(0)}%`;
};

const KIND = { capture: 'run', diff: 'diff' };

const date = (ms) => (ms ? new Date(ms).toLocaleDateString() : '');

/** Adds the stylesheet of this view, which no other page needs. Resolves once it has loaded or failed. */
const loadStyles = () =>
	new Promise((resolve) => {
		const link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = 'sizes.css';
		link.onload = resolve;
		link.onerror = resolve;
		document.head.append(link);
	});

/**
 * Opens a workspace's viewer. The tab is opened at once, while the click
 * still allows it, and pointed at the viewer once the server has started or
 * found it, as `openInStorybook` does for a story.
 */
const openViewer = async (workspace) => {
	const tab = window.open('', '_blank');
	try {
		const { url } = await api('/api/workspaces/open', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ workspace }),
		});
		if (tab) {
			tab.opener = null;
			tab.location.href = url;
		} else {
			window.open(url, '_blank', 'noopener');
		}
	} catch (error) {
		tab?.close();
		throw error;
	}
};

const legend = `<div class="du-legend muted">${PARTS.map(
	([key, label]) => `<span><i class="du-swatch ${key}"></i>${esc(label)}</span>`,
).join('')}</div>`;

/** What a workspace holds, as one bar cut by the pieces of its total. */
const bar = (usage) => {
	const segments = PARTS.filter(([key]) => usage[key] > 0)
		.map(
			([key, label]) =>
				`<span class="du-seg ${key}" style="flex-grow:${usage[key]}" title="${esc(label)} ${bytes(usage[key])}"></span>`,
		)
		.join('');
	return `<div class="du-track">${segments}</div>`;
};

const detail = (usage) => {
	const parts = PARTS.filter(([key]) => usage[key] > 0)
		.map(
			([key, label]) =>
				`<li><i class="du-swatch ${key}"></i>${esc(label)} <b>${bytes(usage[key])}</b> <span class="muted">${share(usage[key], usage.total)}</span></li>`,
		)
		.join('');
	const more = usage.jobs - usage.topJobs.length;
	const jobs = usage.topJobs.length
		? `<table class="du-jobs">
				<thead><tr><th></th><th>Largest jobs</th><th class="du-num">Size</th><th class="du-num">Images</th></tr></thead>
				<tbody>${usage.topJobs
					.map(
						(job) => `<tr${job.linked ? ' class="muted"' : ''}>
							<td class="muted">${esc(KIND[job.kind] ?? job.kind)}${job.linked ? ', linked' : ''}</td>
							<td class="mono">${esc(job.name)}</td>
							<td class="du-num">${bytes(job.size)}</td>
							<td class="du-num">${bytes(job.imageBytes)}</td>
						</tr>`,
					)
					.join('')}</tbody>
			</table>${more > 0 ? `<div class="muted">and ${more} more</div>` : ''}`
		: '<div class="muted">No runs or diffs here: the rest is the thumbnail cache and other files.</div>';
	return `<div class="du-detail-body">
		<ul class="du-parts">${parts}</ul>
		${usage.linked ? `<div class="muted">${bytes(usage.linked)} of linked jobs live elsewhere and are not counted.</div>` : ''}
		${jobs}
	</div>`;
};

export const sizesView = async () => {
	crumbs.innerHTML = '<span>disk use</span>';
	const stale = routeToken();
	const styled = loadStyles();
	// Rows open, kept across a refresh.
	const open = new Set();

	const draw = (workspaces, message = '') => {
		const measured = workspaces.filter((usage) => !usage.error);
		const total = measured.reduce((sum, usage) => sum + usage.total, 0);
		const images = measured.reduce((sum, usage) => sum + usage.imageBytes, 0);
		const rows = workspaces
			.toSorted((a, b) => (b.total ?? -1) - (a.total ?? -1))
			.map((usage) => {
				const key = esc(usage.workspace);
				if (usage.error) {
					return `<tr><td class="mono du-path">${key}</td><td colspan="6" class="muted">${esc(usage.error)}</td></tr>`;
				}
				const shown = open.has(usage.workspace);
				return `<tr class="link du-row" data-workspace="${key}" tabindex="0" aria-expanded="${shown}">
						<td class="mono du-path"><span class="du-caret">${shown ? '▾' : '▸'}</span>${key}</td>
						<td class="du-num"><b>${bytes(usage.total)}</b></td>
						<td class="du-bar">${bar(usage)}</td>
						<td class="du-num" title="${usage.images} images">${bytes(usage.imageBytes)}</td>
						<td class="du-num">${usage.jobs}</td>
						<td class="muted" title="${esc(usage.lastActivity ? new Date(usage.lastActivity).toLocaleString() : '')}">${esc(date(usage.lastActivity)) || '-'}</td>
						<td><button class="du-open" title="open this workspace's viewer">open</button></td>
					</tr>
					<tr class="du-detail" ${shown ? '' : 'hidden'}><td colspan="7">${detail(usage)}</td></tr>`;
			})
			.join('');
		view.innerHTML = `
			<div class="du-summary">
				<span><b>${bytes(total)}</b> in ${measured.length} workspace${measured.length === 1 ? '' : 's'}</span>
				<span class="muted">${bytes(images)} of it images</span>
				<button class="du-refresh">refresh</button>
				<span class="du-message">${esc(message)}</span>
			</div>
			${legend}
			<div class="panel">${
				workspaces.length
					? `<table class="du-table">
						<thead><tr><th>Workspace</th><th class="du-num">Total</th><th>Breakdown</th><th class="du-num">Images</th><th class="du-num">Jobs</th><th>Last activity</th><th></th></tr></thead>
						<tbody>${rows}</tbody>
					</table>`
					: '<div class="empty-state">No workspace to show.</div>'
			}</div>`;

		const note = view.querySelector('.du-message');
		view.querySelector('.du-refresh').onclick = () => load(true);
		view.querySelectorAll('tr.du-row').forEach((row) => {
			const toggle = () => {
				const { workspace } = row.dataset;
				const detailRow = row.nextElementSibling;
				detailRow.hidden = !detailRow.hidden;
				row.setAttribute('aria-expanded', String(!detailRow.hidden));
				row.querySelector('.du-caret').textContent = detailRow.hidden ? '▸' : '▾';
				if (detailRow.hidden) open.delete(workspace);
				else open.add(workspace);
			};
			row.onclick = toggle;
			row.onkeydown = (event) => {
				if (event.target === row && (event.key === 'Enter' || event.key === ' ')) {
					event.preventDefault();
					toggle();
				}
			};
			const button = row.querySelector('.du-open');
			button.onclick = async (event) => {
				event.stopPropagation();
				button.disabled = true;
				button.textContent = 'opening...';
				note.textContent = '';
				try {
					await openViewer(row.dataset.workspace);
				} catch (error) {
					note.textContent = error.message;
				}
				button.disabled = false;
				button.textContent = 'open';
			};
		});
	};

	let workspaces = [];
	const load = async (again = false) => {
		if (again) {
			const button = view.querySelector('.du-refresh');
			if (button) {
				button.disabled = true;
				button.textContent = 'measuring...';
			}
		} else {
			view.innerHTML =
				'<div class="empty-state">Measuring disk use. The first scan of a big workspace takes a moment.</div>';
		}
		try {
			const [found] = await Promise.all([api('/api/workspaces'), styled]);
			workspaces = found;
		} catch (error) {
			if (!stale()) {
				if (again && workspaces.length) draw(workspaces, error.message);
				else view.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
			}
			return;
		}
		if (!stale()) draw(workspaces);
	};
	await load();
};
