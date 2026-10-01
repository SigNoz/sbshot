import { closeSync, openSync, readSync, fstatSync, writeSync } from 'node:fs';

/**
 * Every run and every diff keeps an append-only `events.ndjson` beside its
 * output. It is the only channel between the process doing the work and
 * whatever watches it (the UI, `sbshot status`, an agent tailing the file), so
 * a watcher never has to talk to the process and a crashed run still leaves
 * everything it did behind. One line per event, `t` in epoch milliseconds.
 */
export const openLog = (file) => {
	const fd = openSync(file, 'a');
	return {
		emit(type, data = {}) {
			writeSync(fd, `${JSON.stringify({ t: Date.now(), type, ...data })}\n`);
		},
		close() {
			closeSync(fd);
		},
	};
};

/**
 * The complete lines of `file` from byte `offset` on, and the offset to read
 * from next time. A line the writer is half way through is left for the next
 * read rather than parsed broken. An offset that is not a byte of a file
 * (a viewer request may say anything) reads from the start.
 */
export const readEvents = (file, from = 0) => {
	const offset = Number.isSafeInteger(from) && from > 0 ? from : 0;
	let fd;
	try {
		fd = openSync(file, 'r');
	} catch {
		return { events: [], offset };
	}
	try {
		const size = fstatSync(fd).size;
		if (size <= offset) {
			return { events: [], offset: size < offset ? 0 : offset };
		}
		const buffer = Buffer.alloc(size - offset);
		readSync(fd, buffer, 0, buffer.length, offset);
		const end = buffer.lastIndexOf(10);
		if (end < 0) {
			return { events: [], offset };
		}
		const events = [];
		for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
			if (!line) {
				continue;
			}
			try {
				events.push(JSON.parse(line));
			} catch {
				/* a torn line from a killed writer */
			}
		}
		return { events, offset: offset + end + 1 };
	} finally {
		closeSync(fd);
	}
};
