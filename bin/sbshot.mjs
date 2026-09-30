#!/usr/bin/env node
const HELP = `sbshot: screenshot storybook stories, diff two runs, watch both live.

  sbshot capture <storybook> [options]   shoot stories into a run
  sbshot list <storybook> [filters]      print the stories a capture would shoot
  sbshot modes <storybook>               themes, globals and Chromatic modes the preview offers
  sbshot diff <baseline> <after>         pixel-diff two runs
  sbshot status [job] [--watch|--wait]   progress, ETA and failures of a job
  sbshot runs                            every run and diff in the workspace
  sbshot review [diff] [file verdict]    verdicts left on a diff's pairs
  sbshot tag [diff] [tag pair...]        group a diff's pairs under a tag the viewer filters by
  sbshot ui [--port n] [--open]          serve the viewer for the workspace
  sbshot export [job...] [--out dir]     diffs and runs as a static site to host anywhere
  sbshot init [source]                   link older results (./.story-shots) into the workspace
  sbshot link <dir> [name]               add a run made elsewhere to the workspace
  sbshot rm <job>...                     delete runs or diffs, and builds they made

Every command takes --workspace <dir> (default ./.sbshot, or $SBSHOT_WORKSPACE).
'sbshot <command> --help' has the options.`;

const [command, ...rest] = process.argv.slice(2);

// Each command's module is loaded only when it runs, so `sbshot status` does
// not pay for playwright or the server.
const lazy =
	(file, name, extra = []) =>
	async (argv) =>
		(await import(`../src/commands/${file}.mjs`))[name]([...argv, ...extra]);

const commands = {
	capture: lazy('capture', 'capture'),
	list: lazy('capture', 'capture', ['--list']),
	modes: lazy('modes', 'modes'),
	diff: lazy('diff', 'diff'),
	status: lazy('status', 'status'),
	runs: lazy('status', 'runs'),
	review: lazy('review', 'review'),
	tag: lazy('tag', 'tag'),
	ui: lazy('ui', 'ui'),
	export: lazy('export', 'exportJobs'),
	init: lazy('workspace', 'init'),
	link: lazy('workspace', 'link'),
	rm: lazy('workspace', 'remove'),
};
// Older names that still work.
commands.shoot = commands.capture;
commands.ls = commands.runs;

/**
 * Exits once what was printed has left: a pipe drains asynchronously on
 * macOS, and `process.exit` alone would cut a `--json` answer short.
 */
const exit = async (code) => {
	await Promise.all(
		[process.stdout, process.stderr].map(
			(stream) => new Promise((resolve) => stream.write('', resolve)),
		),
	);
	process.exit(code);
};

if (!command || command === '--help' || command === '-h' || command === 'help') {
	console.log(HELP);
	await exit(command ? 0 : 1);
}
if (!Object.hasOwn(commands, command)) {
	console.error(`unknown command ${command}\n\n${HELP}`);
	await exit(1);
}

try {
	await exit((await commands[command](rest)) ?? 0);
} catch (error) {
	console.error(error.message);
	await exit(1);
}
