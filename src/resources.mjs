import { readFileSync } from 'node:fs';
import os from 'node:os';

/**
 * Bytes the system can hand out without swapping. `os.freemem()` leaves out the
 * page cache the kernel would drop on demand, which on a Linux desktop is most
 * of the memory, so `MemAvailable` is read where there is one.
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
	return os.freemem();
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
