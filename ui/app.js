import { captureView } from './capture.js';
import { diffView } from './diff.js';
import { home } from './home.js';
import { leaveView, lightbox } from './shared.js';
import { sizesView } from './sizes.js';

/** A segment of the hash, or null for one that is not valid percent-encoding. */
const decode = (part) => {
	try {
		return decodeURIComponent(part);
	} catch {
		return null;
	}
};

// `sbshot du --open` serves this same page with the attribute set: it shows
// what the workspaces take on disk instead of one workspace's jobs.
const SIZES = document.documentElement.hasAttribute('data-sizes');

const route = () => {
	leaveView();
	lightbox.hidden = true;
	if (SIZES) {
		return sizesView();
	}
	const hash = location.hash.replace(/^#/, '') || '/';
	const [pathPart, query = ''] = hash.split('?');
	const params = new URLSearchParams(query);
	const parts = pathPart.split('/').filter(Boolean).map(decode);
	if (parts[0] === 'job' && parts.length === 3 && parts[2] !== null) {
		return parts[1] === 'diff' ? diffView(parts[2], params) : captureView(parts[2], params);
	}
	return home();
};

window.addEventListener('hashchange', route);

document.addEventListener('keydown', (event) => {
	if (event.key === 'Escape') lightbox.hidden = true;
});

route();
