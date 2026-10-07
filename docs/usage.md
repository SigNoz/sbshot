# Using sbshot

This page covers the everyday workflows first, then every part of the tool in
more detail. For installing, see the [README](../README.md).

- [How it works](#how-it-works)
- [Workflows](#workflows)
- [Choosing what to shoot](#choosing-what-to-shoot)
- [Capture options](#capture-options)
- [Following a long run](#following-a-long-run)
- [Diff](#diff)
- [The viewer](#the-viewer)
- [Review from the terminal](#review-from-the-terminal)
- [Tags](#tags)
- [Managing the workspace](#managing-the-workspace)
- [Exit codes](#exit-codes)
- [Environment variables](#environment-variables)
- [Troubleshooting](#troubleshooting)

## How it works

A comparison has three steps:

1. `sbshot capture` opens each story in headless Chromium, waits until the
   page stops changing, and saves one PNG per story and theme. This set of
   PNGs is a run.
2. You change something (code, branch, a setting) and capture a second run.
3. `sbshot diff` compares the two runs story by story and writes a diff. The
   viewer shows it.

Runs and diffs live in the workspace, `./.sbshot` in the directory you run
the command from. Run every command of one comparison from the same
directory, or pass the same `--workspace <dir>` each time, or the runs will
not find each other. Add `.sbshot/` to your `.gitignore`.

Refer to a run or a diff by its name (`before`, `after`), by its path, or as
`latest`. `latest:capture` and `latest:diff` pick the newest of one kind.

## Workflows

### Before and after a change

```bash
sbshot capture . --name-run before --theme dark,light
# edit the code
sbshot capture . --name-run after --theme dark,light
sbshot diff before after --ui
```

If the change is already made, capture `after` first. Then commit your work,
check out the base, capture `before`, and switch back.

### One branch against another

```bash
sbshot capture . --name-run feature
git switch main
sbshot capture . --name-run main
git switch -
sbshot diff main feature
```

### Only the stories a change reaches

```bash
sbshot capture . --name-run after --changed-since main
```

sbshot finds the files changed since the git ref (here `main`), follows the
module graph of the Storybook build up to the story files that import them,
and shoots only those stories. This is the idea behind Chromatic's
TurboSnap.

Some changes reach every story, and then every story is shot:

- `.storybook/`, `public/`, `package.json`, a Vite config or a tsconfig.
- A lockfile (pnpm, npm, yarn or bun) in the project or any directory above
  it, so monorepos work.

Files in sibling workspace packages are followed like the project's own.

Anything the module graph cannot see, such as a Tailwind config or a global
stylesheet, can be added with `--changed-global <glob>` (repeatable, relative
to the project). A change to a matching file reshoots every story:

```bash
sbshot capture . --changed-since main \
  --changed-global 'tailwind.config.*' --changed-global 'src/styles/**'
```

`--changed-since` needs a build made with `storybook build --stats-json`.
Builds sbshot makes from a project always have it. For a build made
elsewhere, add that flag to your build, and pass `--project <dir>` if the
build is not inside the project.

### Measuring the noise floor

Some stories change on their own between runs: animations, random data,
timers. To see which ones, shoot the same build twice and diff the two:

```bash
sbshot capture .sbshot/builds/before --name-run floor
sbshot diff before floor                        # writes diffs/before--floor
```

Pass that diff as `--noise` in the real comparison. Stories that moved in it
are marked flaky:

```bash
sbshot diff before after --noise before--floor
```

To make those stories stable instead, see
[storybook-setup.md](storybook-setup.md).

### Comparing two settings

Keep the code the same and change one option between the two runs, for
example `--theme`, `--width`, `--args`, `--globals`, `--clock` or
`--motion`. The caption on each diff image names the settings that differ.

### Finding where a component appears

```bash
sbshot capture . --name-run buttons \
  --highlight '.ant-btn-group' --crop '.ant-btn-group'
```

For each story and theme this writes:

- `<id>.png`, the normal shot.
- `<id>--highlight.png`, with every match outlined in red.
- `crops/<id>--<n>.png`, one image per match.
- `crops.png`, a contact sheet of every crop, labelled with its story.

A story whose notes say `0 cropped` does not render the component.

## Choosing what to shoot

`sbshot capture <storybook>` accepts three kinds of source:

| Source | What happens |
| --- | --- |
| `http://host:port` | shoots a running Storybook (dev server or static host). With no source, `http://localhost:6006` |
| a build directory | any directory with `index.json`, served on a free local port for the run |
| a project | a directory with `.storybook/`. Built with `storybook build --stats-json` into `.sbshot/builds/<run>`, then served |

Prefer a build or a project over a dev server for more than a few stories. A
dev server compiles each module on its first visit, so the first stories are
slow and can be flaky. It also follows your working tree, so the two runs of
a comparison can drift apart. A build is a fixed snapshot.

Each project capture makes a new build. When the code has not changed since
the last one, pass that build (`.sbshot/builds/<run>`) and skip the rebuild.

To pick stories:

| Option | Selects |
| --- | --- |
| `--stories <match>` | stories whose id or `Title/Name` contains `<match>`. Repeatable, comma-separated |
| `--title <prefix>` | stories whose title starts with `<prefix>`, for example `Pages/` |
| `--name <match>` | stories whose name contains `<match>` |
| `--theme dark,light` | shoot every story once per theme |
| `--changed-since <ref>` | only stories a git change reaches (see above) |

`sbshot list <storybook>` with the same options prints the stories a capture
would shoot, without shooting them.

`sbshot modes <storybook>` prints what the preview can be shot in: its
toolbar globals with their values and defaults (the values of `theme` are
what `--theme` takes), the project's Chromatic modes, and whether the
preview reads the frozen clock. `--json` gives the same as data.

`sbshot modes <storybook>` prints what the preview can be shot in: each
toolbar global with its values, its default (`*`) and the flag that sets it,
the project's Chromatic modes, and whether the preview reads `?storyClock`.
`--theme` values must be items of the `theme` global; a global with another
name is set with `--globals`. `--json` prints the same as data.

```
$ sbshot modes .sbshot/builds/baseline
globals (* = default)
  theme   dark* light          --theme    SigNoz color scheme
  motion  still* live          --motion   Park every animation on its last frame once the story has settled.
chromatic modes
  dark   theme:dark 1680x1200
  light  theme:light 1680x1200
clock: the preview reads ?storyClock, --clock works
settle hook: none
```

## Capture options

`sbshot capture --help` lists every option. These are the ones you will use
most.

### Output

| Option | Meaning |
| --- | --- |
| `--name-run <name>` | name of the run (default: a timestamp): letters, digits and `. _ -`, not starting with a dot, and not `latest` |
| `-o, --out <dir>` | write the run to this directory instead |
| `--force` | replace an existing run with the same name. A directory that is not a run is never replaced |
| `--flat` | `<id>.png` instead of `<theme>/<id>.png` |
| `--no-caption` | do not add the caption band with the story name and settings |

### The page

| Option | Meaning |
| --- | --- |
| `--width <px>` | viewport width (default 1680) |
| `--height <px>` | minimum viewport height (default 1200) |
| `--max-height <px>` | maximum viewport height (default 8000) |
| `--grow <mode>` | `scrollers` (default): grow the viewport until the tallest inner scroll area fits, so a long table is shot whole. `document`: follow the page height only. `none`: keep `--height` |
| `--settle <ms>` | extra wait after the page goes quiet (default 300) |
| `--args <k:v;k2:v2>` | story arg overrides, in Storybook's `?args=` syntax |
| `--globals <k:v;..>` | extra Storybook globals |
| `--clock <iso\|live>` | the date passed to the preview (default `2026-06-15T12:00:00.000Z`) |
| `--motion` | let animations and transitions run |
| `--ignore <selector>` | hide matching elements before the shot |

Use the same page options on both runs of a comparison, or the screenshots
will not line up.

### Speed

sbshot opens more pages while the CPU stays under 75% and memory is free, and
closes some past 90%. `--jobs <n>` sets a maximum.

When an earlier run of the same stories exists, sbshot uses it to shoot the
slowest stories first, so one long story does not hold up the end.
`--history <run>` picks that run, `--history none` turns it off.

## Following a long run

A full run can take several minutes. Start it in the background and open the
viewer:

```bash
sbshot capture . --name-run after --ui --notify &
sbshot status after --wait
```

- `--ui` opens the viewer on the run. It reuses a viewer that is already
  running for the workspace, or starts one.
- `--notify` shows a desktop notification when the run ends (`notify-send`
  on Linux, `osascript` on macOS).

`sbshot status [run]` prints the progress, the ETA, the stories in progress
and any failures.

| Option | Meaning |
| --- | --- |
| `--watch` | print a progress line every few seconds until the run ends |
| `--wait` | print nothing until the run ends, then the summary |
| `--json` | the same information as JSON |

The capture itself prints a progress line every 20 seconds, plus stories that
failed, were retried or were busy. `--verbose` prints every shot.

### The ETA

The ETA prices each remaining story by how long it took in the earlier run,
adjusted by how fast this run is going. With an earlier run it is usually
within 15% after ten seconds. A first run has nothing to compare against, so
its ETA is marked `rough` and tends to be too short.

### How a run ends

A run ends as `done`, `interrupted` or `failed`, with its counts.

- A story that fails is retried once. Only a second failure counts.
- A `busy` story never rendered the same frame twice in a row. Its diff may
  be noise.
- Ctrl-C keeps what was already shot and marks the run `interrupted`.

## Diff

```bash
sbshot diff before after
sbshot diff before after --mode red --top 20
sbshot diff before after --noise before--floor --fail-over 500
```

Screenshots are paired by their path inside the run. The output lists each
changed pair as `<changed pixels> <percent> <file>`, largest first. A story
that exists in only one run is reported as `missing previous` or
`missing current`.

| Option | Meaning |
| --- | --- |
| `--mode green` | changed pixels painted over the after shot (default) |
| `--mode red` | after shot faded, changed pixels in red. Good for thin edges |
| `--mode green-parallel`, `--mode red-parallel` | before, after and diff side by side in one image |
| `--threshold <0..1>` | how far a pixel's colour must move to count (default 0.063) |
| `--include-aa` | count antialiasing changes too |
| `--noise <diff>` | mark pairs that moved in that diff as flaky |
| `--fail-over <px>` | exit 1 when a pair that is not flaky changed more pixels than this |
| `--top <n>` | print only the `n` largest changes |
| `--ui` | open the viewer on this diff |

The caption band is removed before comparing, so runs with different
settings still compare on the page alone. Running a diff again with
`--force` keeps the verdicts you already set.

## The viewer

```bash
sbshot ui --open
```

The viewer runs on `http://127.0.0.1:7007` (change it with `--port` or
`SBSHOT_PORT`; if the port is busy it picks a free one). It only listens on
localhost unless `--host` says otherwise. It has no login, so `--host` with a
network address lets anyone who reaches the port see every shot, set verdicts
and start diffs; the command warns when it does.

- The home page lists runs and diffs, and can start a diff between any two
  runs.
- A run's page shows progress, ETA, CPU use, the stories in progress,
  failures, the slowest stories, and the shots as they arrive. Filter by
  status, theme or text, and click a shot to see it full size. With a shot
  open, `j` / `k` or the left and right arrows step through the shots the
  grid shows, in its order, and `y` copies the shot as a PNG (caption band
  included).
- A diff's page lists the changed pairs, largest first, and shows the
  selected one.
- The copy image button (`y`) puts the view as it is on screen in the
  clipboard, at the shots' own resolution: the mode, the change box, the
  swipe line and the onion opacity. Blink has no still image, so its button
  saves a looping GIF of the two frames instead. Without a clipboard (plain
  http off localhost) the PNG is downloaded.

Keys on a diff's page:

| Key | Action |
| --- | --- |
| `j` / `k`, arrow keys | next / previous pair |
| `1` to `6` | diff, side by side, before/after/diff, swipe, onion skin, blink |
| `e` / `r` / `f` | mark expected / regression / flaky |
| `c` | clear the verdict |
| `b` | show or hide the box around the change |
| `z` | scroll to the change |
| `a` | actual size |
| `h` | zoom 2.5x around the mouse |
| `y` | copy the view as a PNG (blink saves a GIF) |

## Sharing a diff

`sbshot export` writes finished diffs and runs as a static site: the viewer,
read-only, with the images it needs. Put the folder on any static host
(Cloudflare Pages, GitHub Pages, S3) and send the link, for example from a
pull request.

```bash
sbshot export before--after                        # <workspace>/exports/before--after/
sbshot export before--after --out site/            # somewhere else
sbshot export before--after other--diff --zip      # several diffs, as one zip
sbshot export before--after --runs                 # plus every shot of both runs
```

By default a diff keeps only its changed and missing pairs and the shots those
pairs need. `--all` keeps the identical pairs too, and `--runs` adds the two
runs it compared as pages of their own. With one diff the page opens on it.

Shots go out as lossless WebP: the same pixels at about a third of the PNG
size. A shot taller or wider than 16383 pixels, which WebP cannot hold, stays
PNG. `--png` keeps every shot as PNG, and so does an ImageMagick built without
WebP. Runs and diffs in the workspace stay PNG either way: the diff reads PNG
directly, and older baselines keep pairing.
Verdicts already set show up, and cannot be changed.

The export holds no local paths: directories become their place in the site,
and a storybook path its last segment. `--out` only replaces a folder that is
empty or an earlier export, and `--zip` only a file that is an earlier export.
Only files inside each job go in: a path in `shots.json` or `diff.json` that
leads out of its job, and a diff whose runs are not runs, stop the export.

In the viewer, tick runs and diffs on the home page and press Download zip,
or use the link on a diff's page. The zip holds one folder with the site in it.

## Review from the terminal

Verdicts set in the viewer are saved in `review.json` next to the diff. The
CLI reads and writes the same file:

```bash
sbshot review before--after                 # list verdict, pixels, file
sbshot review before--after --json
sbshot review before--after dark/<id>.png regression "button lost its border"
```

## Tags

A tag groups pairs of a diff under a name, with an optional note. The viewer's
diff page filters by it, so whoever read the diff (often an agent) hands over a
tag instead of a list of files to search for.

```bash
sbshot tag before--after fixed pages-home--default 'pages-settings-*' --note "border is back"
sbshot tag before--after flake dark/pages-noz--default.png
sbshot tag before--after fixed --theme dark pages-home--hover   # one theme only
sbshot tag before--after dark 'dark/*'                          # a tag per mode
sbshot tag before--after fixed,menu pages-home--menu            # several tags at once
sbshot tag before--after fixed --remove pages-home--default     # untag
sbshot tag before--after fixed --remove                         # drop the tag
sbshot tag before--after                                        # list tags
```

A pair is named by its file, by its story id (every theme of it), or by either
with `*` wildcards. A pattern that names no pair fails the command, and nothing
is written. Commas separate tags: the pairs go on every tag named, `--note`
sets the note of each, and `--remove` takes them off each.

The viewer's diff page lists the tags above the pairs. Click one to pick it,
click more to narrow: the list keeps the pairs that hold every tag picked, so
`fixed` and `dark` together is the fix in the dark theme. Open
`#/job/diff/<diff>?tag=<tag>,<tag>` to land on that list. Picking the first
tag shows the identical pairs too. The viewer picks up new tags when its tab
gets focus again.

A tag per mode (`dark` on `dark/*`, `light` on `light/*`) is what makes that
work: tag the modes, tag the causes, and any mode of any cause is one link.

## Managing the workspace

| Command | What it does |
| --- | --- |
| `sbshot runs` | list every run and diff, newest first |
| `sbshot rm <job>...` | delete runs or diffs, and the builds a run made. A running job is refused |
| `sbshot link <dir> [name]` | add one run or diff from another directory, as a link |
| `sbshot init [source]` | link every run and diff found under `source` (default `./.story-shots` if it exists) |

`init` and `link` never move files. A directory with `shots.json` becomes a
run, and one with `diff.json` a diff, named after its path
(`tokens-before/s00` becomes `tokens-before-s00`). `sbshot rm` on a linked
job only removes the link. Run `init` again to pick up new results.

## Exit codes

| Command | Exits 1 when |
| --- | --- |
| `capture` | the run did not finish, a story failed twice, no story matched (unless `--changed-since` reached none), or `--fail-on-busy` is set and a story was busy |
| `diff` | the diff failed, or `--fail-over` is set and a pair that is not flaky changed more |
| `status --wait` | the job ended as anything other than `done` |
| any | an option is invalid or a named job does not exist |

## Environment variables

| Variable | Meaning |
| --- | --- |
| `SBSHOT_WORKSPACE` | default workspace directory (default `./.sbshot`) |
| `SBSHOT_PORT` | default viewer port (7007) |
| `SB_PORT` | dev server port when `capture` gets no source (6006) |
| `CHROME_PATH` | browser binary to use instead of Playwright's Chromium |
| `PLAYWRIGHT_MODULE` | Playwright module to load instead of the bundled one |
| `MAGICK_THREAD_LIMIT` | ImageMagick threads per process (sbshot sets 1 during capture and diff) |

## Troubleshooting

- The browser does not start. Run `npx playwright install chromium`, or set
  `CHROME_PATH` to a Chrome or Chromium binary.
- `sbshot diff` refuses to run. Install ImageMagick and check that `magick`
  or `convert` is on your `PATH`.
- The wrong stories are shot from a dev server. Port 6006 may be another
  project's Storybook. Open `http://localhost:6006/index.json` and check the
  ids.
- Two `storybook dev` servers on the same project fail with
  `Invalid hook call`. They share a Vite cache. Use a build instead.
- A diff reports zero changed pixels. That is a real result. To check the
  setup, diff a run against itself: every pair must be `same`.
- Stories differ between two runs of the same code. Measure the
  [noise floor](#measuring-the-noise-floor), then fix the stories with
  [storybook-setup.md](storybook-setup.md).
