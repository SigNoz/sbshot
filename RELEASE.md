# Release

`@signozhq/sbshot` is released with [Release Please](https://github.com/googleapis/release-please) and published to npm by the [`release`](./.github/workflows/release.yml) workflow through npm trusted publishing.

The source of truth for the current version is `.release-please-manifest.json`. Never edit `version` in `package.json` by hand, Release Please writes it for you.

## How does a release work?

- open a PR with your change
- the PR title must follow [Conventional Commits](#commit-messages)
- merge it into `main` (this does not release anything)
- Release Please opens or updates a draft `Release PR` with the version bump and the changelog
- once there is enough in it for a release, mark the `Release PR` as ready for review, get it approved and merge it

Take a look at [What's a Release PR](https://github.com/googleapis/release-please#whats-a-release-pr) to learn more about this process.

The `Release PR` is opened with the workflow's `GITHUB_TOKEN`, and GitHub does not run other workflows on a PR opened that way, so `jsci` does not run on it. It only changes `package.json`, `CHANGELOG.md` and `.release-please-manifest.json`, and every commit it contains already passed CI on its own PR.

## Commit messages

`main` only accepts squash merges, and the **PR title becomes the commit message**, so the PR title has to be conventional. That title is what Release Please reads.

These are the types configured in `release-please-config.json` and the changelog section each one lands in:

| Type       | Changelog section        |
|------------|--------------------------|
| `feat`     | Features                 |
| `fix`      | Bug Fixes                |
| `perf`     | Performance Improvements |
| `revert`   | Reverts                  |
| `docs`     | Documentation            |
| `style`    | Styles                   |
| `chore`    | Miscellaneous Chores     |
| `refactor` | Code Refactoring         |
| `test`     | Tests                    |
| `build`    | Build System             |
| `ci`       | Continuous Integration   |

Every type in the table has a visible changelog section, so a commit of any of them opens or updates the `Release PR`. A type outside the table (or a non-conventional title) is left out of the changelog and does not cause a release.

To flag a breaking change, add a `!` after the type/scope or a `BREAKING CHANGE:` footer:

```
feat(capture)!: drop the `--legacy-names` flag
```

## Versioning

Plain semver:

| Commit          | Bump  | Example           |
| --------------- | ----- | ----------------- |
| `fix:`          | patch | `1.0.0 → 1.0.1`   |
| `feat:`         | minor | `1.0.0 → 1.1.0`   |
| breaking change | major | `1.0.0 → 2.0.0`   |

## What happens after the `Release PR` is merged

The `release` workflow runs on every push to `main`. When Release Please reports that a release was created, it:

1. tags the commit as `vX.Y.Z` and creates the matching GitHub Release
2. publishes the package with `npm publish` from a fresh checkout, in a separate job

There is no build step, the package is the files listed in `files` in `package.json`. Check what goes in with `pnpm run publint` or `npm pack --dry-run`.

Publishing uses npm provenance (`NPM_CONFIG_PROVENANCE: true`) and authenticates through npm trusted publishing via OIDC (`id-token: write`), there is no npm token stored anywhere. Only the publish job gets `id-token: write`, and only the Release Please job can write to the repo.

The workflow uses a `release` concurrency group with `cancel-in-progress: false`, so releases queue up instead of cancelling each other.

## Verifying a release

After the workflow finishes:

```sh
npm view @signozhq/sbshot version
```

It should match `.release-please-manifest.json` and the `vX.Y.Z` git tag. The npm page should also show the provenance badge.

## Configuring trusted publishing

On npmjs.com, go to the package → **Settings** → **Trusted Publisher**, pick **GitHub Actions**, and fill in:

| Field             | Value         |
| ----------------- | ------------- |
| Organization      | `SigNoz`      |
| Repository        | `sbshot`      |
| Workflow filename | `release.yml` |
| Environment       | leave empty   |

Leave the environment empty because the publish job does not use a GitHub environment. If that changes, or the workflow file is renamed, the trusted publisher has to be updated to match, or publishing fails with an auth error.

You need admin rights on the package (or on the `@signozhq` org) to change this setting.

The repo (or the `SigNoz` org) must also allow GitHub Actions to open pull requests: **Settings** → **Actions** → **General** → **Allow GitHub Actions to create and approve pull requests**. Without it, Release Please fails when it tries to open the `Release PR`.

## The first release

npm only lets you configure a trusted publisher on a package that already exists, so `1.0.0` is published by hand once, by someone with publish rights on the `@signozhq` scope:

1. on an up to date `main`, check the package with `pnpm run publint` and `npm pack --dry-run`
2. `npm login`, then `npm publish` (provenance is only available from CI, so this one release has none)
3. configure the [trusted publisher](#configuring-trusted-publishing)
4. create the `v1.0.0` GitHub Release on the commit you published, so Release Please knows where `1.0.0` is:

   ```sh
   gh release create v1.0.0 --repo SigNoz/sbshot --target <sha> --title v1.0.0 --notes "First release."
   ```

Every later release goes through the workflow.

If the `release` workflow runs on `main` before the `v1.0.0` release exists, Release Please cannot find where `1.0.0` was cut and opens a `Release PR` for `1.1.0` with the whole history in it. Do not merge it. Once the `v1.0.0` release exists, the next push to `main` rewrites that PR.

## Pitfalls

### Closing the `Release PR` without merging it

Release Please tracks the open `Release PR` through its branch and its labels, so closing the PR is not enough. You also have to delete the `release-please--branches--main--components--sbshot` branch, and sometimes remove the `autorelease: pending` label from the closed PR. Otherwise Release Please cannot tell whether it should open a new `Release PR` or update the existing one, and the next push to `main` leaves you with no `Release PR` at all.

### The `release` workflow failing

Prefer releasing forward over retrying the same version. Retrying the same tag means undoing everything the failed run created, the `Release PR`, its labels, and the `vX.Y.Z` tag, and it is easy to leave the `Release PR` in a state Release Please cannot recover from.

Fix the cause in a PR with a conventional title (`fix:` or `ci:`), merge it, and merge the `Release PR` it produces.

## Limitations

- There are no prereleases (`prerelease: false`) and no hotfix flow, everything ships from `main`.
