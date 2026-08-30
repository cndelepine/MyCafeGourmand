import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadRecipeCatalog } from "../src/content/catalog";
import {
  discoverEditorialFiles,
  loadEditorialCatalog,
  validateEditorialCatalog
} from "../src/content/editorial-catalog";
import {
  emptyCardGridSchema,
  editorialPageRecordSchema,
  publicContentLimits,
  publicMediaObjectSchema,
  richTextBlockSchema
} from "../src/content/editorial-schema";
import {
  discoverGalleryFiles,
  loadGalleryCatalog,
  validateGalleryCatalog,
  validatePublicContentCatalogs
} from "../src/content/gallery-catalog";
import { galleryRecordSchema } from "../src/content/gallery-schema";

function withTempDirectory<T>(callback: (directory: string) => T) {
  const directory = mkdtempSync(path.join(process.cwd(), ".public-content-test-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function editorialSource(
  canonicalPath: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    system: "wordpress",
    postId: 42,
    sourcePath: canonicalPath,
    sourceSlug: "about",
    createdAt: "2024-01-01T00:00:00Z",
    modifiedAt: null,
    ...overrides
  };
}

function editorialMedia(
  id: string,
  attachmentId: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    path: `/editorial/media/wordpress/${attachmentId}.jpg`,
    source: {
      system: "wordpress",
      attachmentId
    },
    mimeType: "image/jpeg",
    width: 1200,
    height: 800,
    ...overrides
  };
}

function galleryMedia(
  id: string,
  imageId: number,
  role: "original" | "thumbnail" = "original",
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    path: `/gallery/media/wordpress-bwg/${imageId}-${role}.jpg`,
    source: {
      system: "wordpress-bwg",
      imageId
    },
    mimeType: "image/jpeg",
    width: null,
    height: null,
    ...overrides
  };
}

function editorialFixture(
  overrides: Record<string, unknown> = {}
) {
  return editorialPageRecordSchema.parse({
    schemaVersion: 1,
    kind: "editorial-page",
    id: "page:about",
    locale: "en",
    canonicalPath: "/about/",
    translationGroupId: null,
    source: editorialSource("/about/"),
    title: "About the site",
    excerpt: null,
    publishedAt: "2024-01-01T00:00:00Z",
    modifiedAt: null,
    content: [{
      type: "paragraph",
      children: [{
        type: "text",
        value: "A short page."
      }]
    }],
    featuredMediaId: null,
    featuredMediaAlt: null,
    media: null,
    redirectFrom: [],
    ...overrides
  });
}

function richEditorialFixture(
  overrides: Record<string, unknown> = {}
) {
  return editorialPageRecordSchema.parse({
    ...editorialFixture({
      id: "page:rich",
      locale: "ru",
      canonicalPath: "/ru/о-сайте/",
      source: editorialSource("/ru/о-сайте/", { sourceSlug: null }),
      content: [
        {
          type: "heading",
          level: 2,
          children: [{ type: "text", value: "Заголовок" }]
        },
        {
          type: "paragraph",
          children: [
            { type: "text", value: "Text " },
            {
              type: "emphasis",
              children: [{ type: "text", value: "emphasis" }]
            },
            {
              type: "strong",
              children: [{ type: "text", value: "strong" }]
            },
            { type: "code", value: "code" },
            { type: "break" },
            {
              type: "link",
              href: "/contact/",
              children: [
                { type: "text", value: "contact " },
                {
                  type: "strong",
                  children: [{ type: "text", value: "here" }]
                }
              ]
            }
          ]
        },
        {
          type: "list",
          ordered: true,
          items: [{
            children: [{ type: "text", value: "one" }]
          }]
        },
        {
          type: "blockquote",
          children: [{
            type: "paragraph",
            children: [{ type: "text", value: "Quoted." }]
          }]
        },
        {
          type: "image",
          mediaId: "media:hero",
          alt: null,
          caption: "Source caption"
        },
        {
          type: "imageGrid",
          images: [
            { mediaId: "media:grid-original", alt: null, caption: null },
            { mediaId: "media:grid-thumbnail", alt: "Reviewed alt", caption: null }
          ]
        }
      ],
      media: [
        editorialMedia("media:hero", 900),
        editorialMedia("media:grid-original", 901, {
          width: null,
          height: null
        }),
        editorialMedia("media:grid-thumbnail", 902)
      ],
      redirectFrom: ["/ru/старый-сайт/"]
    }),
    ...overrides
  });
}

function galleryFixture(
  overrides: Record<string, unknown> = {}
) {
  return galleryRecordSchema.parse({
    schemaVersion: 1,
    kind: "gallery",
    id: "gallery:main",
    locale: null,
    canonicalPath: "/gallery/",
    source: {
      system: "wordpress-bwg",
      galleryId: 300
    },
    title: null,
    description: "A source-backed gallery.",
    featuredMediaId: null,
    media: [
      galleryMedia("media:original", 301),
      galleryMedia("media:thumbnail", 301, "thumbnail")
    ],
    images: [{
      sourceImageId: 301,
      originalMediaId: "media:original",
      thumbnailMediaId: "media:thumbnail",
      caption: null,
      alt: null
    }],
    ...overrides
  });
}

function writeEditorialRecord(
  root: string,
  locale: "en" | "fr" | "ru",
  fileName: string,
  record: unknown
) {
  const localeDirectory = path.join(root, locale);
  mkdirSync(localeDirectory, { recursive: true });
  writeFileSync(
    path.join(localeDirectory, fileName),
    JSON.stringify(record, null, 2),
    "utf8"
  );
}

function writeGalleryRecord(root: string, fileName: string, record: unknown) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, fileName),
    JSON.stringify(record, null, 2),
    "utf8"
  );
}

test("editorial rich text is a bounded strict AST and preserves null usage values", () => {
  const record = richEditorialFixture();
  assert.equal(record.canonicalPath, "/ru/о-сайте/");
  assert.equal(record.title, "About the site");
  assert.equal(record.excerpt, null);
  assert.equal(record.modifiedAt, null);
  assert.equal(record.content?.at(-1)?.type, "imageGrid");
  assert.equal(record.media?.[0]?.source.system, "wordpress");
  assert.equal(
    JSON.stringify(record).includes("<p>"),
    false
  );

  assert.doesNotThrow(() => richTextBlockSchema.parse({
    type: "paragraph",
    children: [{ type: "text", value: "safe text" }]
  }));
  assert.deepEqual(emptyCardGridSchema.parse({
    type: "emptyCardGrid",
    reason: "source-category-missing"
  }), {
    type: "emptyCardGrid",
    reason: "source-category-missing"
  });
  assert.throws(() => emptyCardGridSchema.parse({
    type: "emptyCardGrid",
    reason: "not-modeled"
  }));
  assert.throws(() => emptyCardGridSchema.parse({
    type: "emptyCardGrid",
    reason: "source-category-missing",
    items: []
  }));
  assert.throws(
    () => editorialPageRecordSchema.parse({
      ...editorialFixture(),
      author: "Not modeled"
    }),
    /Unrecognized key/
  );
  assert.throws(
    () => editorialPageRecordSchema.parse({
      ...editorialFixture(),
      content: [{
        type: "paragraph",
        children: [{ type: "text", value: "<p>raw HTML</p>" }]
      }]
    }),
    /raw HTML/
  );
  assert.throws(
    () => editorialPageRecordSchema.parse({
      ...editorialFixture(),
      content: [{
        type: "paragraph",
        children: [{
          type: "link",
          href: "javascript:alert(1)",
          children: [{ type: "text", value: "unsafe" }]
        }]
      }]
    }),
    /unsafe URL scheme/
  );
});

test("public editorial blocks close over promoted recipe, page, and gallery IDs", () => {
  const recipe = loadRecipeCatalog()[0]!;
  const gallery = galleryFixture();
  const record = editorialFixture({
    content: [
      { type: "recipeCardGrid", recipeIds: [recipe.id] },
      { type: "editorialPageCardGrid", pageIds: ["page:about"] },
      { type: "galleryCallout", galleryId: gallery.id },
      { type: "contactForm" }
    ]
  });
  assert.doesNotThrow(() => validatePublicContentCatalogs(
    [record],
    [gallery],
    { recipeRecords: [recipe] }
  ));
  assert.throws(
    () => validatePublicContentCatalogs([
      editorialFixture({
        content: [{ type: "recipeCardGrid", recipeIds: ["wordpress:wprm:missing"] }]
      })
    ], [], { recipeRecords: [recipe] }),
    /does not identify a promoted recipe/
  );
  assert.throws(
    () => editorialPageRecordSchema.parse({
      ...editorialFixture(),
      content: [{
        type: "recipeCardGrid",
        recipeIds: [recipe.id, recipe.id]
      }]
    }),
    /Duplicate recipe card reference/
  );
  assert.throws(
    () => editorialPageRecordSchema.parse({
      ...editorialFixture(),
      content: [{
        type: "contactForm",
        provider: "not-modeled"
      }]
    }),
    /Unrecognized key/
  );
});

test("public media objects enforce managed paths, source identity, and closure", () => {
  assert.doesNotThrow(() => publicMediaObjectSchema.parse(
    editorialMedia("media:valid", 901)
  ));
  assert.throws(
    () => publicMediaObjectSchema.parse({
      ...editorialMedia("media:bad-path", 902),
      path: "/recipes/media/wordpress/902.jpg"
    }),
    /approved editorial or gallery managed prefix/
  );
  assert.throws(
    () => publicMediaObjectSchema.parse({
      ...editorialMedia("media:bad-source", 903),
      source: {
        system: "wordpress",
        attachmentId: "903"
      }
    }),
    /number/
  );
  assert.throws(
    () => publicMediaObjectSchema.parse({
      ...editorialMedia("media:wrong-prefix", 904),
      path: "/gallery/media/wordpress-bwg/904.jpg",
      source: {
        system: "wordpress",
        attachmentId: 904
      }
    }),
    /source system prefix/
  );
  assert.throws(
    () => publicMediaObjectSchema.parse({
      ...editorialMedia("media:loose", 905),
      alt: "must stay on usage"
    }),
    /Unrecognized key/
  );

  assert.doesNotThrow(() => editorialPageRecordSchema.parse({
    ...editorialFixture(),
    featuredMediaId: "media:featured-only",
    media: [editorialMedia("media:featured-only", 906)]
  }));
  assert.throws(
    () => editorialPageRecordSchema.parse({
      ...editorialFixture(),
      content: [{
        type: "image",
        mediaId: "missing",
        alt: null,
        caption: null
      }]
    }),
    /Unknown editorial media reference/
  );
  assert.throws(
    () => editorialPageRecordSchema.parse({
      ...editorialFixture(),
      media: [editorialMedia("media:unused", 907)]
    }),
    /not used by featured or content/
  );
  assert.throws(
    () => editorialPageRecordSchema.parse({
      ...editorialFixture(),
      featuredMediaId: "missing"
    }),
    /Unknown editorial media reference/
  );

  assert.throws(
    () => galleryRecordSchema.parse({
      ...galleryFixture(),
      images: [{
        sourceImageId: "301",
        originalMediaId: "media:original",
        thumbnailMediaId: "media:thumbnail",
        caption: null,
        alt: null
      }]
    }),
    /number/
  );
  assert.throws(
    () => galleryRecordSchema.parse({
      ...galleryFixture(),
      images: [{
        sourceImageId: 301,
        originalMediaId: "media:thumbnail",
        thumbnailMediaId: "media:original",
        caption: null,
        alt: null
      }]
    }),
    /Gallery original media must match its source image and original role/
  );
  assert.throws(
    () => galleryRecordSchema.parse({
      ...galleryFixture(),
      images: [{
        sourceImageId: 302,
        originalMediaId: "media:original",
        thumbnailMediaId: "media:thumbnail",
        caption: null,
        alt: null
      }]
    }),
    /Gallery original media must match its source image and original role/
  );
  assert.doesNotThrow(() => galleryRecordSchema.parse({
    ...galleryFixture(),
    featuredMediaId: "media:featured-only",
    media: [galleryMedia("media:featured-only", 308)],
    images: []
  }));
  assert.throws(
    () => galleryRecordSchema.parse({
      ...galleryFixture(),
      media: [galleryMedia("media:unused", 309)],
      images: []
    }),
    /not used by featured or an image/
  );
});

test("editorial canonical paths are raw, locale-consistent, and source-backed", () => {
  for (const canonicalPath of [
    "/about",
    "/about//team/",
    "/about/%74eam/",
    "//about/",
    "/about//"
  ]) {
    assert.throws(
      () => editorialPageRecordSchema.parse({
        ...editorialFixture(),
        canonicalPath,
        source: editorialSource(canonicalPath)
      }),
      /canonical path|leading separator|empty interior|trailing slash|raw Unicode/
    );
  }
  for (const canonicalPath of ["/en/about/", "/fr/about/", "/ru/about/"]) {
    assert.throws(
      () => editorialPageRecordSchema.parse({
        ...editorialFixture(),
        canonicalPath,
        source: editorialSource(canonicalPath)
      }),
      /must not start with a locale prefix/
    );
  }
  assert.throws(
    () => editorialPageRecordSchema.parse({
      ...editorialFixture(),
      locale: "fr",
      canonicalPath: "/a-propos/",
      source: editorialSource("/a-propos/")
    }),
    /must start with \/fr/
  );
  assert.throws(
    () => editorialPageRecordSchema.parse({
      ...editorialFixture(),
      source: editorialSource("/different/")
    }),
    /sourcePath must match canonicalPath/
  );
  assert.doesNotThrow(() => editorialPageRecordSchema.parse({
    ...editorialFixture({
      locale: "fr",
      canonicalPath: "/fr/à-propos/",
      source: editorialSource("/fr/à-propos/")
    })
  }));
  assert.doesNotThrow(() => editorialPageRecordSchema.parse({
    ...richEditorialFixture(),
    redirectFrom: ["/legacy", "/ancien/%25"]
  }));
});

test("public schemas fail predictably at content bounds and forbidden rich-text recursion", () => {
  assert.throws(
    () => editorialPageRecordSchema.parse({
      ...editorialFixture(),
      title: "x".repeat(publicContentLimits.maxStringLength + 1)
    }),
    /maximum length|too_big/
  );
  assert.throws(
    () => editorialPageRecordSchema.parse({
      ...editorialFixture(),
      content: [{
        type: "paragraph",
        children: [{
          type: "link",
          href: "/contact/",
          children: [{
            type: "link",
            href: "/contact/",
            children: [{ type: "text", value: "nested" }]
          }]
        }]
      }]
    }),
    /Invalid input/
  );
  assert.throws(
    () => editorialPageRecordSchema.parse({
      ...editorialFixture(),
      content: [{
        type: "blockquote",
        children: [{
          type: "blockquote",
          children: [{
            type: "paragraph",
            children: [{ type: "text", value: "nested" }]
          }]
        }]
      }]
    }),
    /Invalid input/
  );
  assert.throws(
    () => editorialPageRecordSchema.parse({
      ...editorialFixture(),
      content: Array.from(
        { length: publicContentLimits.maxBlocks + 1 },
        () => ({
          type: "paragraph",
          children: [{ type: "text", value: "block" }]
        })
      )
    }),
    /maximum|too_big/
  );
  assert.throws(
    () => editorialPageRecordSchema.parse({
      ...editorialFixture(),
      content: [{
        type: "list",
        ordered: false,
        items: Array.from(
          { length: publicContentLimits.maxListItems + 1 },
          () => ({ children: [{ type: "text", value: "item" }] })
        )
      }]
    }),
    /lists must contain|maximum/
  );
  assert.throws(
    () => editorialPageRecordSchema.parse({
      ...editorialFixture(),
      content: [{
        type: "imageGrid",
        images: Array.from(
          { length: publicContentLimits.maxImageGridImages + 1 },
          () => ({ mediaId: "media:missing", alt: null, caption: null })
        )
      }]
    }),
    /image grids must contain|maximum/
  );
  assert.throws(
    () => editorialPageRecordSchema.parse({
      ...editorialFixture(),
      media: Array.from(
        { length: publicContentLimits.maxMedia + 1 },
        (_, index) => editorialMedia(`media:${index}`, 1000 + index)
      )
    }),
    /maximum|too_big/
  );
  assert.throws(
    () => validateEditorialCatalog(
      new Array(publicContentLimits.maxRecords + 1).fill(editorialFixture())
    ),
    /maximum.*records/
  );
});

test("editorial and gallery loading enforce file bounds and deterministic discovery", () => {
  withTempDirectory((root) => {
    writeEditorialRecord(root, "en", "zeta.json", editorialFixture({
      id: "page:zeta",
      canonicalPath: "/zeta/",
      source: editorialSource("/zeta/")
    }));
    writeEditorialRecord(root, "en", "alpha.json", editorialFixture({
      id: "page:alpha",
      canonicalPath: "/alpha/",
      source: editorialSource("/alpha/")
    }));
    writeEditorialRecord(root, "ru", "about.json", richEditorialFixture());

    assert.deepEqual(
      discoverEditorialFiles(root).map((file) => path.relative(root, file.path)),
      ["en/alpha.json", "en/zeta.json", "ru/about.json"]
    );
    assert.deepEqual(
      loadEditorialCatalog(root).map((record) => record.canonicalPath),
      ["/alpha/", "/zeta/", "/ru/о-сайте/"]
    );
    assert.deepEqual(loadEditorialCatalog(path.join(root, "missing")), []);
  });

  withTempDirectory((root) => {
    mkdirSync(path.join(root, "en"), { recursive: true });
    writeFileSync(
      path.join(root, "en", "too-large.json"),
      Buffer.alloc(publicContentLimits.maxFileBytes + 1, 0x20)
    );
    assert.throws(
      () => loadEditorialCatalog(root),
      /maximum size/
    );
  });
});

test("editorial discovery rejects unsupported files, symlinks, malformed JSON, and folder mismatches", () => {
  withTempDirectory((root) => {
    mkdirSync(path.join(root, "de"), { recursive: true });
    assert.throws(
      () => discoverEditorialFiles(root),
      /Unsupported locale folder "de"/
    );
  });

  withTempDirectory((root) => {
    mkdirSync(path.join(root, "en"), { recursive: true });
    writeFileSync(path.join(root, "en", "notes.txt"), "not JSON", "utf8");
    assert.throws(() => discoverEditorialFiles(root), /Unsupported editorial content file/);
  });

  withTempDirectory((root) => {
    mkdirSync(path.join(root, "en"), { recursive: true });
    symlinkSync(path.join(root, "en"), path.join(root, "fr"));
    assert.throws(() => discoverEditorialFiles(root), /Symbolic links are not allowed/);
  });

  withTempDirectory((root) => {
    mkdirSync(path.join(root, "en"), { recursive: true });
    writeFileSync(path.join(root, "en", "broken.json"), "{\"title\":", "utf8");
    assert.throws(() => loadEditorialCatalog(root), /Malformed JSON/);
  });

  withTempDirectory((root) => {
    writeEditorialRecord(root, "en", "french.json", editorialFixture({
      locale: "fr",
      canonicalPath: "/fr/a-propos/",
      source: editorialSource("/fr/a-propos/")
    }));
    assert.throws(() => loadEditorialCatalog(root), /Locale-folder mismatch/);
  });
});

test("editorial and public catalog validation rejects collisions and duplicate identities", () => {
  const first = editorialFixture();

  assert.throws(
    () => validateEditorialCatalog([
      first,
      editorialFixture({ id: "page:about", canonicalPath: "/other/", source: editorialSource("/other/") })
    ]),
    /Duplicate editorial content ID/
  );
  assert.throws(
    () => validateEditorialCatalog([
      first,
      editorialFixture({ id: "page:route", canonicalPath: "/about", source: editorialSource("/about") })
    ]),
    /trailing slash|canonical path/
  );
  assert.throws(
    () => validateEditorialCatalog([
      first,
      editorialFixture({
        id: "page:translation",
        locale: "en",
        canonicalPath: "/translated/",
        source: editorialSource("/translated/"),
        translationGroupId: "group:1"
      }),
      editorialFixture({
        id: "page:translation-2",
        locale: "en",
        canonicalPath: "/translated-2/",
        source: editorialSource("/translated-2/"),
        translationGroupId: "group:1"
      })
    ]),
    /Duplicate editorial translation group locale/
  );
  assert.throws(
    () => validateEditorialCatalog([
      editorialFixture({
        redirectFrom: ["/old/", "/old"]
      })
    ]),
    /Duplicate editorial redirect source/
  );
  assert.throws(
    () => validateEditorialCatalog([
      first,
      editorialFixture({
        id: "page:redirect",
        canonicalPath: "/new/",
        source: editorialSource("/new/"),
        redirectFrom: ["/about/"]
      })
    ]),
    /redirect source collides with a canonical route/
  );
  assert.throws(
    () => validateEditorialCatalog([
      editorialFixture({
        canonicalPath: "/reserved/",
        source: editorialSource("/reserved/")
      })
    ], {
      reservedPaths: ["/reserved/"]
    }),
    /reserved public route/
  );
  assert.throws(
    () => validatePublicContentCatalogs(
      [first],
      [galleryFixture()],
      { reservedPaths: ["/about/"] }
    ),
    /reserved public route/
  );
});

test("gallery discovery enforces one neutral publication and route reservations", () => {
  withTempDirectory((root) => {
    assert.deepEqual(discoverGalleryFiles(root), []);
    assert.deepEqual(loadGalleryCatalog(root), []);

    writeGalleryRecord(root, "main.json", galleryFixture());
    assert.equal(loadGalleryCatalog(root)[0]?.canonicalPath, "/gallery/");

    writeGalleryRecord(root, "second.json", galleryFixture({ id: "gallery:second" }));
    assert.throws(
      () => loadGalleryCatalog(root),
      /at most one language-neutral record/
    );
  });

  assert.throws(
    () => validateGalleryCatalog([galleryFixture()], {
      reservedPaths: ["/gallery/"]
    }),
    /reserved public route/
  );
  assert.throws(
    () => validateGalleryCatalog([galleryFixture()], {
      editorialRecords: [editorialFixture({
        canonicalPath: "/gallery/",
        source: editorialSource("/gallery/")
      })]
    }),
    /collides with the gallery route/
  );
});

test("gallery discovery rejects symlinks and unsupported entries", () => {
  withTempDirectory((root) => {
    mkdirSync(path.join(root, "nested"), { recursive: true });
    assert.throws(
      () => discoverGalleryFiles(root),
      /Unsupported gallery content file or directory/
    );
  });

  withTempDirectory((root) => {
    writeGalleryRecord(root, "main.json", galleryFixture());
    symlinkSync(
      path.join(root, "main.json"),
      path.join(root, "linked.json")
    );
    assert.throws(
      () => discoverGalleryFiles(root),
      /Symbolic links are not allowed/
    );
  });
});
