import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { recipeRecordSchema, type RecipeRecord } from "../src/content/schema";
import { editorialPageRecordSchema } from "../src/content/editorial-schema";
import { loadRecipeCatalog } from "../src/content/catalog";
import { loadEditorialCatalog } from "../src/content/editorial-catalog";
import { loadGalleryCatalog } from "../src/content/gallery-catalog";
import { runEditorialPromotionCli } from "../scripts/promote-wordpress-editorial";
import {
  runEditorialMediaUploadPlanCli
} from "../scripts/plan-wordpress-editorial-media-upload";
import {
  runEditorialImport
} from "../scripts/wordpress/editorial-import-runner";
import {
  EditorialPromotionError,
  isEditorialPromotionPolicyEligible,
  planEditorialPromotion,
  wpTilesGridCapacity
} from "../scripts/wordpress/editorial-promotion";
import {
  EditorialHtmlMappingError,
  mapWordPressHtmlToSafeAst
} from "../scripts/wordpress/editorial-promotion-html";
import {
  EditorialPromotionRunnerError,
  promoteEditorialStaging,
  serializeEditorialPromotionResult
} from "../scripts/wordpress/editorial-promotion-runner";
import {
  EditorialMediaUploadPlanError,
  createEditorialMediaUploadPlan,
  serializeEditorialMediaUploadPlanResult
} from "../scripts/wordpress/editorial-media-upload-plan";
import {
  publishEditorialPromotion,
  resolveEditorialPublicationRoots
} from "../scripts/wordpress/editorial-promotion-transaction";
import type {
  EditorialCandidateOutcome,
  EditorialCandidateStatus,
  EditorialIssueCode,
  EditorialMediaReference,
  EditorialPublicationDisposition,
  EditorialPublicationStatus,
  EditorialSourceSnapshot,
  RawBwgGallery,
  RawBwgImage,
  RawEditorialAttachment,
  RawEditorialAttachmentMeta,
  RawEditorialPage,
  RawEditorialPostState,
  RawWpTilesGridTemplate,
  RawTerm,
  RawTermTaxonomy
} from "../scripts/wordpress/editorial-import-contracts";
import type { UploadArchiveSummary } from "../scripts/wordpress/uploads-inventory";

const fixture = path.resolve(process.cwd(), "test/fixtures/wordpress/editorial.sql");

function crc32(value: Buffer) {
  let current = 0xffffffff;
  for (const byte of value) {
    current ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current & 1) === 1
        ? 0xedb88320 ^ (current >>> 1)
        : current >>> 1;
    }
  }
  return (current ^ 0xffffffff) >>> 0;
}

function sanitizedImageBytes(name: string) {
  const image = Buffer.from(
    "/9j/2wBDAP//////////////////////////////////////////////////////////////////////////////////////"
    + "2wBDAf//////////////////////////////////////////////////////////////////////////////////////"
    + "wAARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/"
    + "xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/"
    + "EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKAA/9k=",
    "base64"
  );
  return Buffer.concat([image, Buffer.from(`sanitized ${name}`, "utf8")]);
}

function zipArchive(names: readonly string[]) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const nameBytes = Buffer.from(name, "utf8");
    const content = sanitizedImageBytes(name);
    const checksum = crc32(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(content.byteLength, 18);
    localHeader.writeUInt32LE(content.byteLength, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    local.push(localHeader, nameBytes, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(content.byteLength, 20);
    centralHeader.writeUInt32LE(content.byteLength, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + content.byteLength;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function withDirectory<T>(callback: (directory: string) => Promise<T>) {
  const directory = mkdtempSync(path.join(process.cwd(), ".editorial-promotion-test-"));
  return callback(directory).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

function post(
  id: string,
  type: "page" | "post" | "attachment",
  overrides: Partial<RawEditorialPostState> = {}
): RawEditorialPostState {
  return {
    id,
    type,
    status: "publish",
    hasPassword: false,
    parentId: null,
    parentIdMalformed: false,
    menuOrder: type === "page" ? 0 : null,
    menuOrderMalformed: false,
    createdGmt: type === "post" ? "2024-01-01 00:00:00" : null,
    ...overrides
  };
}

function page(
  id: string,
  slug: string,
  content: string,
  overrides: Partial<RawEditorialPage> = {}
): RawEditorialPage {
  return {
    id,
    status: "publish",
    hasPassword: false,
    parentId: null,
    parentIdMalformed: false,
    authorId: null,
    slug,
    title: "Safe title",
    content,
    excerpt: null,
    createdLocal: "2024-01-01 00:00:00",
    createdGmt: "2024-01-01 00:00:00",
    modifiedLocal: null,
    modifiedGmt: null,
    guid: `https://example.test/${slug}/`,
    source: {
      ID: id,
      post_content: content,
      post_name: slug,
      post_title: "Safe title"
    },
    ...overrides
  };
}

function term(id: string, slug: string, name = slug): RawTerm {
  return { id, name, slug };
}

function taxonomy(
  id: string,
  termId: string,
  name: string,
  overrides: Partial<RawTermTaxonomy> = {}
): RawTermTaxonomy {
  return {
    id,
    termId,
    taxonomy: name,
    parentTermId: null,
    parentTermIdMalformed: false,
    ...overrides
  };
}

function archiveSummary(index = 0): UploadArchiveSummary {
  return {
    index,
    archiveSha256: "a".repeat(64),
    entryIndexContractSha256: "b".repeat(64),
    bytes: 1,
    entries: 1,
    files: 1,
    directories: 0,
    uploadFiles: 1,
    generatedDerivativeFiles: 0,
    invalidEntries: 0,
    duplicateUploadFiles: 0,
    extensions: [],
    yearMonths: []
  };
}

function gridTemplate(
  id = "900",
  overrides: Partial<RawWpTilesGridTemplate> = {}
): RawWpTilesGridTemplate {
  return {
    id,
    status: "publish",
    hasPassword: false,
    title: "Default",
    content: "AB",
    menuOrder: 0,
    menuOrderMalformed: false,
    ...overrides
  };
}

type SnapshotInput = {
  readonly attachments?: readonly RawEditorialAttachment[];
  readonly attachmentMeta?: readonly [string, RawEditorialAttachmentMeta][];
  readonly galleries?: readonly RawBwgGallery[];
  readonly galleryImages?: readonly RawBwgImage[];
  readonly gridTemplates?: readonly RawWpTilesGridTemplate[];
  readonly featuredReferences?: readonly [string, readonly (string | null)[]][];
  readonly pages?: readonly RawEditorialPage[];
  readonly posts?: readonly RawEditorialPostState[];
  readonly relationships?: readonly [string, readonly string[]][];
  readonly summaries?: readonly UploadArchiveSummary[];
  readonly terms?: readonly RawTerm[];
  readonly taxonomies?: readonly RawTermTaxonomy[];
  readonly uploadPaths?: readonly string[];
  readonly pageForPosts?: string | null;
  readonly wpTilesDefaultGrid?: string | null;
  readonly wpTilesPagination?: "ajax" | null;
};

function snapshot(input: SnapshotInput = {}): EditorialSourceSnapshot {
  const uploadPaths = input.uploadPaths ?? [];
  return {
    graph: {
      posts: new Map((input.posts ?? []).map((value) => [value.id, value])),
      pages: new Map((input.pages ?? []).map((value) => [value.id, value])),
      attachments: new Map((input.attachments ?? []).map((value) => [value.id, value])),
      attachmentMeta: new Map(input.attachmentMeta ?? []),
      featuredMediaReferences: new Map(input.featuredReferences ?? []),
      featuredReferenceCount: 0,
      featuredMediaDuplicates: new Set(),
      featuredMediaMalformed: new Set(),
      terms: new Map((input.terms ?? []).map((value) => [value.id, value])),
      taxonomies: new Map((input.taxonomies ?? []).map((value) => [value.id, value])),
      relationships: new Map(
        (input.relationships ?? []).map(([id, values]) => [id, new Set(values)])
      ),
      gridTemplates: new Map(
        (input.gridTemplates ?? [gridTemplate()]).map((value) => [value.id, value])
      ),
      galleries: new Map((input.galleries ?? []).map((value) => [value.id, value])),
      galleryImages: input.galleryImages ?? []
    },
    sql: {
      format: "sql",
      compressedBytes: 1,
      decompressedBytes: 1,
      sqlDecompressedSha256: "c".repeat(64),
      statements: 1,
      insertStatements: 1,
      rows: 1,
      createTables: 1,
      insertsByTable: {}
    },
    uploads: {
      summaries: input.summaries ?? [],
      uploadPathCounts: new Map(uploadPaths.map((value) => [value, 1])),
      uploadPathArchives: new Map(uploadPaths.map((value) => [value, new Set([0])]))
    },
    options: {
      homeOrigin: "https://example.test",
      locales: ["en", "fr", "ru"],
      pageForPosts: input.pageForPosts ?? null,
      wpTilesDefaultGrid: input.wpTilesDefaultGrid ?? null,
      wpTilesPagination: input.wpTilesPagination === undefined
        ? "ajax"
        : input.wpTilesPagination
    }
  };
}

function candidate(input: {
  readonly content: string;
  readonly id: string;
  readonly issueCodes?: readonly EditorialIssueCode[];
  readonly locale?: "en" | "fr" | "ru";
  readonly media?: readonly EditorialMediaReference[];
  readonly publicationDisposition?: EditorialPublicationDisposition;
  readonly publication?: EditorialPublicationStatus;
  readonly sourcePath: string;
  readonly status?: EditorialCandidateStatus;
  readonly translationGroupId?: string | null;
}): EditorialCandidateOutcome {
  const locale = input.locale ?? "en";
  const issueCodes = input.issueCodes ?? [];
  const publicationDisposition = input.publicationDisposition ?? "editorial-page";
  const publication = input.publication ?? "published";
  const status = input.status
    ?? (publication === "publication-excluded"
      ? "publication-excluded"
      : issueCodes.length === 0 ? "ready" : "review");
  return {
    sourceId: input.id,
    locale,
    status,
    publication,
    issueCodes,
    record: {
      schemaVersion: 1,
      kind: "wordpress-editorial-page-candidate",
      sourceId: input.id,
      locale,
      translationGroupId: input.translationGroupId ?? null,
      sourcePath: input.sourcePath,
      publicationDisposition,
      publication,
      status,
      issueCodes,
      source: {
        post: {
          ID: input.id,
          post_content: input.content,
          post_name: input.sourcePath
        },
        title: "Safe title",
        body: input.content,
        excerpt: null
      },
      structure: {
        model: "lossless-wordpress-html-v2",
        shortcodeCounts: [],
        blockCounts: [],
        links: {
          internal: 0,
          resolved: 0,
          unresolved: 0,
          unsafe: 0
        },
        inlineMediaReferences: 0,
        markupImageReferences: 0,
        unresolvedMediaReferences: 0,
        unsafeImageReferences: 0,
        externalImageReferences: 0
      },
      media: input.media ?? []
    },
    fingerprint: `${input.id}`.padStart(64, "0").slice(-64)
  };
}

function recipe(
  recipeId: string,
  editorialPostId: string,
  locale: "en" | "fr" | "ru" = "en",
  categoryTaxonomyId = "200"
): RecipeRecord {
  return recipeRecordSchema.parse({
    schemaVersion: 1,
    kind: "recipe",
    id: `wordpress:wprm:${recipeId}`,
    locale,
    translationGroupId: null,
    slug: `recipe-${recipeId}`,
    source: {
      system: "wordpress",
      postId: recipeId,
      recipeId,
      postType: "wprm_recipe",
      plugin: "wprm",
      sourceSlug: `recipe-${recipeId}`,
      createdAt: null,
      modifiedAt: null,
      editorialPostId,
      editorialPostType: "post",
      editorialSourceSlug: `editorial-${editorialPostId}`,
      editorialCreatedAt: null,
      editorialModifiedAt: null
    },
    redirectFrom: [
      `${locale === "en" ? "" : `/${locale}`}/editorial-${editorialPostId}/`
    ],
    title: `Recipe ${recipeId}`,
    description: null,
    editorial: {
      content: null,
      excerpt: null
    },
    taxonomies: [{
      scope: "editorial",
      taxonomy: "category",
      sourceId: categoryTaxonomyId,
      sourceTaxonomyId: categoryTaxonomyId,
      name: "Sweet",
      slug: "sweet"
    }],
    recipe: {
      notes: null,
      servings: null,
      times: {
        prep: null,
        cook: null,
        rest: null,
        total: null,
        custom: null
      },
      heroMediaId: null,
      ingredientGroups: [{
        name: null,
        sourceIndex: 0,
        items: [{
          sourceIndex: 0,
          raw: "one item",
          quantity: null,
          name: "item",
          notes: null
        }]
      }],
      instructionGroups: [{
        name: null,
        sourceIndex: 0,
        steps: [{
          sourceIndex: 0,
          text: "One step",
          mediaId: null
        }]
      }]
    },
    media: [],
    seo: null
  });
}

function postTile(attributes = "") {
  return `[wp-tiles post_type="post" post_status="publish" category="sweet" tag="" tax_operator="IN" orderby="date" order="DESC" posts_per_page="auto" offset="0" exclude_current_post="true" ignore_sticky_posts="true"${attributes}]`;
}

function pageTile() {
  return `[wp-tiles post_type="page" post_status="publish" category="" tag="" tax_operator="IN" orderby="menu_order" order="ASC" posts_per_page="auto" offset="0" exclude_current_post="true" ignore_sticky_posts="true" post_parent="current"]`;
}

function recipeTileFixture(content = `<p>Intro &amp; source.</p>${postTile()}`) {
  const sourcePage = page("1", "about", content);
  const firstPost = post("10", "post", { createdGmt: "2024-01-01 00:00:00" });
  const secondPost = post("11", "post", { createdGmt: "2024-02-01 00:00:00" });
  return {
    snapshot: snapshot({
      pages: [sourcePage],
      posts: [post("1", "page"), firstPost, secondPost],
      terms: [term("1", "en"), term("2", "sweet")],
      taxonomies: [
        taxonomy("100", "1", "language"),
        taxonomy("200", "2", "category")
      ],
      relationships: [
        ["100", ["1", "10", "11"]],
        ["200", ["10", "11"]]
      ]
    }),
    outcome: candidate({
      id: "1",
      sourcePath: "/about/",
      content,
      issueCodes: ["unsupported-wp-tiles"]
    }),
    recipes: [recipe("10", "10"), recipe("11", "11")]
  };
}

function assertCode(code: string) {
  return (error: unknown) =>
    error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === code;
}

test("safe editorial HTML decoding preserves entities and rejects executable or unknown markup", () => {
  const blocks = mapWordPressHtmlToSafeAst(
    "<p>Tea &amp; cake <strong>now</strong><br>soon</p>",
    {
      mapImage: () => ({ mediaId: "wordpress:attachment:1", alt: null }),
      mapLink: (href) => href,
      mapShortcode: () => ({ type: "contactForm" }),
      mapTwBwgBlock: () => ({
        type: "galleryCallout",
        galleryId: "wordpress:bwg-gallery:1"
      })
    }
  );
  assert.deepEqual(blocks, [{
    type: "paragraph",
    children: [
      { type: "text", value: "Tea & cake " },
      { type: "strong", children: [{ type: "text", value: "now" }] },
      { type: "break" },
      { type: "text", value: "soon" }
    ]
  }]);
  assert.deepEqual(mapWordPressHtmlToSafeAst(
    [
      '<div class="wp-block-group">',
      "<!-- wp:paragraph -->",
      '<p><span aria-haspopup="true" class="spell" data-g-spell-status="1" id="safe" role="button" tabindex="0">Wrapped</span></p>',
      "<!-- /wp:paragraph -->",
      "</div>"
    ].join(""),
    {
      mapImage: () => ({ mediaId: "wordpress:attachment:1", alt: null }),
      mapLink: (href) => href,
      mapShortcode: () => ({ type: "contactForm" }),
      mapTwBwgBlock: () => ({
        type: "galleryCallout",
        galleryId: "wordpress:bwg-gallery:1"
      })
    }
  ), [{
    type: "paragraph",
    children: [{ type: "text", value: "Wrapped" }]
  }]);
  assert.throws(
    () => mapWordPressHtmlToSafeAst("<script>alert(1)</script>", {
      mapImage: () => ({ mediaId: "wordpress:attachment:1", alt: null }),
      mapLink: (href) => href,
      mapShortcode: () => ({ type: "contactForm" }),
      mapTwBwgBlock: () => ({
        type: "galleryCallout",
        galleryId: "wordpress:bwg-gallery:1"
      })
    }),
    (error: unknown) =>
      error instanceof EditorialHtmlMappingError
      && error.code === "unsupported-html-tag"
  );
  assert.throws(
    () => mapWordPressHtmlToSafeAst("[unknown value=\"x\"]", {
      mapImage: () => ({ mediaId: "wordpress:attachment:1", alt: null }),
      mapLink: (href) => href,
      mapShortcode: () => {
        throw new EditorialHtmlMappingError("unsupported-shortcode");
      },
      mapTwBwgBlock: () => ({
        type: "galleryCallout",
        galleryId: "wordpress:bwg-gallery:1"
      })
    }),
    assertCode("unsupported-shortcode")
  );
  assert.deepEqual(
    mapWordPressHtmlToSafeAst("<p>[WP-TILES category=\"sweet\"]</p>", {
      mapImage: () => ({ mediaId: "wordpress:attachment:1", alt: null }),
      mapLink: (href) => href,
      mapShortcode: () => {
        throw new EditorialHtmlMappingError("unexpected-shortcode");
      },
      mapTwBwgBlock: () => ({
        type: "galleryCallout",
        galleryId: "wordpress:bwg-gallery:1"
      })
    }),
    [{
      type: "paragraph",
      children: [{ type: "text", value: "[WP-TILES category=\"sweet\"]" }]
    }]
  );
  assert.throws(
    () => mapWordPressHtmlToSafeAst("<p><strong>unterminated", {
      mapImage: () => ({ mediaId: "wordpress:attachment:1", alt: null }),
      mapLink: (href) => href,
      mapShortcode: () => ({ type: "contactForm" }),
      mapTwBwgBlock: () => ({
        type: "galleryCallout",
        galleryId: "wordpress:bwg-gallery:1"
      })
    }),
    assertCode("malformed-html")
  );
});

test("tile queries resolve exact recipe targets in deterministic source date order", () => {
  const input = recipeTileFixture();
  const first = planEditorialPromotion({
    outcomes: [input.outcome],
    recipeRecords: input.recipes,
    snapshot: input.snapshot
  });
  const second = planEditorialPromotion({
    outcomes: [input.outcome],
    recipeRecords: [...input.recipes].reverse(),
    snapshot: input.snapshot
  });
  assert.deepEqual(second, first);
  assert.deepEqual(first.records[0]?.content, [
    {
      type: "paragraph",
      children: [{ type: "text", value: "Intro & source." }]
    },
    {
      type: "recipeCardGrid",
      recipeIds: ["wordpress:wprm:11", "wordpress:wprm:10"]
    }
  ]);
  assert.equal(first.summary.candidates.selected, 1);

  const unknownAttribute = recipeTileFixture(postTile(" unexpected=\"value\""));
  const blocked = planEditorialPromotion({
    outcomes: [unknownAttribute.outcome],
    recipeRecords: unknownAttribute.recipes,
    snapshot: unknownAttribute.snapshot
  });
  assert.equal(blocked.summary.candidates.mappingBlocked, 1);
  assert.equal(blocked.summary.candidates.selected, 0);

  const externalLink = recipeTileFixture(
    `<p><a href="https://safe.example.test/path">External</a></p>${postTile()}`
  );
  const externalPlan = planEditorialPromotion({
    outcomes: [externalLink.outcome],
    recipeRecords: externalLink.recipes,
    snapshot: externalLink.snapshot
  });
  assert.deepEqual(externalPlan.records[0]?.content?.[0], {
    type: "paragraph",
    children: [{
      type: "link",
      href: "https://safe.example.test/path",
      children: [{ type: "text", value: "External" }]
    }]
  });

  const unresolvedLink = recipeTileFixture(
    `<p><a href="/not-promoted/">Missing</a></p>${postTile()}`
  );
  const unresolvedPlan = planEditorialPromotion({
    outcomes: [unresolvedLink.outcome],
    recipeRecords: unresolvedLink.recipes,
    snapshot: unresolvedLink.snapshot
  });
  assert.equal(unresolvedPlan.summary.candidates.mappingBlocked, 1);
  assert.deepEqual(unresolvedPlan.summary.candidates.mappingBlockedReasons, [{
    code: "unresolved-internal-link",
    count: 1
  }]);
});

test("WP Tiles auto capacity follows source row and adjacency traversal", () => {
  assert.equal(
    wpTilesGridCapacity(gridTemplate("901", { content: "AA..|..BB" })),
    6
  );
  assert.equal(
    wpTilesGridCapacity(gridTemplate("902", { content: "AA|AA" })),
    1
  );
  assert.equal(
    wpTilesGridCapacity(gridTemplate("903", { content: "A.A|A.A" })),
    4
  );
  assert.equal(
    wpTilesGridCapacity(gridTemplate("904", { content: "   |   " })),
    10
  );
});

test("promotion reproduces reviewed WP Tiles query semantics", () => {
  const falseTruthy = recipeTileFixture(
    postTile().replace('ignore_sticky_posts="true"', 'ignore_sticky_posts="false"')
  );
  const falseTruthyPlan = planEditorialPromotion({
    outcomes: [falseTruthy.outcome],
    recipeRecords: falseTruthy.recipes,
    snapshot: falseTruthy.snapshot
  });
  assert.equal(falseTruthyPlan.summary.candidates.mappingBlocked, 0);
  assert.deepEqual(falseTruthyPlan.records[0]?.content?.[0], {
    type: "recipeCardGrid",
    recipeIds: ["wordpress:wprm:11", "wordpress:wprm:10"]
  });

  const content = postTile(' grids="Feature"');
  const sourcePage = page("1", "about", content);
  const source = snapshot({
    pages: [sourcePage],
    posts: [
      post("1", "page"),
      post("10", "post", { createdGmt: "2024-01-01 00:00:00" }),
      post("11", "post", { createdGmt: "2024-02-01 00:00:00" })
    ],
    gridTemplates: [gridTemplate("901", { content: "A", title: "Feature" })],
    terms: [term("1", "en"), term("2", "sweet")],
    taxonomies: [
      taxonomy("100", "1", "language"),
      taxonomy("200", "2", "category")
    ],
    relationships: [
      ["100", ["1", "10", "11"]],
      ["200", ["10", "11"]]
    ]
  });
  const outcome = candidate({
    id: "1",
    sourcePath: "/about/",
    content,
    issueCodes: ["unsupported-wp-tiles"]
  });
  const capacityPlan = planEditorialPromotion({
    outcomes: [outcome],
    recipeRecords: [recipe("10", "10"), recipe("11", "11")],
    snapshot: source
  });
  assert.deepEqual(capacityPlan.records[0]?.content, [{
    type: "recipeCardGrid",
    recipeIds: ["wordpress:wprm:11", "wordpress:wprm:10"]
  }]);

  const regionalCellContent = postTile(' grids="Feature"');
  const regionalCellPlan = planEditorialPromotion({
    outcomes: [candidate({
      id: "1",
      sourcePath: "/about/",
      content: regionalCellContent,
      issueCodes: ["unsupported-wp-tiles"]
    })],
    recipeRecords: [
      recipe("10", "10"),
      recipe("11", "11"),
      recipe("12", "12"),
      recipe("13", "13"),
      recipe("14", "14"),
      recipe("15", "15"),
      recipe("16", "16")
    ],
    snapshot: snapshot({
      pages: [page("1", "about", regionalCellContent)],
      posts: [
        post("1", "page"),
        post("10", "post", { createdGmt: "2024-01-01 00:00:00" }),
        post("11", "post", { createdGmt: "2024-02-01 00:00:00" }),
        post("12", "post", { createdGmt: "2024-03-01 00:00:00" }),
        post("13", "post", { createdGmt: "2024-04-01 00:00:00" }),
        post("14", "post", { createdGmt: "2024-05-01 00:00:00" }),
        post("15", "post", { createdGmt: "2024-06-01 00:00:00" }),
        post("16", "post", { createdGmt: "2024-07-01 00:00:00" })
      ],
      gridTemplates: [gridTemplate("901", {
        content: "AA..|..BB",
        title: "Feature"
      })],
      terms: [term("1", "en"), term("2", "sweet")],
      taxonomies: [
        taxonomy("100", "1", "language"),
        taxonomy("200", "2", "category")
      ],
      relationships: [
        ["100", ["1", "10", "11", "12", "13", "14", "15", "16"]],
        ["200", ["10", "11", "12", "13", "14", "15", "16"]]
      ]
    })
  });
  assert.deepEqual(regionalCellPlan.records[0]?.content, [{
    type: "recipeCardGrid",
    recipeIds: [
      "wordpress:wprm:16",
      "wordpress:wprm:15",
      "wordpress:wprm:14",
      "wordpress:wprm:13",
      "wordpress:wprm:12",
      "wordpress:wprm:11",
      "wordpress:wprm:10"
    ]
  }]);

  const ajaxContent = postTile(' grids="Feature" pagination="ajax"');
  const ajaxPlan = planEditorialPromotion({
    outcomes: [candidate({
      id: "1",
      sourcePath: "/about/",
      content: ajaxContent,
      issueCodes: ["unsupported-wp-tiles"]
    })],
    recipeRecords: [recipe("10", "10"), recipe("11", "11")],
    snapshot: snapshot({
      pages: [page("1", "about", ajaxContent)],
      posts: [
        post("1", "page"),
        post("10", "post", { createdGmt: "2024-01-01 00:00:00" }),
        post("11", "post", { createdGmt: "2024-02-01 00:00:00" })
      ],
      gridTemplates: [gridTemplate("901", { content: "A", title: "Feature" })],
      terms: [term("1", "en"), term("2", "sweet")],
      taxonomies: [
        taxonomy("100", "1", "language"),
        taxonomy("200", "2", "category")
      ],
      relationships: [
        ["100", ["1", "10", "11"]],
        ["200", ["10", "11"]]
      ]
    })
  });
  assert.deepEqual(ajaxPlan.records[0]?.content, [{
    type: "recipeCardGrid",
    recipeIds: ["wordpress:wprm:11", "wordpress:wprm:10"]
  }]);

  const inheritedAjaxContent = postTile(' grids="Feature"');
  const inheritedAjaxPlan = planEditorialPromotion({
    outcomes: [candidate({
      id: "1",
      sourcePath: "/about/",
      content: inheritedAjaxContent,
      issueCodes: ["unsupported-wp-tiles"]
    })],
    recipeRecords: [recipe("10", "10"), recipe("11", "11")],
    snapshot: snapshot({
      pages: [page("1", "about", inheritedAjaxContent)],
      posts: [
        post("1", "page"),
        post("10", "post", { createdGmt: "2024-01-01 00:00:00" }),
        post("11", "post", { createdGmt: "2024-02-01 00:00:00" })
      ],
      gridTemplates: [gridTemplate("901", { content: "A", title: "Feature" })],
      terms: [term("1", "en"), term("2", "sweet")],
      taxonomies: [
        taxonomy("100", "1", "language"),
        taxonomy("200", "2", "category")
      ],
      relationships: [
        ["100", ["1", "10", "11"]],
        ["200", ["10", "11"]]
      ],
      wpTilesPagination: "ajax"
    })
  });
  assert.deepEqual(inheritedAjaxPlan.records[0]?.content, [{
    type: "recipeCardGrid",
    recipeIds: ["wordpress:wprm:11", "wordpress:wprm:10"]
  }]);

  const missingPaginationPlan = planEditorialPromotion({
    outcomes: [candidate({
      id: "1",
      sourcePath: "/about/",
      content: inheritedAjaxContent,
      issueCodes: ["unsupported-wp-tiles"]
    })],
    recipeRecords: [recipe("10", "10"), recipe("11", "11")],
    snapshot: snapshot({
      pages: [page("1", "about", inheritedAjaxContent)],
      posts: [
        post("1", "page"),
        post("10", "post", { createdGmt: "2024-01-01 00:00:00" }),
        post("11", "post", { createdGmt: "2024-02-01 00:00:00" })
      ],
      gridTemplates: [gridTemplate("901", { content: "A", title: "Feature" })],
      terms: [term("1", "en"), term("2", "sweet")],
      taxonomies: [
        taxonomy("100", "1", "language"),
        taxonomy("200", "2", "category")
      ],
      relationships: [
        ["100", ["1", "10", "11"]],
        ["200", ["10", "11"]]
      ],
      wpTilesPagination: null
    })
  });
  assert.deepEqual(missingPaginationPlan.summary.candidates.mappingBlockedReasons, [{
    code: "missing-wp-tiles-pagination-option",
    count: 1
  }]);

  const sourceEmptyContent = `<p>Visible.</p>${
    postTile().replace('category="sweet"', 'category="source-term-absent"')
  }`;
  const sourceEmptyPlan = planEditorialPromotion({
    outcomes: [candidate({
      id: "1",
      sourcePath: "/about/",
      content: sourceEmptyContent,
      issueCodes: ["unsupported-wp-tiles"]
    })],
    recipeRecords: [],
    snapshot: snapshot({
      pages: [page("1", "about", sourceEmptyContent)],
      posts: [post("1", "page")],
      terms: [term("1", "en"), term("2", "sweet")],
      taxonomies: [
        taxonomy("100", "1", "language"),
        taxonomy("200", "2", "category")
      ],
      relationships: [["100", ["1"]]]
    })
  });
  assert.equal(sourceEmptyPlan.summary.candidates.mappingBlocked, 0);
  assert.deepEqual(sourceEmptyPlan.summary.candidates.mappingBlockedReasons, []);
  assert.equal(sourceEmptyPlan.summary.candidates.selected, 1);
  assert.equal(sourceEmptyPlan.summary.candidates.approvedEmptyCardGrids, 1);
  assert.deepEqual(sourceEmptyPlan.summary.candidates.approvedEmptyCardGridReasons, [{
    code: "source-category-missing",
    count: 1
  }]);
  assert.deepEqual(sourceEmptyPlan.records[0]?.content, [
    {
      type: "paragraph",
      children: [{ type: "text", value: "Visible." }]
    },
    {
      type: "emptyCardGrid",
      reason: "source-category-missing"
    }
  ]);
  assert.equal(
    JSON.stringify({
      records: sourceEmptyPlan.records,
      summary: sourceEmptyPlan.summary
    }).includes("source-term-absent"),
    false
  );

  const emptyExistingCategoryContent = postTile();
  const emptyExistingCategoryPlan = planEditorialPromotion({
    outcomes: [candidate({
      id: "1",
      sourcePath: "/about/",
      content: emptyExistingCategoryContent,
      issueCodes: ["unsupported-wp-tiles"]
    })],
    recipeRecords: [],
    snapshot: snapshot({
      pages: [page("1", "about", emptyExistingCategoryContent)],
      posts: [post("1", "page")],
      terms: [term("1", "en"), term("2", "sweet")],
      taxonomies: [
        taxonomy("100", "1", "language"),
        taxonomy("200", "2", "category")
      ],
      relationships: [["100", ["1"]]]
    })
  });
  assert.equal(emptyExistingCategoryPlan.summary.candidates.mappingBlocked, 1);
  assert.deepEqual(emptyExistingCategoryPlan.summary.candidates.mappingBlockedReasons, [{
    code: "empty-wp-tiles-selection",
    count: 1
  }]);
  assert.equal(emptyExistingCategoryPlan.summary.candidates.approvedEmptyCardGrids, 0);
  assert.deepEqual(
    emptyExistingCategoryPlan.summary.candidates.approvedEmptyCardGridReasons,
    []
  );

  const emptyPageGridContent = pageTile();
  const emptyPageGridPlan = planEditorialPromotion({
    outcomes: [candidate({
      id: "1",
      sourcePath: "/about/",
      content: emptyPageGridContent,
      issueCodes: ["unsupported-wp-tiles"]
    })],
    recipeRecords: [],
    snapshot: snapshot({
      pages: [page("1", "about", emptyPageGridContent)],
      posts: [post("1", "page")],
      terms: [term("1", "en")],
      taxonomies: [taxonomy("100", "1", "language")],
      relationships: [["100", ["1"]]]
    })
  });
  assert.equal(emptyPageGridPlan.summary.candidates.mappingBlocked, 1);
  assert.equal(emptyPageGridPlan.summary.candidates.selected, 0);
  assert.deepEqual(emptyPageGridPlan.summary.candidates.mappingBlockedReasons, [{
    code: "empty-wp-tiles-selection",
    count: 1
  }]);
  assert.equal(emptyPageGridPlan.summary.candidates.approvedEmptyCardGrids, 0);
  assert.deepEqual(emptyPageGridPlan.summary.candidates.approvedEmptyCardGridReasons, []);

  const nonRecipePlan = planEditorialPromotion({
    outcomes: [outcome],
    recipeRecords: [],
    snapshot: source
  });
  assert.equal(nonRecipePlan.summary.candidates.mappingBlocked, 1);
  assert.deepEqual(nonRecipePlan.summary.candidates.mappingBlockedReasons, [{
    code: "unresolved-wp-tiles-recipe-target",
    count: 1
  }]);
});

test("WP Tiles category selectors use slugs and ignore display names", () => {
  const nameContent = postTile().replace(
    'category="sweet"',
    'category="Display Category Alpha"'
  );
  const byName = planEditorialPromotion({
    outcomes: [candidate({
      id: "1",
      sourcePath: "/about/",
      content: nameContent,
      issueCodes: ["unsupported-wp-tiles"]
    })],
    recipeRecords: [],
    snapshot: snapshot({
      pages: [page("1", "about", nameContent)],
      posts: [
        post("1", "page"),
        post("10", "post", { createdGmt: "2024-01-01 00:00:00" })
      ],
      terms: [
        term("1", "en"),
        term("2", "display-category-alpha", "Display Category Alpha")
      ],
      taxonomies: [
        taxonomy("100", "1", "language"),
        taxonomy("200", "2", "category")
      ],
      relationships: [
        ["100", ["1", "10"]],
        ["200", ["10"]]
      ]
    })
  });
  assert.deepEqual(byName.records[0]?.content, [{
    type: "emptyCardGrid",
    reason: "source-category-missing"
  }]);

  const slugContent = postTile().replace(
    'category="sweet"',
    'category="shared-selector"'
  );
  const bySlug = planEditorialPromotion({
    outcomes: [candidate({
      id: "1",
      sourcePath: "/about/",
      content: slugContent,
      issueCodes: ["unsupported-wp-tiles"]
    })],
    recipeRecords: [recipe("10", "10")],
    snapshot: snapshot({
      pages: [page("1", "about", slugContent)],
      posts: [
        post("1", "page"),
        post("10", "post", { createdGmt: "2024-01-01 00:00:00" })
      ],
      terms: [
        term("1", "en"),
        term("2", "shared-selector", "First Selector"),
        term("3", "second-selector", "shared-selector")
      ],
      taxonomies: [
        taxonomy("100", "1", "language"),
        taxonomy("200", "2", "category"),
        taxonomy("201", "3", "category")
      ],
      relationships: [
        ["100", ["1", "10"]],
        ["200", ["10"]]
      ]
    })
  });
  assert.deepEqual(bySlug.records[0]?.content, [{
    type: "recipeCardGrid",
    recipeIds: ["wordpress:wprm:10"]
  }]);
});

test("WP Tiles category selectors prefer one exact current-locale match", () => {
  const content = postTile().replace(
    'category="sweet"',
    'category="shared-selector"'
  );
  const localized = planEditorialPromotion({
    outcomes: [candidate({
      id: "1",
      locale: "fr",
      sourcePath: "/fr/about/",
      content,
      issueCodes: ["unsupported-wp-tiles"]
    })],
    recipeRecords: [recipe("10", "10", "fr", "201")],
    snapshot: snapshot({
      pages: [page("1", "about", content, {
        guid: "https://example.test/fr/about/"
      })],
      posts: [
        post("1", "page"),
        post("10", "post", { createdGmt: "2024-01-01 00:00:00" })
      ],
      terms: [
        term("1", "fr"),
        term("2", "pll_en"),
        term("3", "pll_fr"),
        term("4", "shared-selector", "Foreign selector"),
        term("5", "shared-selector", "Current selector")
      ],
      taxonomies: [
        taxonomy("100", "1", "language"),
        taxonomy("101", "2", "term_language"),
        taxonomy("102", "3", "term_language"),
        taxonomy("200", "4", "category"),
        taxonomy("201", "5", "category")
      ],
      relationships: [
        ["100", ["1", "10"]],
        ["101", ["4"]],
        ["102", ["5"]],
        ["201", ["10"]]
      ]
    })
  });
  assert.equal(localized.summary.candidates.mappingBlocked, 0);
  assert.deepEqual(localized.records[0]?.content, [{
    type: "recipeCardGrid",
    recipeIds: ["wordpress:wprm:10"]
  }]);

  const sameLocaleDuplicate = planEditorialPromotion({
    outcomes: [candidate({
      id: "1",
      locale: "fr",
      sourcePath: "/fr/about/",
      content,
      issueCodes: ["unsupported-wp-tiles"]
    })],
    recipeRecords: [],
    snapshot: snapshot({
      pages: [page("1", "about", content, {
        guid: "https://example.test/fr/about/"
      })],
      posts: [post("1", "page")],
      terms: [
        term("1", "fr"),
        term("2", "pll_fr"),
        term("3", "shared-selector"),
        term("4", "shared-selector")
      ],
      taxonomies: [
        taxonomy("100", "1", "language"),
        taxonomy("101", "2", "term_language"),
        taxonomy("200", "3", "category"),
        taxonomy("201", "4", "category")
      ],
      relationships: [
        ["100", ["1"]],
        ["101", ["3", "4"]]
      ]
    })
  });
  assert.deepEqual(
    sameLocaleDuplicate.summary.candidates.mappingBlockedReasons,
    [{
      code: "ambiguous-wp-tiles-category",
      count: 1
    }]
  );
});

test("WP Tiles category selectors honor locale translations and reject conflicts", () => {
  const content = postTile().replace(
    'category="sweet"',
    'category="source-category"'
  );
  const localized = planEditorialPromotion({
    outcomes: [candidate({
      id: "1",
      locale: "fr",
      sourcePath: "/fr/about/",
      content,
      issueCodes: ["unsupported-wp-tiles"]
    })],
    recipeRecords: [recipe("10", "10", "fr", "201")],
    snapshot: snapshot({
      pages: [page("1", "about", content, {
        guid: "https://example.test/fr/about/"
      })],
      posts: [
        post("1", "page"),
        post("10", "post", { createdGmt: "2024-01-01 00:00:00" })
      ],
      terms: [
        term("1", "fr"),
        term("2", "pll_en"),
        term("3", "source-category", "Source Category Name"),
        term("4", "target-category", "Target Category Name"),
        term("5", "translation-group"),
        term("6", "pll_fr")
      ],
      taxonomies: [
        taxonomy("100", "1", "language"),
        taxonomy("101", "2", "term_language"),
        taxonomy("102", "6", "term_language"),
        taxonomy("103", "5", "term_translations"),
        taxonomy("200", "3", "category"),
        taxonomy("201", "4", "category")
      ],
      relationships: [
        ["100", ["1", "10"]],
        ["101", ["3"]],
        ["102", ["4"]],
        ["103", ["3", "4"]],
        ["201", ["10"]]
      ]
    })
  });
  assert.deepEqual(localized.records[0]?.content, [{
    type: "recipeCardGrid",
    recipeIds: ["wordpress:wprm:10"]
  }]);

  const conflicting = planEditorialPromotion({
    outcomes: [candidate({
      id: "1",
      locale: "fr",
      sourcePath: "/fr/about/",
      content,
      issueCodes: ["unsupported-wp-tiles"]
    })],
    recipeRecords: [],
    snapshot: snapshot({
      pages: [page("1", "about", content, {
        guid: "https://example.test/fr/about/"
      })],
      posts: [post("1", "page")],
      terms: [
        term("1", "fr"),
        term("2", "pll_en"),
        term("3", "source-category", "Source Category Name"),
        term("4", "target-category-one", "Target Category One"),
        term("5", "target-category-two", "Target Category Two"),
        term("6", "translation-group"),
        term("7", "pll_fr")
      ],
      taxonomies: [
        taxonomy("100", "1", "language"),
        taxonomy("101", "2", "term_language"),
        taxonomy("102", "7", "term_language"),
        taxonomy("103", "6", "term_translations"),
        taxonomy("200", "3", "category"),
        taxonomy("201", "4", "category"),
        taxonomy("202", "5", "category")
      ],
      relationships: [
        ["100", ["1"]],
        ["101", ["3"]],
        ["102", ["4", "5"]],
        ["103", ["3", "4", "5"]]
      ]
    })
  });
  assert.deepEqual(conflicting.summary.candidates.mappingBlockedReasons, [{
    code: "conflicting-wp-tiles-category-translation",
    count: 1
  }]);
});

test("promotion decodes source slugs and includes category descendants", () => {
  const content = postTile();
  const encodedSlugPlan = planEditorialPromotion({
    outcomes: [candidate({
      id: "1",
      sourcePath: "/café/",
      content,
      issueCodes: ["unsupported-wp-tiles"]
    })],
    recipeRecords: [recipe("10", "10"), recipe("11", "11")],
    snapshot: snapshot({
      pages: [page("1", "caf%C3%A9", content, {
        guid: "https://example.test/caf%C3%A9/"
      })],
      posts: [
        post("1", "page"),
        post("10", "post", { createdGmt: "2024-01-01 00:00:00" }),
        post("11", "post", { createdGmt: "2024-02-01 00:00:00" })
      ],
      terms: [term("1", "en"), term("2", "sweet")],
      taxonomies: [
        taxonomy("100", "1", "language"),
        taxonomy("200", "2", "category")
      ],
      relationships: [
        ["100", ["1", "10", "11"]],
        ["200", ["10", "11"]]
      ]
    })
  });
  assert.equal(encodedSlugPlan.records[0]?.canonicalPath, "/café/");

  const descendantPlan = planEditorialPromotion({
    outcomes: [candidate({
      id: "1",
      sourcePath: "/about/",
      content,
      issueCodes: ["unsupported-wp-tiles"]
    })],
    recipeRecords: [recipe("10", "10", "en", "201")],
    snapshot: snapshot({
      pages: [page("1", "about", content)],
      posts: [
        post("1", "page"),
        post("10", "post", { createdGmt: "2024-01-01 00:00:00" })
      ],
      terms: [term("1", "en"), term("2", "sweet"), term("3", "child")],
      taxonomies: [
        taxonomy("100", "1", "language"),
        taxonomy("200", "2", "category"),
        taxonomy("201", "3", "category", { parentTermId: "2" })
      ],
      relationships: [
        ["100", ["1", "10"]],
        ["201", ["10"]]
      ]
    })
  });
  assert.deepEqual(descendantPlan.records[0]?.content, [{
    type: "recipeCardGrid",
    recipeIds: ["wordpress:wprm:10"]
  }]);
});

test("policy accepts only mapped issue combinations and exact featured ambiguity proof", () => {
  const sourcePage = page("1", "about", "<p>Safe</p>");
  const attachment: RawEditorialAttachment = {
    id: "10",
    status: "inherit",
    hasPassword: false,
    parentId: null,
    parentIdMalformed: false,
    mimeType: "image/jpeg",
    guid: "https://example.test/wp-content/uploads/media/photo.jpg",
    source: {}
  };
  const input = snapshot({
    pages: [sourcePage],
    posts: [post("1", "page")],
    attachments: [attachment],
    attachmentMeta: [[
      "10",
      {
        attachedFile: "media/photo.jpg",
        alt: null,
        duplicateKeys: new Set(),
        width: 800,
        height: 600
      }
    ]],
    summaries: [archiveSummary()],
    uploadPaths: ["media/photo.jpg"],
    featuredReferences: [["1", ["10"]]],
    terms: [term("1", "en")],
    taxonomies: [taxonomy("100", "1", "language")],
    relationships: [["100", ["1"]]]
  });
  const featured: EditorialMediaReference = {
    sourceId: "10",
    roles: ["featured"],
    mimeType: "image/jpeg",
    attachedFile: "media/photo.jpg",
    alt: null,
    archiveMatch: "matched",
    width: 800,
    height: 600
  };
  const cases: Array<{
    readonly accepted: boolean;
    readonly issueCodes: readonly EditorialIssueCode[];
    readonly publication?: EditorialPublicationStatus;
    readonly media?: readonly EditorialMediaReference[];
  }> = [
    { accepted: true, issueCodes: [] },
    { accepted: true, issueCodes: ["unsupported-wp-tiles"] },
    {
      accepted: true,
      issueCodes: ["ambiguous-attachment-path", "unsupported-wp-tiles"],
      media: [featured]
    },
    {
      accepted: true,
      issueCodes: ["unsupported-block", "unsupported-wp-tiles"]
    },
    { accepted: true, issueCodes: ["unsupported-contact-form-7"] },
    { accepted: false, issueCodes: ["unresolved-inline-media"] },
    {
      accepted: false,
      issueCodes: ["nonpublish-page"],
      publication: "publication-excluded"
    },
    {
      accepted: false,
      issueCodes: ["ambiguous-attachment-path", "unsupported-wp-tiles"],
      media: [{
        ...featured,
        roles: ["inline"]
      }]
    }
  ];
  for (const [index, value] of cases.entries()) {
    const outcome = candidate({
      id: "1",
      sourcePath: "/about/",
      content: "<p>Safe</p>",
      issueCodes: value.issueCodes,
      publication: value.publication,
      media: value.media
    });
    assert.equal(
      isEditorialPromotionPolicyEligible(outcome, input),
      value.accepted,
      `policy case ${index + 1}`
    );
  }
  assert.equal(
    isEditorialPromotionPolicyEligible(candidate({
      id: "25283",
      sourcePath: "/privacy-policy/",
      content: "<p>Obsolete policy</p>",
      issueCodes: []
    }), input),
    false
  );

  const featuredPlan = planEditorialPromotion({
    outcomes: [candidate({
      id: "1",
      sourcePath: "/about/",
      content: "<p>Safe</p>",
      media: [{
        ...featured,
        alt: "Source-backed alternative"
      }]
    })],
    recipeRecords: [],
    snapshot: input
  });
  assert.equal(
    featuredPlan.records[0]?.featuredMediaAlt,
    "Source-backed alternative"
  );
});

test("editorial redirects retain only a different safe source-proven GUID path", () => {
  const sourcePage = page("1", "about", "<p>Safe</p>", {
    guid: "https://example.test/legacy-about/"
  });
  const plan = planEditorialPromotion({
    outcomes: [candidate({
      id: "1",
      sourcePath: "/about/",
      content: "<p>Safe</p>"
    })],
    recipeRecords: [],
    snapshot: snapshot({
      pages: [sourcePage],
      posts: [post("1", "page")],
      terms: [term("1", "en")],
      taxonomies: [taxonomy("100", "1", "language")],
      relationships: [["100", ["1"]]]
    })
  });
  assert.deepEqual(plan.records[0]?.redirectFrom, ["/legacy-about/"]);
});

test("editorial promotion reserves contact-success and generated search paths", () => {
  for (const [parentSlug, childSlug] of [
    ["contact", "success"],
    ["_search", "en.json"]
  ] as const) {
    const parentPath = `/${parentSlug}/`;
    const childPath = `${parentPath}${childSlug}/`;
    const content = "<p>Safe</p>";
    const parent = page("1", parentSlug, content);
    const child = page("2", childSlug, content, {
      parentId: "1",
      guid: `https://example.test/${parentSlug}/${childSlug}/`
    });
    assert.throws(
      () => planEditorialPromotion({
        outcomes: [
          candidate({
            id: "1",
            sourcePath: parentPath,
            content
          }),
          candidate({
            id: "2",
            sourcePath: childPath,
            content
          })
        ],
        recipeRecords: [],
        snapshot: snapshot({
          pages: [parent, child],
          posts: [
            post("1", "page"),
            post("2", "page", { parentId: "1", menuOrder: 0 })
          ],
          terms: [term("1", "en")],
          taxonomies: [taxonomy("100", "1", "language")],
          relationships: [["100", ["1", "2"]]]
        })
      }),
      assertCode("invalid-promoted-public-content-closure")
    );
  }
});

test("page-grid, hierarchy, and translation closure remove incomplete public selections", () => {
  const parentContent = pageTile();
  const parent = page("1", "about", parentContent);
  const child = page("2", "child", "<p>Child</p>", {
    parentId: "1",
    guid: "https://example.test/about/child/"
  });
  const parentPost = post("1", "page");
  const childPost = post("2", "page", { parentId: "1", menuOrder: 1 });
  const input = snapshot({
    pages: [parent, child],
    posts: [parentPost, childPost],
    terms: [term("1", "en")],
    taxonomies: [taxonomy("100", "1", "language")],
    relationships: [["100", ["1", "2"]]]
  });
  const parentOutcome = candidate({
    id: "1",
    sourcePath: "/about/",
    content: parentContent,
    issueCodes: ["unsupported-wp-tiles"]
  });
  const childOutcome = candidate({
    id: "2",
    sourcePath: "/about/child/",
    content: "<p>Child</p>",
    issueCodes: ["unresolved-inline-media"]
  });
  const blockedReference = planEditorialPromotion({
    outcomes: [parentOutcome, childOutcome],
    recipeRecords: [],
    snapshot: input
  });
  assert.equal(blockedReference.summary.candidates.selected, 0);
  assert.equal(blockedReference.summary.candidates.referenceBlocked, 1);

  const blockedHierarchy = planEditorialPromotion({
    outcomes: [
      candidate({
        id: "1",
        sourcePath: "/about/",
        content: parentContent,
        issueCodes: ["unresolved-inline-media"]
      }),
      candidate({
        id: "2",
        sourcePath: "/about/child/",
        content: "<p>Child</p>"
      })
    ],
    recipeRecords: [],
    snapshot: input
  });
  assert.equal(blockedHierarchy.summary.candidates.selected, 0);
  assert.equal(blockedHierarchy.summary.candidates.hierarchyBlocked, 1);

  const english = page("1", "about", "<p>English</p>");
  const french = page("2", "a-propos", "<p>French</p>", {
    guid: "https://example.test/fr/a-propos/"
  });
  const translations = snapshot({
    pages: [english, french],
    posts: [post("1", "page"), post("2", "page")],
    terms: [term("1", "en"), term("2", "fr")],
    taxonomies: [
      taxonomy("100", "1", "language"),
      taxonomy("101", "2", "language")
    ],
    relationships: [
      ["100", ["1"]],
      ["101", ["2"]]
    ]
  });
  const translated = planEditorialPromotion({
    outcomes: [
      candidate({
        id: "1",
        sourcePath: "/about/",
        content: "<p>English</p>",
        translationGroupId: "900"
      }),
      candidate({
        id: "2",
        locale: "fr",
        sourcePath: "/fr/a-propos/",
        content: "<p>French</p>",
        issueCodes: ["unresolved-inline-media"],
        translationGroupId: "900"
      })
    ],
    recipeRecords: [],
    snapshot: translations
  });
  assert.equal(translated.summary.candidates.selected, 0);
  assert.equal(translated.summary.candidates.translationBlocked, 1);
});

test("gallery and provider-neutral contact blocks map source-backed public records", () => {
  const galleryContent = [
    "<!-- wp:tw/bwg {\"popupOpened\":false,\"notInitial\":false} /-->",
    postTile()
  ].join("");
  const sourcePage = page("1", "about", galleryContent);
  const gallery: RawBwgGallery = {
    id: "300",
    source: {
      name: "Gallery",
      description: null,
      published: "1"
    }
  };
  const image: RawBwgImage = {
    id: "301",
    galleryId: "300",
    galleryIdState: "present",
    imageUrl: "photo-gallery/album/original.jpg",
    thumbUrl: "photo-gallery/album/thumb.jpg",
    resolution: "1200 x 800 px",
    alt: "Source alt",
    description: "Source caption",
    order: 0,
    orderMalformed: false,
    source: {
      published: "1"
    }
  };
  const galleryPlan = planEditorialPromotion({
    outcomes: [candidate({
      id: "1",
      sourcePath: "/about/",
      content: galleryContent,
      issueCodes: ["unsupported-block", "unsupported-wp-tiles"]
    })],
    recipeRecords: [recipe("10", "10"), recipe("11", "11")],
    snapshot: snapshot({
      pages: [sourcePage],
      posts: [
        post("1", "page"),
        post("10", "post", { createdGmt: "2024-01-01 00:00:00" }),
        post("11", "post", { createdGmt: "2024-02-01 00:00:00" })
      ],
      terms: [term("1", "en"), term("2", "sweet")],
      taxonomies: [
        taxonomy("100", "1", "language"),
        taxonomy("200", "2", "category")
      ],
      relationships: [
        ["100", ["1", "10", "11"]],
        ["200", ["10", "11"]]
      ],
      galleries: [gallery],
      galleryImages: [image],
      summaries: [archiveSummary()],
      uploadPaths: [
        "photo-gallery/album/original.jpg",
        "photo-gallery/album/thumb.jpg"
      ]
    })
  });
  assert.throws(
    () => planEditorialPromotion({
      outcomes: [candidate({
        id: "1",
        sourcePath: "/about/",
        content: galleryContent,
        issueCodes: ["unsupported-block", "unsupported-wp-tiles"]
      })],
      recipeRecords: [recipe("10", "10"), recipe("11", "11")],
      snapshot: snapshot({
        pages: [sourcePage],
        posts: [
          post("1", "page"),
          post("10", "post", { createdGmt: "2024-01-01 00:00:00" }),
          post("11", "post", { createdGmt: "2024-02-01 00:00:00" })
        ],
        terms: [term("1", "en"), term("2", "sweet")],
        taxonomies: [
          taxonomy("100", "1", "language"),
          taxonomy("200", "2", "category")
        ],
        relationships: [
          ["100", ["1", "10", "11"]],
          ["200", ["10", "11"]]
        ],
        galleries: [{
          ...gallery,
          source: { ...gallery.source, published: "0" }
        }],
        galleryImages: [image],
        summaries: [archiveSummary()],
        uploadPaths: [
          "photo-gallery/album/original.jpg",
          "photo-gallery/album/thumb.jpg"
        ]
      })
    }),
    (error: unknown) =>
      error instanceof EditorialPromotionError
      && error.code === "nonpublish-gallery"
  );
  assert.equal(galleryPlan.gallery?.canonicalPath, "/gallery/");
  assert.equal(galleryPlan.gallery?.images.length, 1);
  assert.equal(galleryPlan.summary.media.galleryBindings, 2);
  assert.equal(
    galleryPlan.records[0]?.content?.some((block) => block.type === "galleryCallout"),
    true
  );

  const contactContent = `<p>Source intro.</p>[contact-form-7 id="7" title="Contact"]`;
  const contactPlan = planEditorialPromotion({
    outcomes: [candidate({
      id: "1",
      sourcePath: "/about/",
      content: contactContent,
      issueCodes: ["unsupported-contact-form-7"]
    })],
    recipeRecords: [],
    snapshot: snapshot({
      pages: [page("1", "about", contactContent)],
      posts: [post("1", "page")],
      terms: [term("1", "en")],
      taxonomies: [taxonomy("100", "1", "language")],
      relationships: [["100", ["1"]]]
    })
  });
  assert.deepEqual(contactPlan.records[0]?.content, [
    {
      type: "paragraph",
      children: [{ type: "text", value: "Source intro." }]
    },
    { type: "contactForm" }
  ]);
});

function editorialImportOptions(directory: string) {
  const archive = path.join(directory, "uploads.zip");
  const key = path.join(directory, "fingerprint.key");
  writeFileSync(
    archive,
    zipArchive([
      "uploads/2026/01/photo.jpg",
      "uploads/photo-gallery/album/original.jpg",
      "uploads/photo-gallery/album/thumb.jpg"
    ])
  );
  writeFileSync(key, randomBytes(32), { mode: 0o600 });
  chmodSync(key, 0o600);
  return {
    database: fixture,
    fingerprintKeyFile: key,
    uploadsDir: directory
  };
}

function expectedPlan(imported: Awaited<ReturnType<typeof runEditorialImport>>) {
  const plan = planEditorialPromotion({
    outcomes: imported.outcomes,
    recipeRecords: loadRecipeCatalog(),
    snapshot: imported.snapshot
  });
  return {
    expected: {
      ready: imported.outcomes.filter((outcome) => outcome.status === "ready").length,
      review: imported.outcomes.filter((outcome) => outcome.status === "review").length,
      publicationExcluded: imported.outcomes.filter(
        (outcome) => outcome.status === "publication-excluded"
      ).length,
      galleryCandidates: imported.galleries.length,
      galleries: plan.summary.records.galleries,
      selected: plan.summary.candidates.selected
    },
    plan
  };
}

test("dry-run promotion reauthenticates staging and keeps stdout aggregate-only", async () => {
  await withDirectory(async (directory) => {
    const options = editorialImportOptions(directory);
    const stagingDir = path.join(
      process.cwd(),
      "migration-output",
      `.editorial-promotion-${randomBytes(8).toString("hex")}`
    );
    try {
      const imported = await runEditorialImport({
        ...options,
        dryRun: false,
        write: true,
        stagingDir
      });
      const { expected } = expectedPlan(imported);
      const result = await promoteEditorialStaging({
        ...options,
        stagingDir,
        expected
      });
      assert.equal(result.mode, "dry-run");
      assert.equal(result.schemaVersion, 2);
      assert.equal(result.candidates.authenticatedPages, imported.outcomes.length);
      const stdout = serializeEditorialPromotionResult(result);
      for (const forbidden of [
        "English page",
        "Source wording",
        "photo.jpg",
        "Test English Locale",
        directory,
        stagingDir
      ]) {
        assert.equal(stdout.includes(forbidden), false);
      }
      assert.equal(stdout.includes("candidateIdentifiersAreKeyedHmac"), true);

      await assert.rejects(
        runEditorialPromotionCli([
          "--database",
          options.database,
          "--uploads-dir",
          options.uploadsDir,
          "--fingerprint-key-file",
          options.fingerprintKeyFile,
          "--staging-dir",
          stagingDir,
          "--expected-ready",
          String(expected.ready),
          "--expected-review",
          String(expected.review),
          "--expected-publication-excluded",
          String(expected.publicationExcluded),
          "--expected-gallery-candidates",
          String(expected.galleryCandidates),
          "--expected-galleries",
          String(expected.galleries),
          "--expected-selected",
          String(expected.selected),
          "--output",
          "published.json"
        ]),
        assertCode("rejected-option-output")
      );
      await assert.rejects(
        runEditorialPromotionCli(["--write", "--dry-run"]),
        assertCode("conflicting-mode")
      );
      await assert.rejects(
        runEditorialPromotionCli([]),
        assertCode("missing-mode")
      );
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  });
});

test("promotion fails closed on source and candidate HMAC mismatches", async () => {
  await withDirectory(async (directory) => {
    const options = editorialImportOptions(directory);
    const stagingDir = path.join(
      process.cwd(),
      "migration-output",
      `.editorial-promotion-mismatch-${randomBytes(8).toString("hex")}`
    );
    try {
      const imported = await runEditorialImport({
        ...options,
        dryRun: false,
        write: true,
        stagingDir
      });
      const { expected } = expectedPlan(imported);
      const changedDatabase = path.join(directory, "changed.sql");
      writeFileSync(changedDatabase, `${readFileSync(fixture, "utf8")}\n`);
      await assert.rejects(
        promoteEditorialStaging({
          ...options,
          database: changedDatabase,
          stagingDir,
          expected
        }),
        assertCode("staging-source-or-contract-mismatch")
      );

      const candidatePath = path.join(stagingDir, "candidates", "page-1.json");
      const candidateValue = JSON.parse(readFileSync(candidatePath, "utf8")) as {
        source: { title: string | null };
      };
      candidateValue.source.title = "Altered sanitized title";
      writeFileSync(candidatePath, JSON.stringify(candidateValue), { mode: 0o600 });
      await assert.rejects(
        promoteEditorialStaging({
          ...options,
          stagingDir,
          expected
        }),
        (error: unknown) =>
          error instanceof EditorialPromotionRunnerError
          && error.code === "staged-candidate-hmac-mismatch"
      );
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  });
});

function approvedPublicationSql() {
  const approvedPage = [
    '<p>Source wording</p><img class="wp-image-10" src="/wp-content/uploads/2026/01/photo.jpg">',
    postTile()
      .replace('category="sweet"', 'category="missing"')
      .replace('posts_per_page="auto"', 'posts_per_page="1"'),
    '<!-- wp:tw/bwg {"popupOpened":false,"notInitial":false} /-->'
  ].join("");
  return readFileSync(fixture, "utf8").replace(
    '<p>Source wording</p><img class="wp-image-10" src="/wp-content/uploads/2026/01/photo.jpg">[wp-tiles]<!-- wp:vendor/unknown -->',
    approvedPage
  ).replace('[contact-form-7 id="8"]', '[contact-form-7 id="8" title="Contact"]');
}

type PublicationFixture = {
  readonly database: string;
  readonly expected: ReturnType<typeof expectedPlan>["expected"];
  readonly repositoryRoot: string;
  readonly stagingDir: string;
  readonly promotionOptions: {
    readonly database: string;
    readonly fingerprintKeyFile: string;
    readonly repositoryRoot: string;
    readonly stagingDir: string;
    readonly uploadsDir: string;
    readonly expected: ReturnType<typeof expectedPlan>["expected"];
  };
};

async function withPublicationFixture(
  callback: (fixtureValues: PublicationFixture) => Promise<void>
) {
  const outputRoot = path.join(process.cwd(), "migration-output");
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(outputRoot, ".editorial-publication-test-"));
  try {
    const repositoryRoot = path.join(directory, "repository");
    const database = path.join(directory, "publication.sql");
    const uploadsDir = path.join(directory, "uploads");
    const fingerprintKeyFile = path.join(directory, "fingerprint.key");
    const stagingDir = path.join(repositoryRoot, "migration-output", "editorial-stage");
    mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(repositoryRoot, "content"), { recursive: true });
    cpSync(
      path.join(process.cwd(), "content", "recipes"),
      path.join(repositoryRoot, "content", "recipes"),
      { recursive: true }
    );
    mkdirSync(path.join(repositoryRoot, "migration-output"), { recursive: true, mode: 0o700 });
    writeFileSync(database, approvedPublicationSql(), { mode: 0o600 });
    writeFileSync(
      path.join(uploadsDir, "approved.zip"),
      zipArchive([
        "uploads/2026/01/photo.jpg",
        "uploads/photo-gallery/album/original.jpg",
        "uploads/photo-gallery/album/thumb.jpg"
      ]),
      { mode: 0o600 }
    );
    writeFileSync(fingerprintKeyFile, randomBytes(32), { mode: 0o600 });
    chmodSync(fingerprintKeyFile, 0o600);
    const imported = await runEditorialImport({
      database,
      uploadsDir,
      fingerprintKeyFile,
      stagingDir,
      write: true
    });
    const expected = expectedPlan(imported).expected;
    await callback({
      database,
      expected,
      repositoryRoot,
      stagingDir,
      promotionOptions: {
        database,
        fingerprintKeyFile,
        repositoryRoot,
        stagingDir,
        uploadsDir,
        expected
      }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function editorialMediaUploadOptions(
  fixtureValues: PublicationFixture,
  options: {
    readonly dryRun?: boolean;
    readonly resume?: boolean;
  } = {}
) {
  return {
    ...fixtureValues.promotionOptions,
    uploadDir: "migration-output/editorial-media-upload",
    write: options.dryRun === true ? false : true,
    dryRun: options.dryRun === true,
    ...(options.resume === true ? { resume: true } : {})
  } as const;
}

async function publishEditorialFixture(fixtureValues: PublicationFixture) {
  await promoteEditorialStaging({
    ...fixtureValues.promotionOptions,
    write: true
  });
}

function privateEditorialUploadPaths(repositoryRoot: string) {
  const root = path.join(repositoryRoot, "migration-output", "editorial-media-upload");
  return {
    root,
    objects: path.join(root, "objects"),
    manifest: path.join(root, "upload-manifest.json")
  };
}

function publicEditorialMediaKeys(repositoryRoot: string) {
  const manifest = JSON.parse(readFileSync(
    path.join(repositoryRoot, "content", "editorial-gallery-media-manifest.json"),
    "utf8"
  )) as {
    readonly entries: readonly { readonly key: string }[];
  };
  return manifest.entries.map((entry) => entry.key);
}

function publicationSnapshot(repositoryRoot: string) {
  const files: string[] = [];
  const visit = (directory: string) => {
    if (!existsSync(directory)) {
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
      } else {
        assert.equal(entry.isFile(), true);
        files.push(target);
      }
    }
  };
  visit(path.join(repositoryRoot, "content", "editorial"));
  visit(path.join(repositoryRoot, "content", "galleries"));
  const manifest = path.join(repositoryRoot, "content", "editorial-gallery-media-manifest.json");
  if (existsSync(manifest)) {
    files.push(manifest);
  }
  return files.sort().map((file) => [
    path.relative(repositoryRoot, file),
    createHash("sha256").update(readFileSync(file)).digest("hex")
  ] as const);
}

function assertNoEditorialTransactionArtifacts(repositoryRoot: string) {
  assert.deepEqual(
    readdirSync(path.join(repositoryRoot, "migration-output"))
      .filter((entry) => entry.startsWith(".editorial-promotion-")),
    []
  );
}

function isInjectedPromotionInterruption(error: unknown) {
  return error instanceof EditorialPromotionRunnerError
    && error.code === "injected-promotion-interruption";
}

test("editorial media upload planning is private, deterministic, and resumable", async () => {
  await withPublicationFixture(async (fixtureValues) => {
    await publishEditorialFixture(fixtureValues);
    const paths = privateEditorialUploadPaths(fixtureValues.repositoryRoot);
    const dryRun = await createEditorialMediaUploadPlan(
      editorialMediaUploadOptions(fixtureValues, { dryRun: true })
    );
    assert.deepEqual(dryRun.objects, {
      count: 3,
      bytes: sanitizedImageBytes("uploads/2026/01/photo.jpg").byteLength
        + sanitizedImageBytes("uploads/photo-gallery/album/original.jpg").byteLength
        + sanitizedImageBytes("uploads/photo-gallery/album/thumb.jpg").byteLength,
      created: 0,
      reused: 0
    });
    assert.equal(existsSync(paths.root), false);
    const stdout = serializeEditorialMediaUploadPlanResult(dryRun);
    for (const forbidden of [
      "English page",
      "photo.jpg",
      fixtureValues.database,
      fixtureValues.stagingDir
    ]) {
      assert.equal(stdout.includes(forbidden), false);
    }

    const first = await createEditorialMediaUploadPlan(editorialMediaUploadOptions(fixtureValues));
    assert.equal(first.mode, "write");
    assert.equal(first.objects.created, first.objects.count);
    assert.equal(statSync(paths.root).mode & 0o777, 0o700);
    assert.equal(statSync(paths.objects).mode & 0o777, 0o700);
    assert.equal(statSync(paths.manifest).mode & 0o777, 0o600);
    for (const key of publicEditorialMediaKeys(fixtureValues.repositoryRoot)) {
      const target = path.join(paths.objects, key);
      assert.equal(statSync(target).mode & 0o777, 0o600);
    }

    const resumed = await createEditorialMediaUploadPlan(
      editorialMediaUploadOptions(fixtureValues, { resume: true })
    );
    assert.equal(resumed.objects.created, 0);
    assert.equal(resumed.objects.reused, resumed.objects.count);
  });
});

test("editorial media upload planning rejects tampered manifests and staged objects", async () => {
  await withPublicationFixture(async (fixtureValues) => {
    await publishEditorialFixture(fixtureValues);
    const paths = privateEditorialUploadPaths(fixtureValues.repositoryRoot);
    await createEditorialMediaUploadPlan(editorialMediaUploadOptions(fixtureValues));
    const originalManifest = readFileSync(paths.manifest);
    writeFileSync(paths.manifest, "{\"tampered\":true}\n", { mode: 0o600 });
    await assert.rejects(
      createEditorialMediaUploadPlan(editorialMediaUploadOptions(fixtureValues, { resume: true })),
      (error: unknown) =>
        error instanceof EditorialMediaUploadPlanError
        && error.code === "upload-staging-conflict"
    );
    writeFileSync(paths.manifest, originalManifest, { mode: 0o600 });
    const target = path.join(
      paths.objects,
      publicEditorialMediaKeys(fixtureValues.repositoryRoot)[0]!
    );
    writeFileSync(target, "tampered", { mode: 0o600 });
    await assert.rejects(
      createEditorialMediaUploadPlan(editorialMediaUploadOptions(fixtureValues, { resume: true })),
      (error: unknown) =>
        error instanceof EditorialMediaUploadPlanError
        && error.code === "upload-staging-conflict"
    );
  });
});

test("editorial media upload planning rejects stale staging and changed archives", async () => {
  await withPublicationFixture(async (fixtureValues) => {
    await publishEditorialFixture(fixtureValues);
    writeFileSync(
      fixtureValues.database,
      `${readFileSync(fixtureValues.database, "utf8")}\n`,
      { mode: 0o600 }
    );
    await assert.rejects(
      createEditorialMediaUploadPlan(editorialMediaUploadOptions(fixtureValues, { dryRun: true })),
      (error: unknown) =>
        error instanceof EditorialMediaUploadPlanError
        && error.code === "staging-source-or-contract-mismatch"
    );
  });

  await withPublicationFixture(async (fixtureValues) => {
    await publishEditorialFixture(fixtureValues);
    writeFileSync(
      path.join(fixtureValues.promotionOptions.uploadsDir, "approved.zip"),
      "tampered archive",
      { mode: 0o600 }
    );
    await assert.rejects(
      createEditorialMediaUploadPlan(editorialMediaUploadOptions(fixtureValues, { dryRun: true })),
      (error: unknown) =>
        error instanceof EditorialMediaUploadPlanError
        && error.code === "source-verification-failed"
    );
  });
});

test("editorial media upload planning rejects symlinked object paths", async () => {
  await withPublicationFixture(async (fixtureValues) => {
    await publishEditorialFixture(fixtureValues);
    const paths = privateEditorialUploadPaths(fixtureValues.repositoryRoot);
    const destination = path.join(
      paths.objects,
      publicEditorialMediaKeys(fixtureValues.repositoryRoot)[0]!
    );
    let current = path.join(fixtureValues.repositoryRoot, "migration-output");
    for (const part of path.relative(current, path.dirname(destination)).split(path.sep)) {
      current = path.join(current, part);
      mkdirSync(current, { recursive: false, mode: 0o700 });
      chmodSync(current, 0o700);
    }
    const target = path.join(fixtureValues.repositoryRoot, "outside-media");
    writeFileSync(target, "outside", { mode: 0o600 });
    symlinkSync(target, destination);
    await assert.rejects(
      createEditorialMediaUploadPlan(editorialMediaUploadOptions(fixtureValues)),
      (error: unknown) =>
        error instanceof EditorialMediaUploadPlanError
        && error.code === "unsafe-upload-staging"
    );
  });
});

test("editorial media upload planning requires exact recursive object closure in every mode", async () => {
  await withPublicationFixture(async (fixtureValues) => {
    await publishEditorialFixture(fixtureValues);
    await createEditorialMediaUploadPlan(editorialMediaUploadOptions(fixtureValues));
    const paths = privateEditorialUploadPaths(fixtureValues.repositoryRoot);

    const extraFile = path.join(paths.objects, "unexpected.jpg");
    writeFileSync(extraFile, "unexpected", { mode: 0o600 });
    await assert.rejects(
      createEditorialMediaUploadPlan(editorialMediaUploadOptions(fixtureValues, { dryRun: true })),
      (error: unknown) =>
        error instanceof EditorialMediaUploadPlanError
        && error.code === "upload-staging-conflict"
    );
    rmSync(extraFile);

    const extraDirectory = path.join(paths.objects, "unexpected");
    mkdirSync(extraDirectory, { mode: 0o700 });
    await assert.rejects(
      createEditorialMediaUploadPlan(editorialMediaUploadOptions(fixtureValues, { resume: true })),
      (error: unknown) =>
        error instanceof EditorialMediaUploadPlanError
        && error.code === "upload-staging-conflict"
    );
    rmSync(extraDirectory, { recursive: true });

    const target = path.join(fixtureValues.repositoryRoot, "unexpected-media");
    writeFileSync(target, "unexpected", { mode: 0o600 });
    symlinkSync(target, path.join(paths.objects, "unexpected-link"));
    await assert.rejects(
      createEditorialMediaUploadPlan(editorialMediaUploadOptions(fixtureValues)),
      (error: unknown) =>
        error instanceof EditorialMediaUploadPlanError
        && error.code === "unsafe-upload-staging"
    );
  });
});

test("editorial media upload CLI rejects credentials and destinations", async () => {
  await assert.rejects(
    runEditorialMediaUploadPlanCli(["--account-name", "not-allowed"]),
    (error: unknown) =>
      error instanceof EditorialMediaUploadPlanError
      && error.code === "rejected-option-account-name"
  );
  await assert.rejects(
    runEditorialMediaUploadPlanCli(["--destination", "not-allowed"]),
    (error: unknown) =>
      error instanceof EditorialMediaUploadPlanError
      && error.code === "rejected-option-destination"
  );
});

test("editorial publication transactions reserve contact-success and generated search paths", async () => {
  await withPublicationFixture(async (fixtureValues) => {
    const imported = await runEditorialImport({
      database: fixtureValues.database,
      fingerprintKeyFile: fixtureValues.promotionOptions.fingerprintKeyFile,
      uploadsDir: fixtureValues.promotionOptions.uploadsDir,
      dryRun: true
    });
    const basePlan = expectedPlan(imported).plan;
    const source = basePlan.records[0];
    assert.ok(source);
    const roots = await resolveEditorialPublicationRoots(fixtureValues.repositoryRoot);

    for (const [canonicalPath, slug] of [
      ["/contact/success/", "success"],
      ["/_search/en.json/", "en.json"]
    ] as const) {
      const colliding = editorialPageRecordSchema.parse({
        ...source,
        canonicalPath,
        source: {
          ...source.source,
          sourcePath: canonicalPath,
          sourceSlug: slug
        },
        redirectFrom: []
      });
      await assert.rejects(
        publishEditorialPromotion(roots, {
          repositoryRoot: fixtureValues.repositoryRoot,
          stagingRoot: fixtureValues.stagingDir,
          fingerprintKey: readFileSync(fixtureValues.promotionOptions.fingerprintKeyFile),
          sourceManifest: imported.manifest,
          plan: {
            ...basePlan,
            records: [
              colliding,
              ...basePlan.records.slice(1)
            ]
          },
          recipeRecords: loadRecipeCatalog(
            path.join(fixtureValues.repositoryRoot, "content", "recipes")
          ),
          uploadsDir: fixtureValues.promotionOptions.uploadsDir,
          write: false
        }),
        assertCode("invalid-prospective-public-content")
      );
    }
  });
});

test("transactionally publishes authenticated editorial records, gallery, and media manifest", async () => {
  await withPublicationFixture(async (fixtureValues) => {
    const firstDryRun = await promoteEditorialStaging(fixtureValues.promotionOptions);
    const secondDryRun = await promoteEditorialStaging(fixtureValues.promotionOptions);
    assert.deepEqual(secondDryRun, firstDryRun);
    assert.equal(firstDryRun.mode, "dry-run");
    assert.equal(firstDryRun.records.created, firstDryRun.publication.selected);
    assert.equal(firstDryRun.records.galleriesCreated, 1);
    assert.equal(firstDryRun.media.addedToManifest, firstDryRun.media.bindings);

    const published = await promoteEditorialStaging({
      ...fixtureValues.promotionOptions,
      write: true
    });
    assert.equal(published.mode, "write");
    assert.equal(published.records.created, published.publication.selected);
    assert.equal(published.records.galleriesCreated, 1);
    const editorial = loadEditorialCatalog(path.join(
      fixtureValues.repositoryRoot,
      "content",
      "editorial"
    ));
    const galleries = loadGalleryCatalog(path.join(
      fixtureValues.repositoryRoot,
      "content",
      "galleries"
    ));
    assert.equal(editorial.length, published.publication.selected);
    assert.equal(galleries.length, 1);
    const manifest = JSON.parse(readFileSync(
      path.join(fixtureValues.repositoryRoot, "content", "editorial-gallery-media-manifest.json"),
      "utf8"
    )) as { readonly entries: readonly { readonly key: string }[] };
    assert.equal(manifest.entries.length, published.media.bindings);
    assert.equal(
      existsSync(path.join(fixtureValues.repositoryRoot, "public", "editorial", "media")),
      false
    );
    assert.equal(
      existsSync(path.join(fixtureValues.repositoryRoot, "public", "gallery", "media")),
      false
    );

    const resumed = await promoteEditorialStaging({
      ...fixtureValues.promotionOptions,
      write: true
    });
    assert.equal(resumed.records.created, 0);
    assert.equal(resumed.records.reused, resumed.publication.selected);
    assert.equal(resumed.records.galleriesCreated, 0);
    assert.equal(resumed.records.galleriesReused, 1);
    assert.equal(resumed.media.addedToManifest, 0);
    assert.equal(resumed.media.reusedFromManifest, resumed.media.bindings);
    assertNoEditorialTransactionArtifacts(fixtureValues.repositoryRoot);
  });
});

test("a source-backed posts archive disposition removes a previously promoted editorial page", async () => {
  await withPublicationFixture(async (fixtureValues) => {
    await publishEditorialFixture(fixtureValues);
    writeFileSync(
      fixtureValues.database,
      `${readFileSync(fixtureValues.database, "utf8")}
INSERT INTO \`wp_options\` (\`option_id\`, \`option_name\`, \`option_value\`) VALUES
  (99, 'page_for_posts', '1');
`,
      { mode: 0o600 }
    );
    const stagingDir = path.join(
      fixtureValues.repositoryRoot,
      "migration-output",
      "posts-archive-stage"
    );
    const imported = await runEditorialImport({
      database: fixtureValues.database,
      fingerprintKeyFile: fixtureValues.promotionOptions.fingerprintKeyFile,
      stagingDir,
      uploadsDir: fixtureValues.promotionOptions.uploadsDir,
      write: true
    });
    const expected = expectedPlan(imported);
    assert.deepEqual(expected.plan.publicationExcludedRecordIds, ["wordpress:page:1"]);
    const planned = await promoteEditorialStaging({
      ...fixtureValues.promotionOptions,
      stagingDir,
      expected: expected.expected
    });
    assert.equal(planned.records.removed, 1);
    assert.equal(planned.media.removedFromManifest, 1);
    const beforeRemoval = publicationSnapshot(fixtureValues.repositoryRoot);
    await assert.rejects(
      promoteEditorialStaging({
        ...fixtureValues.promotionOptions,
        stagingDir,
        expected: expected.expected,
        failureInjection: "after-first-publication",
        write: true
      }),
      assertCode("injected-promotion-failure")
    );
    assert.deepEqual(publicationSnapshot(fixtureValues.repositoryRoot), beforeRemoval);
    assertNoEditorialTransactionArtifacts(fixtureValues.repositoryRoot);

    await assert.rejects(
      promoteEditorialStaging({
        ...fixtureValues.promotionOptions,
        stagingDir,
        expected: expected.expected,
        failureInjection: "after-cleanup-backup-unlink",
        write: true
      }),
      isInjectedPromotionInterruption
    );
    const result = await promoteEditorialStaging({
      ...fixtureValues.promotionOptions,
      stagingDir,
      expected: expected.expected,
      write: true
    });
    const editorial = loadEditorialCatalog(path.join(
      fixtureValues.repositoryRoot,
      "content",
      "editorial"
    ));
    const manifest = JSON.parse(readFileSync(
      path.join(fixtureValues.repositoryRoot, "content", "editorial-gallery-media-manifest.json"),
      "utf8"
    )) as { readonly entries: readonly { readonly key: string }[] };

    assert.equal(result.records.removed, 0);
    assert.equal(result.media.removedFromManifest, 0);
    assert.equal(editorial.some((record) => record.id === "wordpress:page:1"), false);
    assert.equal(
      manifest.entries.some((entry) => entry.key === "/editorial/media/wordpress/10.jpg"),
      false
    );
    assertNoEditorialTransactionArtifacts(fixtureValues.repositoryRoot);
  });
});

test("posts archive removal rejects a noncanonical catalog filename before journaling", async () => {
  await withPublicationFixture(async (fixtureValues) => {
    await publishEditorialFixture(fixtureValues);
    const editorialRoot = path.join(
      fixtureValues.repositoryRoot,
      "content",
      "editorial",
      "en"
    );
    renameSync(path.join(editorialRoot, "1.json"), path.join(editorialRoot, "about.json"));
    writeFileSync(
      fixtureValues.database,
      `${readFileSync(fixtureValues.database, "utf8")}
INSERT INTO \`wp_options\` (\`option_id\`, \`option_name\`, \`option_value\`) VALUES
  (99, 'page_for_posts', '1');
`,
      { mode: 0o600 }
    );
    const stagingDir = path.join(
      fixtureValues.repositoryRoot,
      "migration-output",
      "noncanonical-removal-stage"
    );
    const imported = await runEditorialImport({
      database: fixtureValues.database,
      fingerprintKeyFile: fixtureValues.promotionOptions.fingerprintKeyFile,
      stagingDir,
      uploadsDir: fixtureValues.promotionOptions.uploadsDir,
      write: true
    });
    const expected = expectedPlan(imported);

    await assert.rejects(
      promoteEditorialStaging({
        ...fixtureValues.promotionOptions,
        stagingDir,
        expected: expected.expected,
        write: true
      }),
      assertCode("editorial-content-collision")
    );
    assertNoEditorialTransactionArtifacts(fixtureValues.repositoryRoot);
  });
});

test("publication rolls back a failed write and recovers an interrupted write idempotently", async () => {
  await withPublicationFixture(async (fixtureValues) => {
    const before = publicationSnapshot(fixtureValues.repositoryRoot);
    await assert.rejects(
      promoteEditorialStaging({
        ...fixtureValues.promotionOptions,
        write: true,
        failureInjection: "after-first-publication"
      }),
      (error: unknown) =>
        error instanceof EditorialPromotionRunnerError
        && error.code === "injected-promotion-failure"
    );
    assert.deepEqual(publicationSnapshot(fixtureValues.repositoryRoot), before);
    assertNoEditorialTransactionArtifacts(fixtureValues.repositoryRoot);

    await assert.rejects(
      promoteEditorialStaging({
        ...fixtureValues.promotionOptions,
        write: true,
        failureInjection: "after-staged-artifact-write"
      }),
      isInjectedPromotionInterruption
    );
    await promoteEditorialStaging(fixtureValues.promotionOptions);
    assert.deepEqual(publicationSnapshot(fixtureValues.repositoryRoot), before);
    assertNoEditorialTransactionArtifacts(fixtureValues.repositoryRoot);

    await assert.rejects(
      promoteEditorialStaging({
        ...fixtureValues.promotionOptions,
        write: true,
        failureInjection: "after-some-new-files-publish"
      }),
      isInjectedPromotionInterruption
    );
    assert.notDeepEqual(publicationSnapshot(fixtureValues.repositoryRoot), before);
    const recovered = await promoteEditorialStaging(fixtureValues.promotionOptions);
    assert.equal(recovered.mode, "dry-run");
    assert.deepEqual(publicationSnapshot(fixtureValues.repositoryRoot), before);
    assertNoEditorialTransactionArtifacts(fixtureValues.repositoryRoot);
    await promoteEditorialStaging(fixtureValues.promotionOptions);
    assert.deepEqual(publicationSnapshot(fixtureValues.repositoryRoot), before);
  });
});

test("a conflicting create after journaling does not strand editorial recovery", async () => {
  await withPublicationFixture(async (fixtureValues) => {
    await assert.rejects(
      promoteEditorialStaging({
        ...fixtureValues.promotionOptions,
        write: true,
        failureInjection: "before-create-link"
      }),
      isInjectedPromotionInterruption
    );
    const conflict = path.join(
      fixtureValues.repositoryRoot,
      "content",
      "editorial",
      "en",
      "1.json"
    );
    writeFileSync(conflict, "{}\n");

    await assert.rejects(
      promoteEditorialStaging({
        ...fixtureValues.promotionOptions,
        failureInjection: "after-rollback-preserved-create-journal"
      }),
      isInjectedPromotionInterruption
    );
    assert.equal(readFileSync(conflict, "utf8"), "{}\n");

    await assert.rejects(
      promoteEditorialStaging(fixtureValues.promotionOptions),
      (error: unknown) => {
        assert.ok(error instanceof EditorialPromotionRunnerError);
        assert.equal(error.code, "editorial-content-collision");
        return true;
      }
    );
    assert.equal(readFileSync(conflict, "utf8"), "{}\n");
    assertNoEditorialTransactionArtifacts(fixtureValues.repositoryRoot);

    unlinkSync(conflict);
    const recovered = await promoteEditorialStaging(fixtureValues.promotionOptions);
    assert.equal(recovered.mode, "dry-run");
    assertNoEditorialTransactionArtifacts(fixtureValues.repositoryRoot);
  });
});

test("committed cleanup resumes after the journal unlink boundary", async () => {
  await withPublicationFixture(async (fixtureValues) => {
    await assert.rejects(
      promoteEditorialStaging({
        ...fixtureValues.promotionOptions,
        write: true,
        failureInjection: "after-cleanup-journal-unlink"
      }),
      isInjectedPromotionInterruption
    );
    const committed = publicationSnapshot(fixtureValues.repositoryRoot);
    const recovered = await promoteEditorialStaging(fixtureValues.promotionOptions);
    assert.equal(recovered.mode, "dry-run");
    assert.deepEqual(publicationSnapshot(fixtureValues.repositoryRoot), committed);
    assertNoEditorialTransactionArtifacts(fixtureValues.repositoryRoot);
  });
});

test("publication rejects record and media-manifest collisions without overwriting", async () => {
  await withPublicationFixture(async (fixtureValues) => {
    await promoteEditorialStaging({
      ...fixtureValues.promotionOptions,
      write: true
    });
    const record = loadEditorialCatalog(path.join(
      fixtureValues.repositoryRoot,
      "content",
      "editorial"
    ))[0];
    assert.ok(record);
    const recordPath = path.join(
      fixtureValues.repositoryRoot,
      "content",
      "editorial",
      record.locale,
      `${record.source.postId}.json`
    );
    const original = readFileSync(recordPath);
    const changed = JSON.parse(original.toString("utf8")) as { title: string | null };
    changed.title = "Collision";
    writeFileSync(recordPath, `${JSON.stringify(changed)}\n`, { mode: 0o644 });
    await assert.rejects(
      promoteEditorialStaging({
        ...fixtureValues.promotionOptions,
        write: true
      }),
      (error: unknown) =>
        error instanceof EditorialPromotionRunnerError
        && error.code === "editorial-content-collision"
    );
    assert.deepEqual(readFileSync(recordPath), Buffer.from(`${JSON.stringify(changed)}\n`));
    writeFileSync(recordPath, original, { mode: 0o644 });

    const manifestPath = path.join(
      fixtureValues.repositoryRoot,
      "content",
      "editorial-gallery-media-manifest.json"
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      entries: Array<{ sha256: string }>;
    };
    assert.ok(manifest.entries[0]);
    manifest.entries[0]!.sha256 = "0".repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o644 });
    await assert.rejects(
      promoteEditorialStaging({
        ...fixtureValues.promotionOptions,
        write: true
      }),
      (error: unknown) =>
        error instanceof EditorialPromotionRunnerError
        && error.code === "editorial-media-manifest-collision"
    );
  });
});

test("publication lock excludes contenders and tampered recovery journals fail closed", async () => {
  await withPublicationFixture(async (fixtureValues) => {
    let releaseLock: (() => void) | undefined;
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockAcquired: (() => void) | undefined;
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const first = promoteEditorialStaging({
      ...fixtureValues.promotionOptions,
      onPromotionLockAcquired: async () => {
        lockAcquired?.();
        await lockReleased;
      }
    });
    await acquired;
    await assert.rejects(
      promoteEditorialStaging(fixtureValues.promotionOptions),
      (error: unknown) => {
        assert.ok(error instanceof EditorialPromotionRunnerError);
        assert.equal(error.code, "promotion-locked");
        return true;
      }
    );
    releaseLock?.();
    await first;

    await assert.rejects(
      promoteEditorialStaging({
        ...fixtureValues.promotionOptions,
        write: true,
        failureInjection: "after-some-new-files-publish"
      }),
      isInjectedPromotionInterruption
    );
    const beforeRecovery = publicationSnapshot(fixtureValues.repositoryRoot);
    const transaction = readdirSync(
      path.join(fixtureValues.repositoryRoot, "migration-output"),
      { withFileTypes: true }
    ).find((entry) =>
      entry.name.startsWith(".editorial-promotion-") && entry.isDirectory()
    );
    assert.ok(transaction);
    const journal = path.join(
      fixtureValues.repositoryRoot,
      "migration-output",
      transaction.name,
      "journal.json"
    );
    const tampered = JSON.parse(readFileSync(journal, "utf8")) as {
      operations: Array<{ destination: string }>;
    };
    assert.ok(tampered.operations[0]);
    tampered.operations[0]!.destination = path.join(
      fixtureValues.repositoryRoot,
      "outside-publication.json"
    );
    writeFileSync(journal, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
    await assert.rejects(
      promoteEditorialStaging(fixtureValues.promotionOptions),
      (error: unknown) =>
        error instanceof EditorialPromotionRunnerError
        && error.code === "invalid-promotion-journal"
    );
    assert.deepEqual(publicationSnapshot(fixtureValues.repositoryRoot), beforeRecovery);
  });
});

test("a symlinked interrupted publication journal fails closed", async () => {
  await withPublicationFixture(async (fixtureValues) => {
    await assert.rejects(
      promoteEditorialStaging({
        ...fixtureValues.promotionOptions,
        write: true,
        failureInjection: "after-some-new-files-publish"
      }),
      isInjectedPromotionInterruption
    );
    const beforeRecovery = publicationSnapshot(fixtureValues.repositoryRoot);
    const transaction = readdirSync(
      path.join(fixtureValues.repositoryRoot, "migration-output"),
      { withFileTypes: true }
    ).find((entry) =>
      entry.name.startsWith(".editorial-promotion-") && entry.isDirectory()
    );
    assert.ok(transaction);
    const journal = path.join(
      fixtureValues.repositoryRoot,
      "migration-output",
      transaction.name,
      "journal.json"
    );
    const target = path.join(fixtureValues.repositoryRoot, "journal-target");
    writeFileSync(target, readFileSync(journal), { mode: 0o600 });
    unlinkSync(journal);
    symlinkSync(target, journal);
    await assert.rejects(
      promoteEditorialStaging(fixtureValues.promotionOptions),
      (error: unknown) =>
        error instanceof EditorialPromotionRunnerError
        && error.code === "invalid-promotion-journal"
    );
    assert.deepEqual(publicationSnapshot(fixtureValues.repositoryRoot), beforeRecovery);
  });
});
