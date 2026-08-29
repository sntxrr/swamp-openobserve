/**
 * Operate a self-hosted OpenObserve instance from swamp: check that it is
 * alive, and decide — safely — whether a newer upstream release should be
 * rolled out to it.
 *
 * ## Why the update check is not one line of `jq`
 *
 * OpenObserve publishes release candidates into the same tag namespace as
 * stable releases. On 2026-08-29 the newest tag was `v1.0.0-rc1`, published
 * eleven days *after* the newest stable release `v0.92.2`. Anything that reads
 * the **tag list** and sorts it — which is what almost every homegrown update
 * checker does — pins an RC.
 *
 * That matters more for OpenObserve than for a stateless web app. It is a log
 * store: a release candidate that migrates the on-disk schema is not undone by
 * re-pinning the previous tag, because the previous binary can no longer read
 * what the new one wrote. The rollback is a restore from backup, not a redeploy.
 *
 * So `check_update` filters prereleases by default, and reports the ones it
 * skipped rather than hiding them — a pending major is something the operator
 * should know is coming even when it must not be applied automatically.
 *
 * ## It also verifies the image actually exists
 *
 * A GitHub release and a published container image are two different events,
 * and they are not simultaneous. Proposing a version bump whose image has not
 * been pushed yet produces a deploy that fails on `docker compose pull`, at the
 * point where it has already stopped the running container. `check_update`
 * therefore confirms the candidate tag is present in the registry before
 * reporting the update as available, and the registry it checks is
 * `public.ecr.aws/zinclabs` — OpenObserve publishes under Zinc Labs' old org
 * name, not ghcr.io and not Docker Hub.
 *
 * @module
 */

import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  url: z.string().describe(
    "Base URL of the OpenObserve instance, e.g. http://192.0.2.10:5080. " +
      "No trailing slash and no path.",
  ),
  repository: z.string().default("openobserve/openobserve").describe(
    "GitHub `owner/repo` that publishes the releases. Overridable so a fork " +
      "or a downstream build can be tracked instead.",
  ),
  registry: z.string().default("public.ecr.aws").describe(
    "Container registry host holding the images.",
  ),
  registryRepository: z.string().default("zinclabs/openobserve").describe(
    "Repository path within the registry. OpenObserve publishes under Zinc " +
      "Labs' old org name; there is no ghcr.io/openobserve/openobserve.",
  ),
  // `.meta({ sensitive: true })` sits on this line rather than after the
  // `.describe(...)` call it chains from: the push-time safety analyzer reads
  // the field's declaration LINE, so a marker placed after a multi-line
  // describe() is invisible to it and the field still reports as an unvaulted
  // secret. Verified in zod 4 that meta() merges rather than replaces, so the
  // description survives.
  githubToken: z.string().meta({ sensitive: true }).optional().describe(
    "Optional GitHub token. Unauthenticated the releases API allows 60 " +
      "requests/hour per IP, which a scheduled check shares with everything " +
      "else on that address. Supply a vault reference rather than a literal.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const HealthSchema = z.object({
  url: z.string().describe("Instance base URL that was probed."),
  healthy: z.boolean().describe("True when /healthz answered 2xx."),
  status: z.number().describe(
    "HTTP status returned by /healthz, 0 on a transport error.",
  ),
  latencyMs: z.number().describe("Round-trip time of the probe."),
  detail: z.string().describe(
    "Transport error text, or the response body, truncated.",
  ),
  checkedAt: z.iso.datetime().describe("When the probe ran."),
});

const UpdateSchema = z.object({
  current: z.string().describe("The version this check compared against."),
  latest: z.string().describe("Newest stable release found, e.g. v0.92.2."),
  updateAvailable: z.boolean().describe(
    "True only when `latest` is strictly newer than `current` AND its image " +
      "exists in the registry.",
  ),
  imageAvailable: z.boolean().describe(
    "Whether the candidate tag resolves in the registry. False means the " +
      "release is published but the image is not pushed yet.",
  ),
  image: z.string().describe("Fully qualified image reference for `latest`."),
  releaseUrl: z.string().describe("HTML URL of the release notes."),
  publishedAt: z.string().describe("Publication timestamp of `latest`."),
  skippedPrereleases: z.array(z.string()).describe(
    "Prerelease tags newer than `latest` that were deliberately not offered. " +
      "Surfaced so a pending major is visible without being auto-applied.",
  ),
  releasesConsidered: z.number().describe(
    "How many releases the GitHub query actually returned and this check " +
      "examined.",
  ),
  truncated: z.boolean().describe(
    "True when GitHub returned a full page, so releases older than the last " +
      "one examined exist but were not considered. Cannot cause a too-new " +
      "version to be offered -- the API returns newest-first, so the newest " +
      "stable is either on the page or the page is entirely prereleases, in " +
      "which case the check throws rather than reporting `up to date`. It is " +
      "recorded so a run that saw a wall of prereleases is distinguishable " +
      "from one that saw the whole history.",
  ),
  checkedAt: z.iso.datetime().describe("When the check ran."),
});

/**
 * A parsed semantic version. `prerelease` is null for a stable release.
 */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const SEMVER =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Parse a release tag into comparable parts.
 *
 * Accepts an optional leading `v` because OpenObserve tags with one and the
 * corresponding image tags also carry it — mixing the two conventions in a
 * comparison is how an updater concludes `0.92.2 != v0.92.2` and re-proposes
 * the same upgrade on every run.
 *
 * Returns null rather than throwing: the release list contains occasional
 * non-semver tags, and one of them must not abort the whole check.
 */
export function parseVersion(tag: string): ParsedVersion | null {
  const m = SEMVER.exec(tag.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

/**
 * Compare two parsed versions: negative when `a` precedes `b`, positive when it
 * follows, zero when equal.
 *
 * Implements the semver precedence rule that a prerelease sorts BEFORE its
 * own release — `1.0.0-rc1` < `1.0.0`. Getting this backwards would make an RC
 * look like an upgrade over the stable version it precedes, which is precisely
 * the outcome the prerelease filter exists to prevent; the filter and this
 * ordering are two independent guards against the same mistake.
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === b.prerelease) return 0;
  // A stable release outranks any prerelease of the same x.y.z.
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/** A release as this model cares about it. */
export interface ReleaseCandidate {
  tag: string;
  parsed: ParsedVersion;
  prerelease: boolean;
  htmlUrl: string;
  publishedAt: string;
}

/**
 * Reduce a GitHub releases payload to the newest release that may be offered,
 * plus the prerelease tags that were newer and were skipped.
 *
 * Pure and exported so the whole selection rule — draft exclusion, prerelease
 * exclusion, semver ordering — is testable without reaching GitHub.
 *
 * `allowPrerelease` is honoured, but note that a release is treated as a
 * prerelease if GitHub flags it OR the tag itself carries a prerelease suffix.
 * Both are checked because the flag is set by whoever cut the release and is
 * occasionally wrong, while the suffix is mechanical.
 */
export function selectLatest(
  releases: Array<{
    tag_name?: string;
    draft?: boolean;
    prerelease?: boolean;
    html_url?: string;
    published_at?: string;
  }>,
  allowPrerelease: boolean,
): { latest: ReleaseCandidate | null; skippedPrereleases: string[] } {
  const parsed: ReleaseCandidate[] = [];
  for (const r of releases) {
    if (r.draft) continue;
    const tag = r.tag_name;
    if (!tag) continue;
    const p = parseVersion(tag);
    if (!p) continue;
    parsed.push({
      tag,
      parsed: p,
      prerelease: Boolean(r.prerelease) || p.prerelease !== null,
      htmlUrl: r.html_url ?? "",
      publishedAt: r.published_at ?? "",
    });
  }

  parsed.sort((x, y) => compareVersions(y.parsed, x.parsed));

  const eligible = allowPrerelease
    ? parsed
    : parsed.filter((r) => !r.prerelease);
  const latest = eligible[0] ?? null;

  // Only prereleases NEWER than what is being offered are interesting. An old
  // rc that predates the current stable is noise, not a pending major.
  const skipped = latest === null ? [] : parsed
    .filter((r) => r.prerelease && compareVersions(r.parsed, latest.parsed) > 0)
    .map((r) => r.tag);

  return { latest, skippedPrereleases: skipped };
}

/**
 * Read an error response's body for inclusion in an exception message.
 *
 * Also serves as the disposal path. An un-consumed `fetch` body is a live
 * resource in Deno; on an error path -- the one place nothing else reads it --
 * dropping the reference leaks it, and Deno's test runner fails the test with a
 * resource-leak sanitizer error rather than the assertion under test.
 */
async function readErrorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300).trim() || "(empty body)";
  } catch {
    return "(body unreadable)";
  }
}

/**
 * Check whether a tag exists in a Docker-registry-v2 repository.
 *
 * Uses the anonymous token flow, which both public.ecr.aws and ghcr.io
 * implement: request a pull-scoped bearer token, then HEAD the manifest.
 *
 * HEAD on the manifest rather than listing tags, deliberately. A tags list is
 * paginated and public.ecr.aws truncates it at 1000 entries with no ordering
 * guarantee, so a tag can be genuinely present and absent from the first page.
 * A manifest HEAD answers about the one tag being asked about.
 *
 * The Accept header must name the manifest media types explicitly; without it
 * a registry serving an OCI index answers 404 for an image that exists.
 */
export async function imageTagExists(
  registry: string,
  repository: string,
  tag: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const tokenUrl =
    `https://${registry}/token/?scope=${
      encodeURIComponent(`repository:${repository}:pull`)
    }` +
    `&service=${encodeURIComponent(registry)}`;
  const tokenRes = await fetch(tokenUrl, { signal });
  if (!tokenRes.ok) {
    throw new Error(
      `registry ${registry} refused an anonymous pull token for ${repository}: ` +
        `HTTP ${tokenRes.status}: ${await readErrorBody(tokenRes)}`,
    );
  }
  const tokenBody = await tokenRes.json() as {
    token?: string;
    access_token?: string;
  };
  const token = tokenBody.token ?? tokenBody.access_token;
  if (!token) {
    throw new Error(`registry ${registry} returned no token for ${repository}`);
  }

  const manifestRes = await fetch(
    `https://${registry}/v2/${repository}/manifests/${encodeURIComponent(tag)}`,
    {
      method: "HEAD",
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: [
          "application/vnd.oci.image.index.v1+json",
          "application/vnd.oci.image.manifest.v1+json",
          "application/vnd.docker.distribution.manifest.list.v2+json",
          "application/vnd.docker.distribution.manifest.v2+json",
        ].join(", "),
      },
    },
  );
  // A HEAD response usually carries no body, but "usually" is not a contract
  // a registry owes us -- cancel it on every branch rather than assume.
  await manifestRes.body?.cancel();
  if (manifestRes.status === 404) return false;
  if (!manifestRes.ok) {
    throw new Error(
      `registry ${registry} answered HTTP ${manifestRes.status} for ` +
        `${repository}:${tag}; treating as indeterminate rather than absent`,
    );
  }
  return true;
}

interface MethodContext {
  globalArgs: GlobalArgs;
  signal?: AbortSignal;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  // Mirrors swamp's real logger surface. Written out rather than widened to
  // an index signature on purpose: the first cut of this interface declared a
  // `warning` method, which does not exist -- the runtime name is `warn` --
  // and because the interface is hand-rolled, nothing but a method-level test
  // could catch it. Every warning call site would have thrown a TypeError, on
  // exactly the unhappy paths (instance down, image not yet published) where
  // the log matters most.
  logger: {
    debug: (msg: string, props?: Record<string, unknown>) => void;
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
}

/**
 * The `@sntxrr/openobserve/instance` model — a self-hosted OpenObserve
 * deployment, and the upstream release stream feeding it.
 */
export const model = {
  type: "@sntxrr/openobserve/instance",
  version: "2026.08.29.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    health: {
      description: "Liveness of the OpenObserve instance as of the last probe.",
      schema: HealthSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    update: {
      description:
        "Whether a newer stable OpenObserve release is available and its image is pullable.",
      schema: UpdateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    health: {
      description:
        "Probe the instance's /healthz endpoint and record whether it is serving. Unauthenticated: /healthz needs no credentials, which is why it is the probe rather than a page behind the login.",
      arguments: z.object({
        timeoutMs: z.number().int().positive().default(10_000).describe(
          "Give up on the probe after this long.",
        ),
      }),
      execute: async (
        args: { timeoutMs: number },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const base = context.globalArgs.url.replace(/\/+$/, "");
        const url = `${base}/healthz`;
        context.logger.info("Probing OpenObserve health at {url}", { url });
        const started = performance.now();

        let status = 0;
        let detail = "";
        // A transport failure -- DNS, refused connection, TLS -- is a health
        // RESULT, not a reason to abort the method. Throwing here would make a
        // down instance indistinguishable from a broken model in a workflow,
        // and `allowFailure` cannot tell them apart either.
        try {
          const res = await fetch(url, {
            signal: AbortSignal.any(
              context.signal
                ? [context.signal, AbortSignal.timeout(args.timeoutMs)]
                : [AbortSignal.timeout(args.timeoutMs)],
            ),
          });
          status = res.status;
          detail = (await res.text()).slice(0, 500);
        } catch (err) {
          detail = err instanceof Error ? err.message : String(err);
        }

        const latencyMs = Math.round(performance.now() - started);
        const healthy = status >= 200 && status < 300;

        if (healthy) {
          context.logger.info(
            "OpenObserve at {url} is healthy (HTTP {status}, {latencyMs}ms)",
            { url, status, latencyMs },
          );
        } else {
          context.logger.warn(
            "OpenObserve at {url} is not healthy: status={status} detail={detail}",
            { url, status, detail },
          );
        }

        const handle = await context.writeResource("health", "health-current", {
          url: base,
          healthy,
          status,
          latencyMs,
          detail,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    check_update: {
      description:
        "Compare a pinned OpenObserve version against upstream GitHub releases, skipping release candidates, and confirm the candidate image is actually pullable before reporting an update as available.",
      arguments: z.object({
        currentVersion: z.string().describe(
          "The version currently deployed, e.g. v0.92.2. Compared leniently, " +
            "so a leading `v` may be present or absent.",
        ),
        allowPrerelease: z.boolean().default(false).describe(
          "Offer release candidates too. Leave false for a log store: an RC " +
            "schema migration is not reversed by re-pinning the old tag.",
        ),
        pageSize: z.number().int().min(1).max(100).default(30).describe(
          "How many recent releases to consider. The newest stable can be " +
            "several entries down when a run of prereleases precedes it.",
        ),
        verifyImage: z.boolean().default(true).describe(
          "Confirm the candidate tag resolves in the registry. A release and " +
            "its image are separate events; proposing a bump whose image is " +
            "not pushed yet fails the deploy at `compose pull`, after the " +
            "running container has already been stopped.",
        ),
      }),
      execute: async (
        args: {
          currentVersion: string;
          allowPrerelease: boolean;
          pageSize: number;
          verifyImage: boolean;
        },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const current = parseVersion(args.currentVersion);
        if (!current) {
          throw new Error(
            `currentVersion ${JSON.stringify(args.currentVersion)} is not a ` +
              `semantic version; expected something like v0.92.2`,
          );
        }

        const { repository, registry, registryRepository, githubToken } =
          context.globalArgs;

        context.logger.info(
          "Checking {repository} for a release newer than {current} (prereleases {policy})",
          {
            repository,
            current: args.currentVersion,
            policy: args.allowPrerelease ? "allowed" : "skipped",
          },
        );

        const headers: Record<string, string> = {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        };
        if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

        const res = await fetch(
          `https://api.github.com/repos/${repository}/releases?per_page=${args.pageSize}`,
          { headers, signal: context.signal },
        );
        if (!res.ok) {
          // 403 with no token is nearly always the 60/hour anonymous limit.
          // Say so, because the raw status sends people looking for a
          // permissions problem that does not exist.
          const hint = res.status === 403 && !githubToken
            ? " (unauthenticated GitHub allows 60 requests/hour per IP; set globalArgs.githubToken)"
            : "";
          throw new Error(
            `GitHub releases for ${repository} returned HTTP ${res.status}${hint}: ` +
              `${await readErrorBody(res)}`,
          );
        }

        const releases = await res.json() as Array<Record<string, unknown>>;
        const { latest, skippedPrereleases } = selectLatest(
          releases as Parameters<typeof selectLatest>[0],
          args.allowPrerelease,
        );

        if (!latest) {
          throw new Error(
            `no parseable ${
              args.allowPrerelease ? "" : "stable "
            }release found ` +
              `among the ${releases.length} most recent for ${repository}`,
          );
        }

        const newer = compareVersions(latest.parsed, current) > 0;
        const image = `${registry}/${registryRepository}:${latest.tag}`;

        // Only worth a registry round-trip when there is something to offer.
        let imageAvailable = true;
        if (newer && args.verifyImage) {
          imageAvailable = await imageTagExists(
            registry,
            registryRepository,
            latest.tag,
            context.signal,
          );
          if (!imageAvailable) {
            context.logger.warn(
              "release {tag} is published but {image} is not in the registry yet; not offering the update",
              { tag: latest.tag, image },
            );
          }
        }

        if (skippedPrereleases.length > 0) {
          context.logger.info(
            "skipped {count} prerelease(s) newer than {latest}: {tags}",
            {
              count: skippedPrereleases.length,
              latest: latest.tag,
              tags: skippedPrereleases.join(", "),
            },
          );
        }

        const updateAvailable = newer && imageAvailable;
        context.logger.info(
          "{repository}: current={current} latest={latest} updateAvailable={updateAvailable}",
          {
            repository,
            current: args.currentVersion,
            latest: latest.tag,
            updateAvailable,
          },
        );

        const handle = await context.writeResource("update", "update-current", {
          current: args.currentVersion,
          latest: latest.tag,
          updateAvailable,
          imageAvailable,
          image,
          releaseUrl: latest.htmlUrl,
          publishedAt: latest.publishedAt,
          skippedPrereleases,
          releasesConsidered: releases.length,
          truncated: releases.length >= args.pageSize,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
