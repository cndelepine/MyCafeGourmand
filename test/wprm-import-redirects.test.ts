import assert from "node:assert/strict";
import test from "node:test";
import { parsePhpSerialized } from "../scripts/wordpress/php-serialize";
import {
  defaultWprmImportLimits,
  type RawRedirect,
  type RawWprmMeta,
  type RawWordPressPost,
  type WprmSourceGraph
} from "../scripts/wordpress/wprm-import-contracts";
import {
  parsePolylangPermalinkConfig,
  parseWordPressSourceOptions
} from "../scripts/wordpress/wprm-import-options";
import { resolveWprmRedirects } from "../scripts/wordpress/wprm-import-redirects";
import { recipeRecordSchema } from "../src/content/schema";
import type { ParentRecipeLink } from "../scripts/wordpress/wprm-import-relations";
import { recipeFixture } from "./fixtures/recipe";

const polylang =
  'a:5:{s:10:"force_lang";i:1;s:12:"hide_default";b:1;' +
  's:7:"rewrite";b:1;s:13:"redirect_lang";b:0;' +
  's:12:"default_lang";s:2:"en";}';

function options() {
  return parseWordPressSourceOptions(
    new Map([
      ["home", "https://example.test/"],
      ["permalink_structure", "/%postname%/"],
      ["polylang", polylang]
    ]),
    defaultWprmImportLimits
  );
}

function post(
  id: string,
  type: "post" | "wprm_recipe",
  slug: string
): RawWordPressPost {
  return {
    id,
    type,
    status: "publish",
    hasPassword: false,
    parentId: null,
    slug,
    title: "Sanitized",
    content: null,
    excerpt: null,
    createdLocal: null,
    createdGmt: null,
    modifiedLocal: null,
    modifiedGmt: null,
    mimeType: null,
    wprmReferences: new Set()
  };
}

function meta(oldSlugs: readonly string[] = []): RawWprmMeta {
  return {
    values: new Map(),
    duplicateKeys: new Set(),
    unsupportedKeys: new Set(),
    wprmType: {
      present: false,
      raw: null,
      classification: "food"
    },
    excludedRatingData: 0,
    excludedOperationalData: 0,
    excludedAuthorData: 0,
    excludedSocialMediaData: 0,
    excludedVideoData: 0,
    excludedWprmType: 0,
    pinImageFieldsWithoutReference: 0,
    resolvedPinImageReferences: 0,
    unresolvedPinImageReferences: 0,
    oldSlugs
  };
}

function record(
  recipeId: string,
  locale: "en" | "fr" | "ru",
  parentId: string,
  slug: string,
  translationGroupId: string | null = null
) {
  return recipeRecordSchema.parse({
    ...recipeFixture,
    id: `wordpress:wprm:${recipeId}`,
    locale,
    slug,
    translationGroupId,
    source: {
      ...recipeFixture.source,
      recipeId,
      postId: recipeId,
      editorialPostId: parentId,
      editorialPostType: "post",
      editorialSourceSlug: "source"
    }
  });
}

function readyOutcome(value: ReturnType<typeof record>) {
  return {
    recipeId: value.source.recipeId,
    status: "ready" as const,
    locale: value.locale,
    translationGroupId: value.translationGroupId,
    codes: [],
    record: value,
    fingerprint: null
  };
}

function fixtureGraph(
  parentSlug: string,
  redirects: readonly RawRedirect[] = [],
  oldSlugs: readonly string[] = ["ancien"]
): {
  readonly graph: WprmSourceGraph;
  readonly metadata: { readonly wprm: ReadonlyMap<string, RawWprmMeta> };
  readonly relations: {
    readonly locales: ReadonlyMap<string, "en" | "fr" | "ru">;
    readonly parentLinks: ReadonlyMap<string, ParentRecipeLink>;
  };
} {
  const graph: WprmSourceGraph = {
    posts: new Map([
      ["10", post("10", "post", parentSlug)],
      ["20", post("20", "wprm_recipe", "current")]
    ]),
    attachments: new Map(),
    terms: new Map(),
    taxonomies: new Map(),
    relationships: new Map(),
    redirects: [...redirects],
    oldSlugCount: 0,
    excludedRatingData: 0
  };
  return {
    graph,
    metadata: { wprm: new Map([["10", meta(oldSlugs)]]) },
    relations: {
      locales: new Map([["20", "fr"]]),
      parentLinks: new Map([[
        "20",
        {
          recipeId: "20",
          parentId: "10",
          parentKind: "usable",
          parentLocale: "fr",
          recipeLocale: "fr"
        }
      ]])
    }
  };
}

function fixtureGraphWithSecondRecipe(
  parentSlug: string,
  redirects: readonly RawRedirect[] = [],
  oldSlugs: readonly string[] = ["ancien"]
) {
  const fixture = fixtureGraph(parentSlug, redirects, oldSlugs);
  const posts = new Map(fixture.graph.posts);
  posts.set("11", post("11", "post", "other"));
  posts.set("21", post("21", "wprm_recipe", "other-current"));
  const wprm = new Map(fixture.metadata.wprm);
  wprm.set("11", meta(["other-ancien"]));
  const locales = new Map(fixture.relations.locales);
  locales.set("21", "fr");
  const parentLinks = new Map(fixture.relations.parentLinks);
  parentLinks.set("21", {
    recipeId: "21",
    parentId: "11",
    parentKind: "usable",
    parentLocale: "fr",
    recipeLocale: "fr"
  });
  return {
    graph: {
      ...fixture.graph,
      posts
    },
    metadata: {
      ...fixture.metadata,
      wprm
    },
    relations: {
      ...fixture.relations,
      locales,
      parentLinks
    }
  };
}

function resolver(
  graphFixture: ReturnType<typeof fixtureGraph>,
  current = record("20", "fr", "10", "current")
) {
  return resolveWprmRedirects({
    ...graphFixture,
    promotedRecords: [current],
    options: options()
  });
}

test("the source option boundary accepts only the authoritative permalink contract", () => {
  const parsed = options();
  assert.equal(parsed.homeOrigin, "https://example.test");
  assert.deepEqual(parsed.locales, ["en", "fr", "ru"]);
  assert.equal(parsed.permalinkStructure, "/%postname%/");
  assert.throws(
    () => parseWordPressSourceOptions(
      new Map([
        ["home", "https://example.test/?private"],
        ["permalink_structure", "/%postname%/"],
        ["polylang", polylang]
      ]),
      defaultWprmImportLimits
    ),
    (error: unknown) => error && typeof error === "object"
      && "code" in error && error.code === "invalid-home-option"
  );
  assert.throws(
    () => parsePolylangPermalinkConfig(
      polylang.replace('s:2:"en"', 's:2:"fr"'),
      defaultWprmImportLimits
    ),
    /source options are invalid/
  );
  assert.throws(
    () => parsePhpSerialized(
      'a:2:{s:3:"key";s:1:"a";s:3:"key";s:1:"b";}',
      { rejectDuplicateKeys: true }
    ),
    /keys must be unique/
  );
});

test("canonical and old-slug paths preserve locale prefixes and encoded spelling", () => {
  const result = resolver(fixtureGraph("crème-%D1%81%D1%83%D0%BF"));
  assert.deepEqual(
    result.redirects.map((redirect) => redirect.source),
    ["/fr/ancien/", "/fr/crème-%D1%81%D1%83%D0%BF/"]
  );
  assert.ok(result.redirects.every((redirect) =>
    redirect.destination === "/fr/recipes/current/"
  ));
});

test("integrity-blocked records cannot accept redirects or terminate plugin chains", () => {
  const group = "wordpress:post-translations:blocked";
  const baseFixture = fixtureGraph("source", [{
    id: "blocked-plugin",
    source: "/blocked-plugin",
    matchType: "url",
    regex: "0",
    status: "enabled",
    actionType: "url",
    actionCode: "301",
    actionData: "/fr/blocked/"
  }]);
  const fixture = {
    graph: {
      ...baseFixture.graph,
      posts: new Map(baseFixture.graph.posts),
    },
    metadata: {
      wprm: new Map(baseFixture.metadata.wprm)
    },
    relations: {
      locales: new Map(baseFixture.relations.locales),
      parentLinks: new Map(baseFixture.relations.parentLinks)
    }
  };
  fixture.graph.posts.set("11", post("11", "post", "blocked"));
  fixture.graph.posts.set("21", post("21", "wprm_recipe", "blocked-current"));
  fixture.metadata.wprm.set("11", meta(["blocked-old"]));
  fixture.relations.locales.set("21", "fr");
  fixture.relations.parentLinks.set("21", {
    recipeId: "21",
    parentId: "11",
    parentKind: "usable",
    parentLocale: "fr",
    recipeLocale: "fr"
  });
  const current = record("20", "fr", "10", "current", group);
  const blocked = record("21", "fr", "11", "blocked-current", group);
  const outcomes = [
    readyOutcome(current),
    readyOutcome(blocked),
    {
      recipeId: "22",
      status: "error" as const,
      locale: "ru" as const,
      translationGroupId: group,
      codes: ["missing-attachment" as const],
      record: null,
      fingerprint: null
    }
  ];
  const result = resolveWprmRedirects({
    ...fixture,
    promotedRecords: [current, blocked],
    outcomes,
    sourceTranslationGroups: new Map([
      ["20", group],
      ["21", group],
      ["22", group]
    ]),
    options: options()
  });

  assert.equal(result.manifest.canonicalCandidates, 2);
  assert.equal(result.manifest.promotionEligibleCandidates, 0);
  assert.equal(result.manifest.canonicalAccepted, 0);
  assert.equal(result.manifest.oldSlugCandidates, 0);
  assert.equal(result.manifest.accepted, 0);
  assert.equal(result.manifest.pluginAccepted, 0);
  assert.equal(result.manifest.pluginUnresolved, 1);
  assert.deepEqual(result.redirects, []);
  assert.equal(result.byRecipeId.size, 0);
});

test("publication-only translation peers do not block redirect eligibility", () => {
  const group = "wordpress:post-translations:publication-only";
  const current = record("20", "fr", "10", "current", group);
  const result = resolveWprmRedirects({
    ...fixtureGraph("source"),
    promotedRecords: [current],
    outcomes: [
      readyOutcome(current),
      {
        recipeId: "21",
        status: "error",
        locale: "ru",
        translationGroupId: group,
        codes: ["nonpublish-recipe"],
        record: null,
        fingerprint: null
      }
    ],
    sourceTranslationGroups: new Map([
      ["20", group],
      ["21", group]
    ]),
    options: options()
  });

  assert.equal(result.manifest.promotionEligibleCandidates, 1);
  assert.equal(result.manifest.canonicalAccepted, 1);
  assert.equal(result.manifest.accepted, 2);
  assert.deepEqual(result.byRecipeId.get(current.id), [
    "/fr/ancien/",
    "/fr/source/"
  ]);
});

test("repeated encoding, separators, and malformed editorial slugs are rejected", () => {
  for (const slug of ["source%252Dname", "source%2Fname", "source%"]) {
    const result = resolver(fixtureGraph(slug));
    assert.equal(result.manifest.canonicalAccepted, 0);
    assert.ok(result.issues.some((issue) =>
      issue.code === "redirect-unsafe-canonical-source"
    ));
  }
});

test("literal-percent editorial and plugin sources remain valid", () => {
  const editorial = resolver(fixtureGraph("source%25", [], ["ancien%25"]));
  assert.equal(editorial.manifest.canonicalAccepted, 1);
  assert.equal(editorial.manifest.oldSlugAccepted, 1);
  assert.deepEqual(editorial.byRecipeId.get("wordpress:wprm:20"), [
    "/fr/ancien%25/",
    "/fr/source%25/"
  ]);

  const plugin = resolver(fixtureGraph(
    "source",
    [{
      id: "literal-percent",
      source: "/legacy%25/",
      matchType: "url",
      regex: "0",
      status: "enabled",
      actionType: "url",
      actionCode: "301",
      actionData: "/fr/recipes/current/"
    }]
  ));
  assert.equal(plugin.manifest.pluginAccepted, 1);
  assert.equal(
    plugin.redirects.find((redirect) => redirect.source === "/legacy%25/")?.destination,
    "/fr/recipes/current/"
  );
});

test("same-origin local and absolute plugin chains resolve to one current recipe", () => {
  const result = resolver(fixtureGraph(
    "source",
    [
      {
        id: "1",
        source: "/one",
        matchType: "url",
        regex: "0",
        status: "enabled",
        actionType: "url",
        actionCode: "301",
        actionData: "/two"
      },
      {
        id: "2",
        source: "/two",
        matchType: "url",
        regex: "0",
        status: "enabled",
        actionType: "url",
        actionCode: "301",
        actionData: "https://example.test/fr/source/"
      }
    ]
  ));
  assert.deepEqual(
    result.redirects
      .filter((redirect) => redirect.kind === "plugin")
      .map((redirect) => redirect.source),
    ["/one", "/two"]
  );
  assert.equal(result.manifest.pluginAccepted, 2);
  assert.equal(result.manifest.pluginDeduplicated, 0);
});

test("authoritative terminal rows corroborate same-identity targets without adding routes", () => {
  const result = resolver(fixtureGraph(
    "source",
    [{
      id: "terminal-corroboration",
      source: "/fr/ancien/",
      matchType: "url",
      regex: "0",
      status: "enabled",
      actionType: "url",
      actionCode: "301",
      actionData: "/fr/recipes/current/"
    }]
  ));

  assert.equal(result.manifest.pluginAccepted, 1);
  assert.equal(result.manifest.pluginDeduplicated, 1);
  assert.equal(result.manifest.pluginConflict, 0);
  assert.equal(result.manifest.accepted, 2);
  assert.deepEqual(
    result.redirects.map((redirect) => redirect.source),
    ["/fr/ancien/", "/fr/source/"]
  );
  assert.equal(
    result.byRecipeId.get("wordpress:wprm:20")?.filter(
      (source) => source === "/fr/ancien/"
    ).length,
    1
  );
});

test("authoritative terminal rows resolve same-identity targets through nonterminal chains", () => {
  const rows: RawRedirect[] = [
    {
      id: "terminal-chain",
      source: "/fr/ancien/",
      matchType: "url",
      regex: "0",
      status: "enabled",
      actionType: "url",
      actionCode: "301",
      actionData: "/bridge"
    },
    {
      id: "bridge",
      source: "/bridge",
      matchType: "url",
      regex: "0",
      status: "enabled",
      actionType: "url",
      actionCode: "301",
      actionData: "/fr/recipes/current/"
    }
  ];
  const result = resolver(fixtureGraph("source", rows));

  assert.equal(result.manifest.pluginAccepted, 2);
  assert.equal(result.manifest.pluginDeduplicated, 1);
  assert.equal(result.manifest.pluginConflict, 0);
  assert.equal(result.manifest.accepted, 3);
  assert.deepEqual(
    result.redirects.filter((redirect) => redirect.kind === "plugin"),
    [{
      source: "/bridge",
      destination: "/fr/recipes/current/",
      recipeId: "wordpress:wprm:20",
      locale: "fr",
      kind: "plugin"
    }]
  );
});

test("terminal precedence keeps redirect evidence order-independent", () => {
  const rows: RawRedirect[] = [
    {
      id: "terminal-chain",
      source: "/fr/ancien/",
      matchType: "url",
      regex: "0",
      status: "enabled",
      actionType: "url",
      actionCode: "301",
      actionData: "/bridge"
    },
    {
      id: "bridge",
      source: "/bridge",
      matchType: "url",
      regex: "0",
      status: "enabled",
      actionType: "url",
      actionCode: "301",
      actionData: "/fr/recipes/current/"
    }
  ];
  const first = resolver(fixtureGraph("source", rows));
  const second = resolver(fixtureGraph("source", [...rows].reverse()));

  assert.deepEqual(second.redirects, first.redirects);
  assert.deepEqual(second.manifest, first.manifest);
  assert.deepEqual(second.issues, first.issues);
});

test("authoritative old-slug terminals reject conflicting plugin sources and resolve upstream aliases", () => {
  const fixture = fixtureGraphWithSecondRecipe(
    "source",
    [
      {
        id: "terminal-conflict",
        source: "/fr/source/",
        matchType: "url",
        regex: "0",
        status: "enabled",
        actionType: "url",
        actionCode: "301",
        actionData: "/fr/other/"
      },
      {
        id: "upstream",
        source: "/fr/A/",
        matchType: "url",
        regex: "0",
        status: "enabled",
        actionType: "url",
        actionCode: "301",
        actionData: "/fr/source/"
      }
    ],
    ["B"]
  );
  const current = record("20", "fr", "10", "current");
  const other = record("21", "fr", "11", "other-current");
  const result = resolveWprmRedirects({
    ...fixture,
    promotedRecords: [current, other],
    options: options()
  });

  assert.equal(result.manifest.pluginAccepted, 1);
  assert.equal(result.manifest.pluginDeduplicated, 0);
  assert.equal(result.manifest.pluginConflict, 1);
  assert.ok(result.issues.some((issue) =>
    issue.code === "redirect-conflicting-identity" && issue.count === 1
  ));
  assert.deepEqual(
    result.redirects.filter((redirect) => redirect.kind === "plugin"),
    [{
      source: "/fr/A/",
      destination: "/fr/recipes/current/",
      recipeId: "wordpress:wprm:20",
      locale: "fr",
      kind: "plugin"
    }]
  );
  assert.equal(
    result.redirects.some((redirect) => redirect.source === "/fr/source/"
      && redirect.kind === "plugin"),
    false
  );
});

test("encoded plugin sources use the same terminal identity as raw canonical paths", () => {
  const result = resolver(fixtureGraph(
    "crème",
    [
      {
        id: "encoded-terminal-corroboration",
        source: "/fr/cr%C3%A8me/",
        matchType: "url",
        regex: "0",
        status: "enabled",
        actionType: "url",
        actionCode: "301",
        actionData: "/fr/recipes/current/"
      },
      {
        id: "encoded-upstream",
        source: "/fr/A/",
        matchType: "url",
        regex: "0",
        status: "enabled",
        actionType: "url",
        actionCode: "301",
        actionData: "/fr/cr%C3%A8me/"
      }
    ]
  ));

  assert.equal(result.manifest.pluginAccepted, 2);
  assert.equal(result.manifest.pluginDeduplicated, 1);
  assert.equal(result.manifest.pluginConflict, 0);
  assert.equal(
    result.redirects.find((redirect) => redirect.source === "/fr/A/")?.destination,
    "/fr/recipes/current/"
  );
  assert.equal(
    result.redirects.some((redirect) => redirect.source === "/fr/cr%C3%A8me/"),
    false
  );
});

test("unresolved targets from authoritative terminals remain unresolved evidence", () => {
  const result = resolver(fixtureGraph(
    "source",
    [{
      id: "terminal-unresolved",
      source: "/fr/ancien/",
      matchType: "url",
      regex: "0",
      status: "enabled",
      actionType: "url",
      actionCode: "301",
      actionData: "/not-a-known-route/"
    }]
  ));

  assert.equal(result.manifest.pluginAccepted, 0);
  assert.equal(result.manifest.pluginDeduplicated, 0);
  assert.equal(result.manifest.pluginConflict, 0);
  assert.equal(result.manifest.pluginUnresolved, 1);
  assert.ok(result.issues.some((issue) =>
    issue.code === "redirect-unresolved" && issue.count === 1
  ));
});

test("absolute targets are validated before URL normalization", () => {
  const unsafeTargets = [
    "https://example.test/fr/%2e%2e/fr/recipes/current/",
    "https://example.test\\fr\\recipes\\current/",
    "https://example.test/\tfr/recipes/current/"
  ];
  const result = resolver(fixtureGraph(
    "source",
    unsafeTargets.map((actionData, index) => ({
      id: `unsafe-absolute-${index}`,
      source: `/unsafe-absolute-${index}/`,
      matchType: "url",
      regex: "0",
      status: "enabled",
      actionType: "url",
      actionCode: "301",
      actionData
    }))
  ));

  assert.equal(result.manifest.pluginAccepted, 0);
  assert.equal(
    result.redirects.some((redirect) => redirect.kind === "plugin"),
    false
  );
  assert.equal(
    result.manifest.pluginUnresolved
      + result.manifest.pluginExternalOrAmbiguous,
    unsafeTargets.length
  );
});

test("redirect chains stop at the configured depth", () => {
  const rows: RawRedirect[] = [];
  for (let index = 0; index < 4; index += 1) {
    rows.push({
      id: String(index),
      source: `/depth-${index}`,
      matchType: "url",
      regex: "0",
      status: "enabled",
      actionType: "url",
      actionCode: "301",
      actionData: `/depth-${index + 1}`
    });
  }
  rows.push({
    id: "terminal",
    source: "/depth-4",
    matchType: "url",
    regex: "0",
    status: "enabled",
    actionType: "url",
    actionCode: "301",
    actionData: "/fr/recipes/current/"
  });
  const result = resolveWprmRedirects({
    ...fixtureGraph("source", rows),
    promotedRecords: [record("20", "fr", "10", "current")],
    options: options(),
    limits: {
      ...defaultWprmImportLimits,
      maxRedirectDepth: 2
    }
  });
  assert.ok(result.manifest.pluginAccepted < rows.length);
  assert.ok(result.manifest.pluginUnresolved > 0);
  assert.ok(result.manifest.issueCodes.some((issue) =>
    issue.code === "redirect-depth"
  ));
});

test("unsafe, external, regex, disabled, and unpromoted targets are never accepted", () => {
  const result = resolver(fixtureGraph(
    "source",
    [
      {
        id: "1",
        source: "/external",
        matchType: "url",
        regex: "0",
        status: "enabled",
        actionType: "url",
        actionCode: "301",
        actionData: "https://other.test/no"
      },
      {
        id: "2",
        source: "/query",
        matchType: "url",
        regex: "0",
        status: "enabled",
        actionType: "url",
        actionCode: "301",
        actionData: "/source?x=1"
      },
      {
        id: "3",
        source: "/regex",
        matchType: "regex",
        regex: "1",
        status: "enabled",
        actionType: "url",
        actionCode: "301",
        actionData: "/source"
      },
      {
        id: "4",
        source: "/disabled",
        matchType: "url",
        regex: "0",
        status: "disabled",
        actionType: "url",
        actionCode: "301",
        actionData: "/source"
      },
      {
        id: "5",
        source: "/missing",
        matchType: "url",
        regex: "0",
        status: "enabled",
        actionType: "url",
        actionCode: "301",
        actionData: "/not-promoted/"
      }
    ]
  ));
  assert.equal(result.manifest.accepted, 2);
  assert.equal(result.manifest.pluginAccepted, 0);
  assert.ok(result.manifest.pluginExternalOrAmbiguous >= 1);
  assert.ok(result.manifest.pluginRegex >= 1);
  assert.ok(result.manifest.pluginUnsupported >= 1);
  assert.ok(result.manifest.pluginUnresolved >= 1);
});

test("cycles, semantic duplicates, and static route shadowing are explicit issues", () => {
  const fixture = fixtureGraph("source", [
    {
      id: "1",
      source: "/cycle-a",
      matchType: "url",
      regex: "0",
      status: "enabled",
      actionType: "url",
      actionCode: "301",
      actionData: "/cycle-b"
    },
    {
      id: "2",
      source: "/cycle-b",
      matchType: "url",
      regex: "0",
      status: "enabled",
      actionType: "url",
      actionCode: "301",
      actionData: "/cycle-a"
    },
    {
      id: "3",
      source: "/fr/source/",
      matchType: "url",
      regex: "0",
      status: "enabled",
      actionType: "url",
      actionCode: "301",
      actionData: "/fr/recipes/current/"
    }
  ]);
  const result = resolveWprmRedirects({
    ...fixture,
    promotedRecords: [record("20", "fr", "10", "current")],
    options: options(),
    staticRoutePaths: ["/fr/landing/"],
    azureRoutePaths: ["/fr/azure-route/", "/fr/source/"]
  });
  assert.equal(result.manifest.pluginAccepted, 0);
  assert.ok(result.manifest.pluginCycle >= 2);
  assert.ok(result.manifest.issueCodes.some((issue) =>
    issue.code === "redirect-cycle"
  ));
  const shadowed = resolveWprmRedirects({
    ...fixtureGraph("landing"),
    promotedRecords: [record("20", "fr", "10", "current")],
    options: options(),
    staticRoutePaths: ["/fr/landing/"]
  });
  assert.ok(shadowed.issues.some((issue) => issue.code === "redirect-route-shadowing"));
});
