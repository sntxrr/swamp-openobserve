/**
 * Tests for the release-selection logic.
 *
 * The cases that matter are the ones that produced real-world wrong answers:
 * a prerelease sorting above the stable release it precedes, and a tag list
 * whose newest entry is an RC.
 *
 * @module
 */

import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { compareVersions, parseVersion, selectLatest } from "./openobserve.ts";

/** Parse and assert it succeeded, so tests read without null checks. */
function v(tag: string) {
  const p = parseVersion(tag);
  if (!p) throw new Error(`test fixture ${tag} failed to parse`);
  return p;
}

Deno.test("parseVersion accepts tags with and without a leading v", () => {
  assertEquals(parseVersion("v0.92.2"), {
    major: 0,
    minor: 92,
    patch: 2,
    prerelease: null,
  });
  assertEquals(parseVersion("0.92.2"), {
    major: 0,
    minor: 92,
    patch: 2,
    prerelease: null,
  });
});

Deno.test("parseVersion captures a prerelease suffix", () => {
  assertEquals(parseVersion("v1.0.0-rc1")?.prerelease, "rc1");
  assertEquals(parseVersion("v1.0.0")?.prerelease, null);
});

Deno.test("parseVersion returns null on a non-semver tag rather than throwing", () => {
  // The release list contains occasional oddities; one must not abort the run.
  assertEquals(parseVersion("nightly"), null);
  assertEquals(parseVersion(""), null);
});

Deno.test("v-prefixed and bare forms of the same version compare equal", () => {
  // Mixing the two conventions is how an updater concludes 0.92.2 != v0.92.2
  // and re-proposes the same upgrade forever.
  assertEquals(compareVersions(v("v0.92.2"), v("0.92.2")), 0);
});

Deno.test("a prerelease sorts BEFORE its own release", () => {
  // Semver precedence. Getting this backwards makes an RC look like an upgrade
  // over the stable release it precedes.
  assertEquals(compareVersions(v("v1.0.0-rc1"), v("v1.0.0")) < 0, true);
  assertEquals(compareVersions(v("v1.0.0"), v("v1.0.0-rc1")) > 0, true);
});

Deno.test("ordering is by major, then minor, then patch", () => {
  assertEquals(compareVersions(v("v1.0.0"), v("v0.92.2")) > 0, true);
  assertEquals(compareVersions(v("v0.92.2"), v("v0.92.1")) > 0, true);
  assertEquals(compareVersions(v("v0.92.0"), v("v0.91.5")) > 0, true);
});

// The real 2026-08-29 state of openobserve/openobserve: an RC published
// eleven days AFTER the newest stable. This is the whole reason the model
// reads releases rather than sorting the tag list.
const REAL_RELEASES = [
  { tag_name: "v1.0.0-rc1", prerelease: true, published_at: "2026-08-28T06:26:01Z", html_url: "u1" },
  { tag_name: "v0.92.2", prerelease: false, published_at: "2026-08-17T13:48:31Z", html_url: "u2" },
  { tag_name: "v0.92.1", prerelease: false, published_at: "2026-08-14T07:09:54Z", html_url: "u3" },
  { tag_name: "v0.92.0", prerelease: false, published_at: "2026-08-07T09:52:55Z", html_url: "u4" },
  { tag_name: "v0.92.0-rc4", prerelease: true, published_at: "2026-08-06T14:07:21Z", html_url: "u5" },
];

Deno.test("the newest RC is not offered, and the newest stable is", () => {
  const { latest } = selectLatest(REAL_RELEASES, false);
  assertEquals(latest?.tag, "v0.92.2");
  assertNotEquals(latest?.tag, "v1.0.0-rc1");
});

Deno.test("skipped prereleases report only those NEWER than what is offered", () => {
  const { skippedPrereleases } = selectLatest(REAL_RELEASES, false);
  // v1.0.0-rc1 is a pending major worth surfacing. v0.92.0-rc4 predates the
  // offered v0.92.2 and is noise.
  assertEquals(skippedPrereleases, ["v1.0.0-rc1"]);
});

Deno.test("allowPrerelease surfaces the RC and then skips nothing", () => {
  const { latest, skippedPrereleases } = selectLatest(REAL_RELEASES, true);
  assertEquals(latest?.tag, "v1.0.0-rc1");
  assertEquals(skippedPrereleases, []);
});

Deno.test("a tag with a prerelease suffix is excluded even when the flag says otherwise", () => {
  // The GitHub `prerelease` flag is set by whoever cut the release and is
  // occasionally wrong; the suffix is mechanical. Both are checked.
  const mislabelled = [
    { tag_name: "v2.0.0-rc1", prerelease: false, published_at: "", html_url: "" },
    { tag_name: "v1.5.0", prerelease: false, published_at: "", html_url: "" },
  ];
  assertEquals(selectLatest(mislabelled, false).latest?.tag, "v1.5.0");
});

Deno.test("drafts are never offered", () => {
  const withDraft = [
    { tag_name: "v9.9.9", draft: true, prerelease: false, published_at: "", html_url: "" },
    { tag_name: "v0.92.2", draft: false, prerelease: false, published_at: "", html_url: "" },
  ];
  assertEquals(selectLatest(withDraft, false).latest?.tag, "v0.92.2");
});

Deno.test("unparseable tags are skipped without losing the rest of the list", () => {
  const messy = [
    { tag_name: "nightly", prerelease: false, published_at: "", html_url: "" },
    { tag_name: "v0.92.2", prerelease: false, published_at: "", html_url: "" },
  ];
  assertEquals(selectLatest(messy, false).latest?.tag, "v0.92.2");
});

Deno.test("an all-prerelease list offers nothing rather than falling back to an RC", () => {
  const onlyRcs = [
    { tag_name: "v1.0.0-rc1", prerelease: true, published_at: "", html_url: "" },
  ];
  assertEquals(selectLatest(onlyRcs, false).latest, null);
});

Deno.test("selection does not depend on the order the API returned", () => {
  const shuffled = [...REAL_RELEASES].reverse();
  assertEquals(selectLatest(shuffled, false).latest?.tag, "v0.92.2");
});

// ---------------------------------------------------------------------------
// Method-level tests.
//
// The tests above cover the pure selection logic. These drive the actual
// `execute` functions through a mocked fetch, because the behaviours most
// likely to cause real damage live in the glue rather than in the comparison:
// whether a registry outage is reported as "no update", whether a down instance
// throws instead of recording itself as down, and whether what gets written
// actually conforms to the schema it is written against.
// ---------------------------------------------------------------------------

import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@0.20260928.39";
import { assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { model } from "./openobserve.ts";

/**
 * Build a context the way swamp does — global arguments parsed through the
 * model's own schema so defaults (`repository`, `registry`, ...) are applied.
 * Passing a raw object instead would silently test different inputs than
 * production uses.
 */
function ctx(globalArgs: Record<string, unknown> = {}) {
  return createModelTestContext({
    globalArgs: model.globalArguments.parse({
      url: "http://openobserve.example.com:5080",
      ...globalArgs,
    }),
  });
}

/** Parse method arguments through the method's own schema, for the same reason. */
// deno-lint-ignore no-explicit-any
function updateArgs(args: Record<string, unknown>): any {
  return model.methods.check_update.arguments.parse(args);
}

/** GitHub releases payload: one stable ahead of current, one newer RC. */
const RELEASES_JSON = [
  {
    tag_name: "v1.0.0-rc1",
    draft: false,
    prerelease: true,
    html_url: "https://example.com/rc1",
    published_at: "2026-08-28T00:00:00Z",
  },
  {
    tag_name: "v0.92.2",
    draft: false,
    prerelease: false,
    html_url: "https://example.com/0922",
    published_at: "2026-08-17T00:00:00Z",
  },
];

Deno.test("health records a serving instance and validates against its schema", async () => {
  const { context, getWrittenResources } = ctx();
  await withMockedFetch(
    () => new Response("ok", { status: 200 }),
    async () => {
      // deno-lint-ignore no-explicit-any
      await model.methods.health.execute({ timeoutMs: 5000 }, context as any);
    },
  );

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "health");
  assertEquals(written[0].data.healthy, true);
  assertEquals(written[0].data.status, 200);
  // Schema-write conformance, enforced mechanically rather than by review: if a
  // field is ever added to the schema and not to the write (or vice versa),
  // this throws.
  model.resources.health.schema.parse(written[0].data);
});

Deno.test("health records a transport failure as unhealthy instead of throwing", async () => {
  // This is the whole reason the fetch is wrapped in a try/catch. If the method
  // threw, a workflow could not tell "OpenObserve is down" from "the check is
  // broken" -- and `allowFailure` collapses both into the same step status.
  const { context, getWrittenResources } = ctx();
  await withMockedFetch(
    () => {
      throw new TypeError("connection refused");
    },
    async () => {
      // deno-lint-ignore no-explicit-any
      await model.methods.health.execute({ timeoutMs: 5000 }, context as any);
    },
  );

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].data.healthy, false);
  assertEquals(written[0].data.status, 0);
  assertStringIncludes(String(written[0].data.detail), "connection refused");
  model.resources.health.schema.parse(written[0].data);
});

Deno.test("health reports a 5xx as unhealthy and warns", async () => {
  const { context, getWrittenResources, getLogsByLevel } = ctx();
  await withMockedFetch(
    () => new Response("upstream broken", { status: 503 }),
    async () => {
      // deno-lint-ignore no-explicit-any
      await model.methods.health.execute({ timeoutMs: 5000 }, context as any);
    },
  );

  assertEquals(getWrittenResources()[0].data.healthy, false);
  assertEquals(getWrittenResources()[0].data.status, 503);
  // Note the asymmetry, which is easy to get backwards: the logger METHOD is
  // `warn`, but the level it records is `warning`.
  assertEquals(getLogsByLevel("warning").length, 1);
});

Deno.test("check_update offers a newer stable whose image is present", async () => {
  const { context, getWrittenResources } = ctx();
  await withMockedFetch(
    (req: Request) => {
      if (req.url.includes("api.github.com")) return Response.json(RELEASES_JSON);
      if (req.url.includes("/token/")) return Response.json({ token: "t" });
      return new Response(null, { status: 200 }); // manifest HEAD
    },
    async () => {
      await model.methods.check_update.execute(
        updateArgs({ currentVersion: "v0.92.0" }),
        // deno-lint-ignore no-explicit-any
        context as any,
      );
    },
  );

  const d = getWrittenResources()[0].data;
  assertEquals(getWrittenResources()[0].specName, "update");
  assertEquals(d.latest, "v0.92.2");
  assertEquals(d.updateAvailable, true);
  assertEquals(d.imageAvailable, true);
  assertEquals(d.image, "public.ecr.aws/zinclabs/openobserve:v0.92.2");
  // The pending major is surfaced, not silently dropped.
  assertEquals(d.skippedPrereleases, ["v1.0.0-rc1"]);
  model.resources.update.schema.parse(d);
});

Deno.test("check_update withholds the update when the image is not pushed yet", async () => {
  // A GitHub release and a published image are separate events. Offering a bump
  // whose image 404s produces a deploy that dies at `compose pull`, after the
  // running container has already been stopped.
  const { context, getWrittenResources } = ctx();
  await withMockedFetch(
    (req: Request) => {
      if (req.url.includes("api.github.com")) return Response.json(RELEASES_JSON);
      if (req.url.includes("/token/")) return Response.json({ token: "t" });
      return new Response(null, { status: 404 });
    },
    async () => {
      await model.methods.check_update.execute(
        updateArgs({ currentVersion: "v0.92.0" }),
        // deno-lint-ignore no-explicit-any
        context as any,
      );
    },
  );

  const d = getWrittenResources()[0].data;
  assertEquals(d.latest, "v0.92.2");
  assertEquals(d.imageAvailable, false);
  assertEquals(d.updateAvailable, false);
  model.resources.update.schema.parse(d);
});

Deno.test("check_update throws on a registry outage rather than reporting no update", async () => {
  // The failure mode this guards: a 500 from the registry being treated as
  // "tag absent", which reads downstream as "you are up to date" and silently
  // parks the deployment on an old version indefinitely.
  const { context, getWrittenResources } = ctx();
  await withMockedFetch(
    (req: Request) => {
      if (req.url.includes("api.github.com")) return Response.json(RELEASES_JSON);
      if (req.url.includes("/token/")) return Response.json({ token: "t" });
      return new Response("registry on fire", { status: 500 });
    },
    async () => {
      await assertRejects(
        () =>
          model.methods.check_update.execute(
            updateArgs({ currentVersion: "v0.92.0" }),
            // deno-lint-ignore no-explicit-any
            context as any,
          ),
        Error,
        "indeterminate",
      );
    },
  );
  // Nothing was written -- a failed check must not leave a stale "no update"
  // record behind for the next workflow run to read as authoritative.
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("check_update reports no update when already on the newest stable", async () => {
  const { context, getWrittenResources } = ctx();
  await withMockedFetch(
    (req: Request) => {
      if (req.url.includes("api.github.com")) return Response.json(RELEASES_JSON);
      throw new Error("registry must not be consulted when there is nothing to offer");
    },
    async () => {
      await model.methods.check_update.execute(
        updateArgs({ currentVersion: "v0.92.2" }),
        // deno-lint-ignore no-explicit-any
        context as any,
      );
    },
  );

  const d = getWrittenResources()[0].data;
  assertEquals(d.updateAvailable, false);
  assertEquals(d.latest, "v0.92.2");
  model.resources.update.schema.parse(d);
});

Deno.test("check_update flags truncation when GitHub returns a full page", async () => {
  const full = Array.from({ length: 5 }, (_, i) => ({
    tag_name: `v0.9${i}.0`,
    draft: false,
    prerelease: false,
    html_url: "https://example.com/r",
    published_at: "2026-01-01T00:00:00Z",
  }));
  const { context, getWrittenResources } = ctx();
  await withMockedFetch(
    (req: Request) => {
      if (req.url.includes("api.github.com")) return Response.json(full);
      if (req.url.includes("/token/")) return Response.json({ token: "t" });
      return new Response(null, { status: 200 });
    },
    async () => {
      await model.methods.check_update.execute(
        updateArgs({ currentVersion: "v0.90.0", pageSize: 5 }),
        // deno-lint-ignore no-explicit-any
        context as any,
      );
    },
  );

  const d = getWrittenResources()[0].data;
  assertEquals(d.releasesConsidered, 5);
  assertEquals(d.truncated, true);
  model.resources.update.schema.parse(d);
});

Deno.test("check_update rejects a currentVersion that is not a semantic version", async () => {
  const { context, getWrittenResources } = ctx();
  await assertRejects(
    () =>
      model.methods.check_update.execute(
        updateArgs({ currentVersion: "latest" }),
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
    Error,
    "not a",
  );
  // Thrown before any network call and before any write.
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("check_update explains an anonymous GitHub 403 as a rate limit", async () => {
  // The bare status sends people looking for a permissions problem that is not
  // there; a daily unauthenticated check shares 60 req/hour with everything
  // else on the runner's IP.
  const { context } = ctx();
  await withMockedFetch(
    () => new Response("rate limit exceeded", { status: 403 }),
    async () => {
      await assertRejects(
        () =>
          model.methods.check_update.execute(
            updateArgs({ currentVersion: "v0.92.0" }),
            // deno-lint-ignore no-explicit-any
            context as any,
          ),
        Error,
        "60 requests/hour",
      );
    },
  );
});
