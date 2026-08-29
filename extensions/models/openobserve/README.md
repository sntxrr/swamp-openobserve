# @sntxrr/openobserve

Operate a self-hosted [OpenObserve](https://openobserve.ai) instance from swamp,
and decide **safely** whether a newer upstream release should be rolled out.

Model type: `@sntxrr/openobserve/instance`

## Why this exists

Checking for an OpenObserve update looks like a one-liner. It isn't, for two
reasons that both produce a broken log store rather than a failed check.

**Release candidates share the tag namespace.** On 2026-08-29 the newest tag on
`openobserve/openobserve` was `v1.0.0-rc1`, published *eleven days after* the
newest stable release, `v0.92.2`. Sort the tag list and you pin an RC. That is
tolerable for a stateless web app and not tolerable here: OpenObserve is a log
store, and an RC that migrates the on-disk schema is not undone by re-pinning
the old tag — the old binary can no longer read what the new one wrote. The
rollback is a restore from backup.

**A release and a pushed image are separate events.** Proposing a bump whose
image has not been published yet produces a deploy that fails at
`docker compose pull` — *after* it has stopped the running container.

## Methods

### `check_update`

Reads GitHub **releases**, not tags. Excludes drafts. Excludes prereleases by
the GitHub `prerelease` flag *or* a semver prerelease suffix, because the flag
is hand-set at release time and is occasionally wrong while the suffix is
mechanical. Applies real semver precedence, so `v1.0.0-rc1` sorts *before*
`v1.0.0` rather than after it.

Then it confirms the candidate tag resolves in the registry before reporting
`updateAvailable: true`.

```bash
swamp model @sntxrr/openobserve/instance method run check_update logs \
  --arg currentVersion=v0.92.2
```

| argument | default | notes |
|---|---|---|
| `currentVersion` | ✅ | e.g. `v0.92.2`. A leading `v` is optional on both sides of the comparison. |
| `allowPrerelease` | `false` | Leave false for a log store. |
| `pageSize` | `30` | The newest stable can be several entries down behind a run of RCs. |
| `verifyImage` | `true` | Registry check before offering the bump. |

Newer prereleases that were skipped are reported in `skippedPrereleases`
rather than dropped — a pending major should be *visible* without being
*applied*. Only prereleases newer than the offered version are listed; an RC
that predates the current stable is noise.

The check looks at one page of releases and says so: `releasesConsidered`
records how many it examined and `truncated` is true when the page came back
full. Truncation cannot cause a *too new* version to be offered — the API
returns newest-first, so the newest stable is either on the page or the page is
entirely prereleases, and that case throws rather than reporting "up to date".

A registry that answers with anything other than 200 or 404 is an **error**,
not an absent tag. Treating an outage as "no such image" would read downstream
as "you are up to date" and park the deployment on an old version silently.

### `health`

Probes `/healthz`, which is unauthenticated — that is why it is the probe
rather than a page behind the login.

```bash
swamp model @sntxrr/openobserve/instance method run health logs
```

A refused connection, DNS failure or TLS error is recorded as
`healthy: false` rather than thrown. Throwing would make a **down instance**
indistinguishable from a **broken check** in a workflow, and `allowFailure`
cannot tell those apart either.

## Configuration

```yaml
globalArguments:
  url: http://192.0.2.10:5080
  # Optional. Unauthenticated, GitHub allows 60 requests/hour per IP, shared
  # with everything else on that address. Use a vault reference, not a literal.
  githubToken: ${{ vault.default.github_token }}
```

| argument | default | notes |
|---|---|---|
| `url` | ✅ | Base URL, no trailing slash, no path. |
| `repository` | `openobserve/openobserve` | Track a fork by changing this. |
| `registry` | `public.ecr.aws` | |
| `registryRepository` | `zinclabs/openobserve` | **Not** `openobserve/openobserve`: the project publishes under Zinc Labs' old org name. There is no `ghcr.io/openobserve/openobserve`. |
| `githubToken` | — | Optional. |

## Notes

- The registry check is a manifest `HEAD`, not a tag listing. A tags list is
  paginated and `public.ecr.aws` truncates it at 1000 entries with no ordering
  guarantee, so a tag can be genuinely present and missing from the first page.
- The `Accept` header names the OCI and Docker manifest media types explicitly.
  Without it a registry serving an OCI index answers 404 for an image that
  exists.
- A registry response that is neither 200 nor 404 raises rather than being read
  as "absent" — an outage must not silently look like "no update".

## Licence

MIT — see [LICENSE.md](LICENSE.md).
