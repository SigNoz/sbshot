import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';

/**
 * Bytes macOS can hand out without swapping, from `vm_stat`: the free pages
 * plus the inactive, speculative and purgeable ones it reclaims on demand.
 */
export const vmStatAvailable = (text) => {
	const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
	const pages = (label) =>
		Number(new RegExp(`^Pages ${label}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0);
	return (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * pageSize;
};

/**
 * Bytes the system can hand out without swapping. `os.freemem()` leaves out the
 * page cache the kernel would drop on demand, which on a Linux desktop is most
 * of the memory, so `MemAvailable` is read where there is one. macOS counts
 * only its free pages, often under 1% of the memory, so `vm_stat` is read there.
 */
export const availableMemory = () => {
	try {
		const kib = /^MemAvailable:\s+(\d+)/m.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1];
		if (kib) {
			return Number(kib) * 1024;
		}
	} catch {
		/* not Linux */
	}
	if (process.platform === 'darwin') {
		try {
			return vmStatAvailable(execFileSync('vm_stat').toString());
		} catch {
			/* fall through */
		}
	}
	return os.freemem();
};

/**
 * Resident memory of `root` and every process under it, from `ps -A -o
 * pid=,ppid=,rss=` output. Pages a process shares count once per process, so
 * the sum runs high for a tree of Chromium processes.
 */
export const treeMemory = (ps, root) => {
	const rss = new Map();
	const children = new Map();
	for (const line of ps.split('\n')) {
		const [pid, ppid, kib] = line.trim().split(/\s+/).map(Number);
		if (pid) {
			rss.set(pid, kib * 1024);
			children.set(ppid, [...(children.get(ppid) ?? []), pid]);
		}
	}
	let total = 0;
	const stack = [root];
	while (stack.length) {
		const pid = stack.pop();
		total += rss.get(pid) ?? 0;
		stack.push(...(children.get(pid) ?? []));
	}
	return total;
};

let owned = { at: 0, bytes: 0 };

/** Resident memory of this process and its workers and browsers, read at most every 2 s. */
export const ownMemory = () => {
	if (Date.now() - owned.at > 2000) {
		let bytes = 0;
		try {
			bytes = treeMemory(
				execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=']).toString(),
				process.pid,
			);
		} catch {
			/* no ps: pages are priced by CPU and free memory alone */
		}
		owned = { at: Date.now(), bytes };
	}
	return owned.bytes;
};

const cpuTimes = () =>
	os.cpus().reduce(
		(sum, { times }) => {
			const total = Object.values(times).reduce((a, b) => a + b, 0);
			return { idle: sum.idle + times.idle, total: sum.total + total };
		},
		{ idle: 0, total: 0 },
	);

/** Returns a function giving the share of every core that was busy since its last call. */
export const cpuSampler = () => {
	let last = cpuTimes();
	return () => {
		const now = cpuTimes();
		const total = now.total - last.total;
		const busy = total ? 1 - (now.idle - last.idle) / total : 0;
		last = now;
		return busy;
	};
};
