---
name: sbshot
description: Screenshot Storybook stories with the sbshot CLI, pixel-diff two runs, and hand the human a live viewer with progress, ETA, and a before/after compare. Use when asked to capture story screenshots, take a visual baseline, compare before and after a CSS or component change, compare two branches or two configurations, measure the noise floor, survey where a component appears, check on a capture that is already running, or point the human at specific pairs of a diff (always with `sbshot tag`, never a pasted list).
---

# sbshot

`sbshot` shoots Storybook stories with Playwright, diffs two runs the way
Chromatic does (YIQ distance, antialiasing ignored, threshold 0.063), and
records everything it does as events a viewer can follow live.

The CLI is on `PATH` as `sbshot` (`npm install -g @signozhq/sbshot`; the package
README covers the rest of the install). `sbshot <command> --help` lists every
flag. The package's `docs/` directory, next to this skill's `skills/`
directory (`$(npm root -g)/@signozhq/sbshot/docs` for a global install), has
`usage.md` for every workflow, `files.md` for the fields of `shots.json`,
`diff.json` and `events.ndjson`, and `storybook-setup.md` for what a preview
can do to make its shots reproducible.

## Where things go

Everything lives in a workspace, `./.sbshot` by default (`--workspace` or
`$SBSHOT_WORKSPACE` to change it). Run the commands from the same directory
each time, or pass the same `--workspace`, or runs will not find each other.

```
.sbshot/runs/<name>/     <theme>/<story-id>.png, shots.json, events.ndjson, sbshot.json
.sbshot/diffs/<name>/    <theme>/<story-id>.png, diff.json, review.json, tags.json, events.ndjson
.sbshot/builds/<name>/   storybook builds made by `capture <project>`
```

Refer to runs by name (`baseline`, `after`), by path, or as `latest`.

Results made before sbshot, such as the `.story-shots` folder the
story-shots scripts write, join the workspace with `sbshot init [source]`;
`./.story-shots` is the default source when it exists. Every directory holding `shots.json` gets a link in
`.sbshot/runs/` named after its path (`tokens-before/s00` becomes
`tokens-before-s00`). Nothing moves. Old diff directories have no `diff.json`,
so they are skipped; redo them with `sbshot diff <a> <b>`. To add a single
directory to an existing workspace instead, use `sbshot link <dir> [name]`.

## 1. Settle what is being compared

A diff only means something when the two runs straddle a change, and a wide
sweep in the wrong themes burns several minutes. So before shooting, find out
what this storybook can be shot in, then settle the job, the stories and the
modes with the human in one question.

### Look first

Do these reads before asking anything. They are cheap, they run in parallel,
and they turn the question into concrete options instead of open-ended ones.

- **Where the stories come from.** A `.storybook/` in the current directory or
  a `frontend/` below it, a build already in `.sbshot/builds/` (check its
  mtime against `git log -1` and the dirty files: a build older than the tree
  shoots the old code), and whatever answers `index.json` on 6006 and 6007.
  `sbshot list <project>` builds the project first, so run `list` against a
  build or a URL when one is there.
  **Verify a running server belongs to this project before shooting it, every
  time.** A listener on 6006 or 6007 is often another repo's storybook (a
  component library's docs, a sibling checkout). Find its owner: `ps aux |
  grep storybook` and `readlink /proc/$(lsof -ti :<port>)/cwd`, or the paths in
  its process args. It must sit under the current project. Also check that
  `index.json` holds this project's story titles and ids. When either check
  fails, ignore the server and capture the project (`sbshot capture <project>`)
  or a build. Never assume a URL is right because it answers.
- **The modes the preview offers.** `sbshot modes <storybook>` loads the
  preview and prints its toolbar globals with their values and defaults
  (`*`), the flag that sets each, the project's Chromatic modes with their
  widths, and whether anything reads `?storyClock`. `--json` for the same as
  data. It takes a URL, a build, or a project with a build in the workspace,
  and takes about a second.
  - The `theme` values are what `--theme` can take. A theme global under
    another name needs `--globals <name>:<value>`, one run per value. With no
    theme global, `--theme` changes nothing: do not ask about themes.
  - A `motion` global means `--motion` does something. Other globals (locale,
    density, brand) are modes too, and run at their default unless the human
    picks otherwise.
  - Chromatic modes are the combinations the team already treats as
    canonical. Offer them as the recommended answer and match `--width`.
  - `nothing reads ?storyClock` means dates and "5 min ago" labels move
    between runs: say so up front.
- **The stories.** Group `index.json` entries by the first segment or two of
  their title and count them, so the scope options carry numbers
  (`Pages/ (212)`, `Components/Button (8)`). When the branch has changes and a
  build with `preview-stats.json` exists, count what `--changed-since
  $(git merge-base HEAD main)` reaches too.
- **The git state.** Current branch, its base, whether the tree is dirty and
  what the diff touches. A dirty tree or a branch ahead of `main` usually
  answers the job without asking. A diff into the preview, a global stylesheet,
  tokens or a lockfile reaches every story: `--changed-since` says so, and the
  scope question should not offer it.
- **What the workspace already has.** `ls .sbshot/runs` and `sbshot status
  <run>`. A finished `baseline` with the same flags may make half the job
  unnecessary, and its durations price the options: a run of the same stories
  sets the ETA, so a scope option can say `about 6 min`.

### Ask once

Put what is still open into one `AskUserQuestion` call. Whatever the prompt
already says, take it and do not ask again. Skip the call when the prompt
answers everything ("shoot the pods tooltips in both themes" needs no
question). When the prompt says nothing at all, ask: a silent guess is the
expensive mistake.

| Question | Options |
| --- | --- |
| Job | read off the git state: the most likely one first, marked `(Recommended)`, from the table below |
| Scope | 2 or 3 selections with story counts and, from history, a time: the stories the change reaches, a `--title` prefix, everything. Never open-ended |
| Modes | the project's Chromatic modes if it has them, else the theme items: the default theme alone, or every theme. When the preview has more than two themes, or other toolbar globals the change might touch, make it `multiSelect` |
| Read-out | `green`, `green-parallel`, `red-parallel`, or `none` (keep both runs, no diff). Skip it for shoot only and for a survey |

Put the cost in each option's description (`212 stories x 2 themes, about
9 min`), so the human trades scope against time knowingly. Dark alone is enough
while iterating; offer both themes for the run that gets reported.

After the answer, print the plan in a few lines: each run's name and the exact
`sbshot` command, with the page flags both sides share. Then start it. Do not
ask a second time.

| Job | Runs |
| --- | --- |
| shoot only | one capture, report the path |
| baseline for a change about to be made | capture `baseline`, stop, hand back |
| change already in the tree | capture `after` on the tree, then check out the base, capture `baseline`, restore the tree |
| branch against branch | capture on this branch, `git switch` to the base, capture again, switch back |
| noise floor | the same tree twice, diffed: what moves is the harness, not the change |
| configuration against configuration | same tree, runs differing only in `--args`, `--clock`, `--width`, `--theme`, `--motion` |
| usage survey | one capture with `--highlight` and `--crop`, no diff |

Never `git stash` to swap trees. Commit the work in progress as a wip commit
and check out the other side instead.

## 2. Capture

`<storybook>` is a URL, a storybook build directory (it has `index.json`), or a
project with `.storybook/`, which is built first (`storybook build
--stats-json`) into the workspace. Prefer a build for anything wider than a
handful of stories: nothing is transformed on first visit, and a build is a
snapshot of the tree, so it cannot go stale between the two sides.

```bash
# build the project and shoot every Pages/ story in both themes
sbshot capture ./frontend --name-run baseline --title Pages/ --theme dark,light

# reuse that build for a second run
sbshot capture .sbshot/builds/baseline --name-run floor --title Pages/ --theme dark,light

# a few stories off a running dev server
sbshot capture http://localhost:6006 --name-run quick --stories pages-home,dashboards/detail
```

Each project capture makes its own build. When the tree has not changed since,
pass that build's path instead (`.sbshot/builds/<run>`) and skip the rebuild.
The viewer shows a build's progress against the last build's time.

`sbshot list <storybook> <filters>` prints what a capture would shoot.
`sbshot rm <run>...` deletes runs or diffs, and the builds they made.

Selection: `--stories <match>` (id or `Title/Name` substring, comma-separated),
`--title <prefix>`, `--name <match>`, `--theme dark,light`,
`--changed-since <ref>` (only stories whose module graph holds a changed file;
needs a build), `--changed-global <glob>` (a file whose change reshoots every
story, relative to the project; repeatable).

Page: `--width` (1680, the only fixed dimension), `--height` (1200, the
shortest the viewport may be), `--grow scrollers|document|none`, `--settle`,
`--clock <iso|live>`, `--motion`, `--args k:v;k2:v2`, `--globals k:v`,
`--ignore <selector>`, `--highlight <selector>`, `--crop <selector>`.

Keep every page flag identical between the two sides of a comparison, or the
pairs do not line up.

### Runs take minutes: run them in the background

A full sweep takes several minutes. Do not block on it and do not `sleep`.
Start it in the background, give the human the viewer, and wait with
`status --wait`, which exits when the run ends:

```bash
sbshot capture <storybook> --name-run after --title Pages/ --theme dark,light --ui --notify
# in a background shell:
sbshot status after --wait
```

`--ui` starts the workspace viewer if none is running (or reuses it) and prints
its URL. Give that URL to the human: it shows the percent done, the ETA and the
time it finishes, every story in flight with its phase and how long it has
run, the shots as they land, failures and retries, and the slowest stories.
`--notify` sends a desktop notification at the end.

To check on a run without waiting: `sbshot status <run>` (one screen) or
`sbshot status <run> --json` (counts, estimate, active and failed stories).
The terminal output of a capture is short on purpose: a progress line every
20 s, plus busy, failed and retried stories. `--verbose` prints every shot.

### The ETA

The estimate is priced by an earlier run of the same stories (the most recent
finished run that covers at least half of them, or `--history <run>`), which
also sets the queue slowest first. With that history it is usually within
15% after the first ten seconds. A first run has no history: its estimate is
marked `(rough)` and runs short. So the second run of a pair is the one
worth quoting a time for.

### What a run reports

It ends with `done|interrupted|failed: N/M stories shot in T: ok, busy,
failed, retried`. A story that fails is retried once; only a second failure
counts. A `busy` story never held still for two identical frames: treat its
diff as suspect. `shots.json` records each shot's id, theme, status,
duration, size and caption height.

Stopping a run (Ctrl-C, SIGTERM) keeps what was shot and marks the run
`interrupted`. A run whose process died shows as `interrupted` too.

## 3. Diff

```bash
sbshot diff baseline after                          # -> .sbshot/diffs/baseline--after
sbshot diff baseline after --noise baseline--floor  # mark the noise-floor movers as flaky
sbshot diff baseline after --mode green-parallel --top 20
```

It prints `<changed px> <percent> <theme>/<story>.png`, largest first, and
writes one image per changed pair. A story present on one side only is
reported as `missing previous` or `missing current` and counts in full.

| Flag | Meaning |
| --- | --- |
| `--mode green` | changed pixels painted over the after shot (default, Chromatic's look) |
| `--mode red` | the after shot faded, changed pixels in red: best for thin edges |
| `--mode green-parallel`, `red-parallel` | before, after and diff in one labelled image |
| `--threshold 0.063` | YIQ distance a pixel must move to count |
| `--include-aa` | count antialiasing changes too |
| `--noise <diff>` | pairs that moved in that diff are flagged `flaky` |
| `--fail-over <px>` | exit 1 when a non-flaky pair moved more than that |
| `--ui` | open the viewer on this diff |

`diff.json` holds every pair: `changed`, `ratio`, `box` (where the change is,
in shot pixels), `flaky`, `note`, and the caption heights. Read the images of
the largest non-flaky movers before concluding anything.

Then tag what you found (section 4) before reporting. Every diff you read ends
with tags, even a diff with one group of pairs.

## 4. Review with the human

### Tag every pair you want looked at

Whenever you point the human at pairs of a diff, tag them. Never hand over a
list of story ids or files to search for in the viewer: that list is what tags
replace. This holds for your own read-out of a diff, for an answer to "what
should I look at", and for any follow-up that names pairs.

- One tag per group of pairs that share a cause or a question, with a
  `--note` that says what to check. Short kebab-case names: `fixed-border`,
  `regression-padding`, `unrelated-flake`, `new-story`.
- Tag the pairs that need no action too (flakes, unrelated movers), so the
  human can clear them in one pass.
- When the diff holds more than one mode, also give each mode a tag of its
  own that holds every pair of that mode: `dark` on `dark/*`, `light` on
  `light/*`. Name it the way the human names the mode (`dark`, `noite`,
  `dark-mobile`); the theme directory is only the default. The viewer shows
  the pairs holding every tag picked, so `fixed-border,dark` is the fix in
  the dark theme alone, which is often all the human wants to check.
- Report one line per cause tag: name, pair count, note, and its link
  `<viewer>/#/job/diff/<diff>?tag=<tag>`. List the mode tags once below it,
  with one combined link as the example (`?tag=fixed-border,dark`). Start the
  viewer (`sbshot ui`) if none is running. That table is the report; do not
  list the pairs as well.

```bash
sbshot tag baseline--after fixed-border pages-home--default 'pages-settings-*' --note "border is back"
sbshot tag baseline--after flake --theme light pages-noz--default --note "capture flake, confirm dialog opened"
sbshot tag baseline--after dark 'dark/*' --note "dark theme"            # one tag per mode
sbshot tag baseline--after light 'light/*' --note "light theme"
sbshot tag baseline--after fixed-border,new-story pages-home--empty     # several tags at once
sbshot tag baseline--after fixed-border --remove pages-home--default   # untag one
sbshot tag baseline--after                                              # list tags
```

A pair is a file (`dark/<id>.png`), a story id (every theme), or a `*` glob.
A pattern that matches nothing fails and writes nothing, so a typo shows up.
Commas separate tags, and each tag named gets the pairs (and the `--note`).
Picking tags in the viewer shows the pairs that hold all of them, identical
ones too, and the viewer picks up new tags when its tab regains focus. Tags live in
`tags.json` and survive a `diff --force` rerun.

### Verdicts

The viewer's diff page has side by side, before/after/diff, swipe, onion skin
and blink, a box around the changed region, and a jump to it. The human marks
each pair `expected`, `regression` or `flaky` (keys `e`, `r`, `f`). Read what
they decided:

```bash
sbshot review baseline--after           # verdict, pixels, file
sbshot review baseline--after --json
sbshot review baseline--after dark/<id>.png regression "button lost its border"
```

Verdicts live in `review.json` and survive a `diff --force` rerun.

To share a diff with someone who has no viewer (a pull request, a reviewer
elsewhere), write it as a static site and host the folder anywhere:

```bash
sbshot export baseline--after --out <dir>     # add --runs for every shot of both runs
```

## 5. Surveying a component

```bash
sbshot capture <build> --name-run buttons --theme dark,light \
  --highlight '.ant-btn-group' --crop '.ant-btn-group' --stories <ids>
```

Per theme: `<id>.png`, `<id>--highlight.png` (every match ringed in red),
`crops/<id>--<n>.png` and `crops.png`, a contact sheet of every crop. A story
whose notes say `0 cropped` never reaches the state: pick another story.

## What makes a shot reproducible

- Readiness is Storybook's own render phase (`finished`, after loaders,
  decorators and `play`), then no request for 600 ms and no visible
  `aria-busy`, fonts loaded, two animation frames, `--settle` ms, then two
  identical frames in a row.
- The clock is passed as `?storyClock` (frozen by default). A preview that
  reads it shoots every story at the same instant.
- `[data-shot-ignore]`, `[data-chromatic="ignore"]` and `--ignore` hide what
  cannot be held still.
- A page that sizes itself in `vh` grows with the viewport and is shot at
  `--height` (`stopped chasing` in the notes). Pin such a story's viewport
  instead: `parameters: { sbshot: { viewport: { height: 1725 } } }`
  (`storyShots` is read too).
- A preview can expose `window.__sbshotSettle()` to settle what only it can
  see (a virtualised list still measuring). It runs before the stable-frame
  check.

## Gotchas

- Pointing the human at pairs without tagging them sends them searching the
  viewer by hand. Tag first, then give the links.
- Port 6006 is often another project's storybook. Check the server's process
  path is under this project and `index.json` holds the ids you expect before
  shooting a dev server. A wrong one shows up as mass `page.goto` timeouts too.
- Two `storybook dev` servers on the same config share a Vite cache and die
  with `Invalid hook call`. Use a build.
- Zero changed pixels is a real answer, not a broken capture.
- A diff of a tree against itself is the noise floor. Diff a story against
  itself before believing its number.
- ImageMagick is needed for captions and diff images. Without it shots are
  written bare and `diff` refuses to run.
- Playwright comes with sbshot. If no browser starts, run
  `npx playwright install chromium` in the sbshot checkout or set
  `CHROME_PATH`.
