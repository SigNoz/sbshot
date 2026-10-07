# How sbshot is put together

Plain Node ES modules, no build step, one dependency (Playwright).
ImageMagick is called as a process for captions, montages and thumbnails.

## Layout

```
bin/sbshot.mjs            dispatcher: loads the command module a command needs
src/commands/             one module per command: flags, help, orchestration
  capture.mjs             capture, list
  diff.mjs                diff
  status.mjs              status, runs
  review.mjs              review
  tag.mjs                 tag
  ui.mjs                  ui
  export.mjs              export
  workspace.mjs           init, link, rm
src/                      what the commands are built from
  worker.mjs              one browser process of a capture
  playwright.mjs          finding Playwright and launching Chromium
  storybook.mjs           building a project, serving a build, picking stories
  changed.mjs             stories a git change reaches (--changed-since)
  history.mjs             the earlier run that prices a new one
  resources.mjs           CPU and memory sampling
  compare.mjs             the per-pair diff work, on worker threads
  pixels.mjs              the pixel comparison (pixelmatch's maths)
  png.mjs                 PNG decoding and file helpers
  caption.mjs             ImageMagick plumbing: caption band, contact sheet
  events.mjs              the append-only event log
  progress.mjs            folding events into state, and the ETA
  review.mjs              verdicts and tags on diff pairs
  server.mjs              the viewer's HTTP server
  loopback.mjs            the Host names both local servers accept
  jobs.mjs                what the viewer's API says about a job
  export.mjs              a static copy of the viewer and some jobs, as a folder or a zip
  viewer.mjs              one viewer per workspace, started on demand
  workspace.mjs           workspace layout, job lookup, job records
  notify.mjs              desktop notifications
ui/                       the viewer: vanilla JS modules, no framework
  app.js                  router
  shared.js               page elements, formatting, API, live job state
  home.js, capture.js, diff.js   one module per page
  snapshot.js, gif.js     the diff view drawn to a PNG or an animated GIF
skills/sbshot/SKILL.md    the agent guide
test/                     node:test suites
```

## A capture

`commands/capture.mjs` works out the source (URL, build or project), builds
it if needed, serves a build on a free port, and reads `index.json` to pick
the stories. It then prices the queue from a history run
(`history.mjs`), sorts it slowest first, and starts shooting.

Shooting happens in browser processes: `worker.mjs`, forked with its
settings as JSON in an environment variable. Each owns one Chromium and
opens a page per story, reusing browser contexts. It reports `ready`, its
event-loop load, each story's phase, and the result over the IPC channel.

The coordinator grows the number of pages in flight while the CPU and memory
it samples leave room, at most one page per story that finished rendering,
and shrinks it under pressure. A new browser starts when every running one
has a busy event loop, since that is where CDP messages and screenshots are
decoded. A failed story is queued again once.

When the queue drains it writes the contact sheets, `shots.json`, and the
final `sbshot.json`.

## A diff

`commands/diff.mjs` lists the PNGs of both runs, pairs them by relative
path, and hands the pairs to `compare.mjs`, on as many worker threads as the
cores and the memory the largest shot needs allow. `compare.mjs` skips pairs
whose PNG data is byte-identical, decodes the rest (`png.mjs`, or
ImageMagick for formats it does not read), crops the caption bands off, and
compares them with `pixels.mjs`. Rows that are identical are skipped with a
memcmp, which is most rows of most pairs. Changed pairs get a diff image,
captioned with the settings the two runs disagree on.

## Events and the ETA

Every capture and diff appends to `events.ndjson` (`events.mjs`). Nothing
else talks to the working process: `status` and the viewer read the file.
`progress.mjs` folds the events into state and estimates the end. It has no
Node imports, and the viewer loads the same file in the browser, so the
terminal and the page never disagree about a number.

The estimate prices each remaining item from the history run, scaled by how
this run's finished items compare with their history, and plays the queue
out over the parallelism the run has delivered (blended with what the
history run sustained while this run is young). Playing it out, rather than
dividing work by parallelism, catches the end of a run, when pages go idle
one by one and one long story sets the finish.

## The viewer

`server.mjs` serves the files in `ui/`, `src/progress.mjs`, a JSON API over
the workspace, the job event logs as server-sent events (polled, since
`fs.watch` misses writes on synced folders), images from the workspace and
the runs its jobs reference, and cached thumbnails with the caption cut
off. It starts diffs as detached `sbshot diff` processes and writes verdicts.

It listens on localhost and refuses requests whose `Host` is not local (DNS
rebinding): a loopback name, or on a `--host` bind that address, the
machine's name or an IP literal. It refuses writes that are not JSON from its
own origin (cross-site requests). Every job a request names is a name of the
workspace, never a path, and a verdict must name a pair of the diff. Files
come from the workspace, each job's real directory, and the runs a diff
compared, and only images are answered inline, with `nosniff`.

A job directory may come from anywhere (`init`, `link`), so what its JSON
says is not trusted as a path: story ids must be file names, export paths
must stay inside their job, and a diff's `base` and `after` only count when
they are runs. The build server of a capture serves a file only when its real
path is inside the build, to a request that names localhost.

`export.mjs` freezes the same API answers (`jobs.mjs`) into JSON files and
the event logs into folded states, copies the images they point at, and
writes the `ui/` files beside them with `data-static` on the page. In that
mode `shared.js` reads those files instead of the server and the pages hide
what would write. The server streams the same plan as a stored zip.

`viewer.mjs` keeps one viewer per workspace: `--ui` on a capture or diff
reuses the one recorded in `ui.json` while it answers for this workspace on
a loopback address, or starts a detached `sbshot ui`. `ui.lock` makes two
commands that ask at once start one viewer between them.
