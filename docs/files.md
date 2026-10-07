# Files sbshot writes

Everything is plain files next to the images. A run or diff directory is
self-contained: copy it or link it into another workspace and it still
reads. Scripts and agents can read any of these directly; the CLI's own
`--json` outputs (`status`, `runs`, `review`) are the stable way to ask.

## Workspace layout

```
<workspace>/
  runs/<name>/          a capture
  diffs/<name>/         a diff
  builds/<name>/        a storybook build made by `capture <project>`
  builds/<name>.log     that build's output
  ui.json               the running viewer: pid, url, start time
  ui.lock               while a --ui command starts the viewer
  ui.log                output of a viewer started by --ui
  exports/<name>/       a static site written by `sbshot export`
  .cache/thumbs/        the viewer's JPEG thumbnails, safe to delete
```

An entry of `runs/` or `diffs/` may be a symlink (`init`, `link`).

## A run

```
runs/<name>/
  <theme>/<story-id>.png                  one shot per story and theme
  <theme>/<story-id>--highlight.png       with --highlight
  <theme>/crops/<story-id>--<n>.png       with --crop
  <theme>/crops.png                       with --crop: contact sheet
  shots.json
  sbshot.json
  events.ndjson
```

With `--flat` the `<theme>/` level is dropped. A run without `--theme` uses
`default` as its theme directory.

### shots.json

Written when the run ends. `config` holds the page settings, which the diff
compares between runs; `shots` has one entry per image, sorted by file.

```json
{
	"config": {
		"args": "", "clock": "2026-06-15T12:00:00.000Z", "width": "1680",
		"height": "1200", "grow": "scrollers", "motion": "still",
		"settle": "300", "ignore": "", "highlight": "", "crop": ""
	},
	"shots": [
		{
			"file": "dark/pages-home--default.png",
			"id": "pages-home--default",
			"title": "Pages/Home",
			"name": "Default",
			"theme": "dark",
			"status": "ok",
			"caption": 138,
			"duration": 5321,
			"width": 1680,
			"height": 1428
		}
	]
}
```

`status` is `ok` or `busy` (never gave two identical frames). `caption` is
the height in pixels of the caption band stamped on top, which a reader
crops off to get the page alone. `duration`, `width` and `height` are only on
a story's main shot, not on its crops or highlight.

A directory with only a `shots.json`, as the older story-shots scripts
wrote, reads as a finished run.

## A diff

```
diffs/<name>/
  <theme>/<story-id>.png          one image per changed or missing pair
  plain/<theme>/<story-id>.png    parallel modes: the diff image alone
  diff.json
  review.json                     verdicts, once there is one
  tags.json                       tags, once there is one
  sbshot.json
  events.ndjson
```

### diff.json

```json
{
	"base": "/abs/path/runs/baseline",
	"after": "/abs/path/runs/after",
	"config": { "mode": "green", "threshold": 0.063, "includeAA": false, "noise": null },
	"summary": {
		"pairs": 196, "changed": 3, "missing": 1, "same": 192,
		"flaky": 0, "duration": 7907
	},
	"results": [
		{
			"file": "dark/pages-home--default.png",
			"changed": 5120,
			"pixels": 2399040,
			"ratio": 0.00213,
			"box": { "x": 120, "y": 640, "width": 300, "height": 40 },
			"output": "dark/pages-home--default.png",
			"outputCaption": 138,
			"baseCaption": 138,
			"afterCaption": 138,
			"width": 1680,
			"height": 1428,
			"flaky": false,
			"duration": 412
		}
	]
}
```

`results` is sorted by `changed`, largest first. `box` is where the changed
pixels are, in page pixels (caption excluded). A pair on one side only has
`note: "missing previous"` or `"missing current"` and `ratio: 1`. An
identical pair has `changed: 0` and no `output`. `summary.error` is set when
the diff failed part way.

### review.json

Keyed by pair file. Written by the viewer and by `sbshot review`.

```json
{
	"dark/pages-home--default.png": {
		"verdict": "regression",
		"note": "button lost its border",
		"at": 1790267227355
	}
}
```

`verdict` is `expected`, `regression` or `flaky`.

### tags.json

Keyed by tag. Written by `sbshot tag`. A pair can carry several tags.

```json
{
	"fixed-under-overlay": {
		"note": "page tooltips now stay under the drawer",
		"files": ["dark/pages-home--default.png", "light/pages-home--default.png"]
	}
}
```

Like `review.json`, it survives a `diff --force` rerun.

## sbshot.json

The job's own record, rewritten as it changes state.

| Field | Meaning |
| --- | --- |
| `kind` | `capture` or `diff` |
| `name` | the job's name |
| `status` | `building`, `running`, `done`, `failed` or `interrupted` |
| `pid`, `host` | the process doing the work. A `running` job whose pid is gone on this host reads as `interrupted` |
| `started`, `ended` | epoch milliseconds |
| `argv`, `cwd` | how it was started |
| `total` | stories or pairs planned |
| `summary` | the counts it ended with |
| `storybook`, `build`, `buildDuration`, `history`, `config` | capture only |
| `base`, `after`, `config` | diff only |

## events.ndjson

One JSON object per line, appended as things happen, each with `t` (epoch
milliseconds) and `type`. It is the only channel between the process doing
the work and whatever watches it, so a crashed run still leaves a record.
`src/progress.mjs` folds it into state; read that file for the exact
fields.

| Type | When |
| --- | --- |
| `build-start`, `build-end` | a project capture's storybook build |
| `log` | a line of build output |
| `start` | the job begins: `total`, `config`, and `items`, every story or pair it will do |
| `begin` | a story goes to a page: `key`, `worker`, `attempt` |
| `phase` | a story moves on: `render`, `loaded`, `settle`, `grow`, `stable`, `write`, `crop`, `highlight` |
| `shot` | a story is shot: `status`, `duration`, `files`, `notes`, `size` |
| `retry`, `fail` | a story failed, first or second time: `error` |
| `pair` | a diff pair is compared: the same fields as its `diff.json` entry |
| `sample` | every 2 s during a capture: CPU, free memory, pages, browsers, ETA |
| `end` | the job ends: `status`, `summary` |

Item keys are `<theme>/<story-id>` in a capture and the pair file in a diff.

## A build

`builds/<name>/` is a regular `storybook build --stats-json` output plus
`sbshot-build.json`, which records the project it was built from so a later
`--changed-since` knows which tree to diff.
