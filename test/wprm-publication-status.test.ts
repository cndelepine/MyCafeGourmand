import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { recipeRecordSchema, type Locale } from "../src/content/schema";
import type {
  CandidateOutcome,
  RawTerm,
  RawTermTaxonomy,
  RawWordPressPost,
  RawWprmMeta,
  WprmSourceGraph,
  WprmSourceMetadata
} from "../scripts/wordpress/wprm-import-contracts";
import {
  classifyWprmCandidateDisposition,
  classifyWordPressPublicationStatus,
  defaultWprmImportLimits,
  sourcePublicationIssueCode
} from "../scripts/wordpress/wprm-import-contracts";
import {
  deriveWprmRelations,
  relationIssues
} from "../scripts/wordpress/wprm-import-relations";
import { runWprmBulkImport } from "../scripts/wordpress/wprm-import-runner";
import {
  classifyPromotionTranslationClosure,
  validatePromotionTranslationClosure,
  WprmPromotionError
} from "../scripts/wordpress/wprm-promotion";
import { recipeFixture } from "./fixtures/recipe";

const groupId = "wordpress:post-translations:status-fixture";
const bulkFixture = path.resolve(
  process.cwd(),
  "test/fixtures/wordpress/wprm-bulk.sql"
);

function record(id: string, locale: Locale = "en", group: string | null = groupId) {
  return recipeRecordSchema.parse({
    ...recipeFixture,
    id: `wordpress:wprm:${id}`,
    locale,
    translationGroupId: group,
    slug: `status-fixture-${id}`,
    source: {
      ...recipeFixture.source,
      postId: id,
      recipeId: id,
      sourceSlug: `status-fixture-${id}`
    }
  });
}

function readyOutcome(value: ReturnType<typeof record>): CandidateOutcome {
  return {
    recipeId: value.source.recipeId,
    status: "ready",
    locale: value.locale,
    codes: [],
    record: value,
    fingerprint: "ready"
  };
}

function errorOutcome(
  id: string,
  locale: Locale,
  codes: CandidateOutcome["codes"]
): CandidateOutcome {
  return {
    recipeId: id,
    status: "error",
    locale,
    codes,
    record: null,
    fingerprint: null
  };
}

function closureFor(
  selected: ReturnType<typeof record>,
  peer: CandidateOutcome | null
) {
  const outcomes = peer === null
    ? [readyOutcome(selected)]
    : [readyOutcome(selected), peer];
  const groups = new Map(outcomes.map((outcome) => [
    outcome.recipeId,
    groupId
  ] as const));
  return {
    outcomes,
    groups,
    classified: classifyPromotionTranslationClosure(
      [selected],
      outcomes,
      [],
      groups
    )
  };
}

function assertIncompleteTranslationClosure(action: () => void) {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof WprmPromotionError
      && error.code === "incomplete-translation-closure"
  );
}

for (const status of ["draft", "trash"] as const) {
  test(`a published peer remains promotable with a ${status} translation peer`, () => {
    assert.equal(classifyWordPressPublicationStatus(status), "publication-excluded");
    assert.equal(sourcePublicationIssueCode(status, "recipe"), "nonpublish-recipe");
    assert.equal(
      sourcePublicationIssueCode(status, "editorial-parent"),
      "nonpublish-editorial-parent"
    );

    const selected = record(status === "draft" ? "100" : "200");
    const { outcomes, groups, classified } = closureFor(
      selected,
      errorOutcome(status === "draft" ? "101" : "201", "fr", ["nonpublish-recipe"])
    );

    assert.deepEqual(
      {
        selected: classified.selected.length,
        excluded: classified.excluded,
        blockedGroups: classified.blockedGroups,
        intentionallyPartialGroups: classified.intentionallyPartialGroups,
        publicationExcludedPeers: classified.publicationExcludedPeers,
        integrityBlockingPeers: classified.integrityBlockingPeers
      },
      {
        selected: 1,
        excluded: 0,
        blockedGroups: 0,
        intentionallyPartialGroups: 1,
        publicationExcludedPeers: 1,
        integrityBlockingPeers: 0
      }
    );
    assert.doesNotThrow(() =>
      validatePromotionTranslationClosure(
        classified.selected,
        outcomes,
        [],
        groups
      )
    );
  });
}

test("a non-published peer with invalid media remains an integrity blocker", () => {
  const selected = record("300");
  const { outcomes, groups, classified } = closureFor(
    selected,
    errorOutcome("301", "fr", [
      "missing-attachment",
      "nonpublish-recipe"
    ])
  );

  assert.deepEqual(
    {
      selected: classified.selected.length,
      excluded: classified.excluded,
      blockedGroups: classified.blockedGroups,
      publicationExcludedPeers: classified.publicationExcludedPeers,
      integrityBlockingPeers: classified.integrityBlockingPeers
    },
    {
      selected: 0,
      excluded: 1,
      blockedGroups: 1,
      publicationExcludedPeers: 0,
      integrityBlockingPeers: 1
    }
  );
  assertIncompleteTranslationClosure(
    () => validatePromotionTranslationClosure([selected], outcomes, [], groups)
  );
});

test("non-published candidates retain media validation failures", async () => {
  const directory = mkdtempSync(path.join(process.cwd(), ".wprm-publication-status-"));
  try {
    const database = path.join(directory, "source.sql");
    const key = path.join(directory, "key");
    const fixture = readFileSync(bulkFixture, "utf8").replace(
      /;\n\nINSERT INTO `wp_terms`/u,
      ",\n  (999, 102, '_thumbnail_id', '999');\n\nINSERT INTO `wp_terms`"
    );
    writeFileSync(database, fixture);
    writeFileSync(key, randomBytes(32), { mode: 0o600 });

    const result = await runWprmBulkImport({
      database,
      fingerprintKeyFile: key,
      dryRun: true
    });
    const candidate = result.outcomes.find((outcome) => outcome.recipeId === "102");

    assert.ok(candidate);
    assert.equal(candidate.status, "error");
    assert.equal(candidate.codes.includes("nonpublish-recipe"), true);
    assert.equal(candidate.codes.includes("missing-attachment"), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a duplicate-locale peer remains an integrity blocker", () => {
  const selected = record("400");
  const { outcomes, groups, classified } = closureFor(
    selected,
    errorOutcome("401", "en", ["duplicate-parent-group-locale"])
  );

  assert.equal(classified.selected.length, 0);
  assert.equal(classified.integrityBlockingPeers, 1);
  assertIncompleteTranslationClosure(
    () => validatePromotionTranslationClosure([selected], outcomes, [], groups)
  );
});

test("an unknown source status remains an integrity blocker", () => {
  assert.equal(classifyWordPressPublicationStatus("custom-status"), "unknown");
  assert.equal(
    sourcePublicationIssueCode("custom-status", "recipe"),
    "unknown-recipe-status"
  );
  assert.equal(
    sourcePublicationIssueCode("custom-status", "editorial-parent"),
    "unknown-editorial-parent-status"
  );

  const selected = record("500");
  const { classified } = closureFor(
    selected,
    errorOutcome("501", "fr", ["unknown-recipe-status"])
  );

  assert.equal(classified.selected.length, 0);
  assert.equal(classified.integrityBlockingPeers, 1);
});

test("a structurally valid single-member translation group remains promotable", () => {
  const selected = record("600");
  const { outcomes, groups, classified } = closureFor(selected, null);

  assert.deepEqual(
    {
      selected: classified.selected.length,
      excluded: classified.excluded,
      blockedGroups: classified.blockedGroups,
      intentionallyPartialGroups: classified.intentionallyPartialGroups
    },
    {
      selected: 1,
      excluded: 0,
      blockedGroups: 0,
      intentionallyPartialGroups: 0
    }
  );
  assert.doesNotThrow(() =>
    validatePromotionTranslationClosure(classified.selected, outcomes, [], groups)
  );
});

test("the current incomplete-parent review condition remains blocking", () => {
  const selected = record("700");
  const { outcomes, groups, classified } = closureFor(
    selected,
    {
      recipeId: "701",
      status: "review",
      locale: "fr",
      codes: ["incomplete-parent-translation"],
      record: null,
      fingerprint: null
    }
  );

  assert.equal(classified.selected.length, 0);
  assert.equal(classified.blockedGroups, 1);
  assert.equal(classified.integrityBlockingPeers, 1);
  assertIncompleteTranslationClosure(
    () => validatePromotionTranslationClosure([selected], outcomes, [], groups)
  );
});

function post(
  id: string,
  type: string,
  status: string,
  parentId: string | null
): RawWordPressPost {
  return {
    id,
    type,
    status,
    hasPassword: false,
    parentId,
    slug: `fixture-${id}`,
    title: "Fixture",
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

function wprmMeta(parentId: string): RawWprmMeta {
  return {
    values: new Map([["wprm_parent_post_id", parentId]]),
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
    oldSlugs: []
  };
}

function relationFixture(
  recipeParents: readonly (readonly [string, string])[],
  groups: readonly (readonly [string, readonly string[]])[],
  reverse = false
) {
  const parentIds = [...new Set(groups.flatMap(([, members]) => members))].sort(
    (left, right) => Number(left) - Number(right)
  );
  const locales = ["en", "fr", "ru"] as const;
  const postEntries: [string, RawWordPressPost][] = [
    ...parentIds.map((id) => [
      id,
      post(id, "page", "publish", null)
    ] as [string, RawWordPressPost]),
    ...recipeParents.map(([recipeId]) => [
      recipeId,
      post(recipeId, "wprm_recipe", "publish", null)
    ] as [string, RawWordPressPost])
  ];
  const termEntries: [string, RawTerm][] = locales.map((locale) => [
    locale,
    { id: locale, name: locale, slug: locale }
  ] as [string, RawTerm]);
  const languageEntries: [string, RawTermTaxonomy][] = parentIds.map((id, index) => [
    `language-${id}`,
    {
      id: `language-${id}`,
      termId: locales[index % locales.length]!,
      taxonomy: "language"
    }
  ] as [string, RawTermTaxonomy]);
  const groupEntries: [string, RawTermTaxonomy][] = groups.map(([id]) => [
    id,
    { id, termId: "en", taxonomy: "post_translations" }
  ] as [string, RawTermTaxonomy]);
  const relationshipEntries = [
    ...parentIds.map((id) => [
      `language-${id}`,
      new Set([id])
    ] as const),
    ...groups.map(([id, members]) => [id, new Set(members)] as const)
  ];
  const metadataEntries = recipeParents.map(([recipeId, parentId]) => [
    recipeId,
    wprmMeta(parentId)
  ] as const);
  const order = <T>(values: readonly T[]) => reverse ? [...values].reverse() : [...values];
  return {
    graph: {
      posts: new Map(order(postEntries)),
      attachments: new Map(),
      terms: new Map(order(termEntries)),
      taxonomies: new Map(order([...languageEntries, ...groupEntries])),
      relationships: new Map(order(relationshipEntries)),
      redirects: [],
      oldSlugCount: 0,
      excludedRatingData: 0
    } satisfies WprmSourceGraph,
    metadata: {
      wprm: new Map(order(metadataEntries)),
      wpurSignals: new Map()
    } satisfies Pick<WprmSourceMetadata, "wprm" | "wpurSignals">
  };
}

function relationSummary(
  relations: ReturnType<typeof deriveWprmRelations>,
  recipeIds: readonly string[]
) {
  return {
    groups: recipeIds.map((recipeId) => [
      recipeId,
      relations.translationGroups.get(recipeId) ?? null
    ]),
    issues: recipeIds.map((recipeId) => [
      recipeId,
      relationIssues(relations, recipeId)
    ]),
    provenParentGroups: relations.provenParentGroups,
    incompleteParentGroups: relations.incompleteParentGroups,
    usableParentRecipesOutsideGroups: relations.usableParentRecipesOutsideGroups
  };
}

test("overlapping Polylang parent groups invalidate the full connected closure", () => {
  const recipeParents = [
    ["101", "1"],
    ["102", "2"],
    ["103", "3"],
    ["104", "4"]
  ] as const;
  const groups = [
    ["10", ["1", "2"]],
    ["20", ["2", "3"]],
    ["30", ["4"]]
  ] as const;
  const summaries = [false, true].map((reverse) => {
    const fixture = relationFixture(recipeParents, groups, reverse);
    const relations = deriveWprmRelations(
      fixture.graph,
      fixture.metadata,
      defaultWprmImportLimits
    );
    for (const recipeId of ["101", "102", "103"]) {
      assert.equal(relations.translationGroups.get(recipeId), null);
      assert.deepEqual(relationIssues(relations, recipeId).filter((code) =>
        code === "ambiguous-parent-translation-group"
      ), [
        "ambiguous-parent-translation-group"
      ]);
      assert.equal(
        classifyWprmCandidateDisposition(relationIssues(relations, recipeId)),
        "integrity-blocking"
      );
    }
    assert.equal(
      relations.translationGroups.get("104"),
      "wordpress:post-translations:30"
    );
    assert.equal(
      relationIssues(relations, "104").includes("ambiguous-parent-translation-group"),
      false
    );
    return relationSummary(relations, ["101", "102", "103", "104"]);
  });

  assert.deepEqual(summaries[0], summaries[1]);
  assert.equal(summaries[0]?.provenParentGroups, 1);
  assert.equal(summaries[0]?.usableParentRecipesOutsideGroups, 0);
});

test("identical duplicate Polylang groups keep deterministic duplicate semantics", () => {
  const recipeParents = [
    ["101", "1"],
    ["102", "2"]
  ] as const;
  const groups = [
    ["10", ["1", "2"]],
    ["20", ["1", "2"]]
  ] as const;
  const summaries = [false, true].map((reverse) => {
    const fixture = relationFixture(recipeParents, groups, reverse);
    const relations = deriveWprmRelations(
      fixture.graph,
      fixture.metadata,
      defaultWprmImportLimits
    );
    assert.equal(
      relationIssues(relations, "101").includes("ambiguous-parent-translation-group"),
      false
    );
    assert.equal(
      relationIssues(relations, "102").includes("ambiguous-parent-translation-group"),
      false
    );
    assert.equal(
      relations.translationGroups.get("101"),
      "wordpress:post-translations:20"
    );
    assert.equal(
      relations.translationGroups.get("102"),
      "wordpress:post-translations:20"
    );
    return relationSummary(relations, ["101", "102"]);
  });

  assert.deepEqual(summaries[0], summaries[1]);
  assert.equal(summaries[0]?.provenParentGroups, 2);
});

test("Polylang parent groups reject duplicate locales structurally", () => {
  const graph: WprmSourceGraph = {
    posts: new Map([
      ["1", post("1", "page", "publish", null)],
      ["2", post("2", "page", "publish", null)],
      ["100", post("100", "wprm_recipe", "publish", null)],
      ["101", post("101", "wprm_recipe", "publish", null)]
    ]),
    attachments: new Map(),
    terms: new Map([["1", { id: "1", name: "Fixture", slug: "en" }]]),
    taxonomies: new Map([
      ["10", { id: "10", termId: "1", taxonomy: "language" }],
      ["20", { id: "20", termId: "1", taxonomy: "post_translations" }]
    ]),
    relationships: new Map([
      ["10", new Set(["1", "2"])],
      ["20", new Set(["1", "2"])]
    ]),
    redirects: [],
    oldSlugCount: 0,
    excludedRatingData: 0
  };
  const metadata: Pick<WprmSourceMetadata, "wprm" | "wpurSignals"> = {
    wprm: new Map([
      ["100", wprmMeta("1")],
      ["101", wprmMeta("2")]
    ]),
    wpurSignals: new Map()
  };

  const relations = deriveWprmRelations(graph, metadata, {
    ...defaultWprmImportLimits
  });

  assert.equal(
    relationIssues(relations, "100").includes("duplicate-parent-group-locale"),
    true
  );
  assert.equal(
    relationIssues(relations, "101").includes("duplicate-parent-group-locale"),
    true
  );
});
