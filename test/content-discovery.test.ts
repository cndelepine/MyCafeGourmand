import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createRecipeContentTreeGuard,
  discoverRecipeFiles,
  loadRecipeCatalog,
  validateCatalog
} from "../src/content/catalog";
import { recipeFixture } from "./fixtures/recipe";
import {
  recipeContentLimits,
  recipeRecordSchema
} from "../src/content/schema";
import { validateMediaPaths } from "../src/content/validation";

function withTempDirectory<T>(callback: (directory: string) => T) {
  const directory = mkdtempSync(path.join(process.cwd(), ".content-test-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function writeRecord(
  recipesRoot: string,
  locale: "en" | "fr" | "ru",
  fileName: string,
  record: unknown
) {
  const localeDirectory = path.join(recipesRoot, locale);
  mkdirSync(localeDirectory, { recursive: true });
  writeFileSync(
    path.join(localeDirectory, fileName),
    JSON.stringify(record, null, 2),
    "utf8"
  );
}

function writeRawRecord(
  recipesRoot: string,
  locale: "en" | "fr" | "ru",
  fileName: string,
  contents: string | Uint8Array
) {
  const localeDirectory = path.join(recipesRoot, locale);
  mkdirSync(localeDirectory, { recursive: true });
  writeFileSync(path.join(localeDirectory, fileName), contents);
}

function localizedRecord(
  locale: "en" | "fr" | "ru",
  slug: string,
  recipeId: string,
  translationGroupId: string | null = null
) {
  return recipeRecordSchema.parse({
    ...recipeFixture,
    id: `wordpress:wprm:${recipeId}`,
    locale,
    translationGroupId,
    slug,
    source: {
      ...recipeFixture.source,
      postId: recipeId,
      sourceSlug: slug,
      recipeId
    }
  });
}

test("recipe discovery is deterministic and permits absent locale folders", () => {
  withTempDirectory((recipesRoot) => {
    writeRecord(recipesRoot, "en", "zeta.json", localizedRecord("en", "zeta", "3000"));
    writeRecord(recipesRoot, "en", "alpha.json", localizedRecord("en", "alpha", "3001"));

    const files = discoverRecipeFiles(recipesRoot);
    assert.deepEqual(
      files.map((file) => path.relative(recipesRoot, file.path)),
      ["en/alpha.json", "en/zeta.json"]
    );
    assert.deepEqual(loadRecipeCatalog(recipesRoot).map((record) => record.slug), [
      "alpha",
      "zeta"
    ]);
  });
});

test("discovery returns no records when locale folders or records are absent", () => {
  withTempDirectory((recipesRoot) => {
    assert.deepEqual(discoverRecipeFiles(recipesRoot), []);
    mkdirSync(path.join(recipesRoot, "en"));
    mkdirSync(path.join(recipesRoot, "fr"));
    assert.deepEqual(loadRecipeCatalog(recipesRoot), []);
  });
});

test("unsupported locale folders fail instead of being silently omitted", () => {
  withTempDirectory((recipesRoot) => {
    mkdirSync(path.join(recipesRoot, "de"));

    assert.throws(
      () => discoverRecipeFiles(recipesRoot),
      /Unsupported locale folder "de"/
    );
  });
});

test("recipe discovery rejects root files, extension typos, and nested directories", () => {
  withTempDirectory((recipesRoot) => {
    writeFileSync(path.join(recipesRoot, "notes.txt"), "not content", "utf8");
    assert.throws(
      () => discoverRecipeFiles(recipesRoot),
      /Unsupported recipe content file/
    );
  });

  for (const fileName of ["recipe.jsn", "recipe.JSON"]) {
    withTempDirectory((recipesRoot) => {
      writeRawRecord(recipesRoot, "en", fileName, "{}");
      assert.throws(
        () => discoverRecipeFiles(recipesRoot),
        /Unsupported recipe content file/
      );
    });
  }

  withTempDirectory((recipesRoot) => {
    mkdirSync(path.join(recipesRoot, "en", "nested"), { recursive: true });
    assert.throws(
      () => discoverRecipeFiles(recipesRoot),
      /Unsupported recipe content directory/
    );
  });
});

test("recipe discovery rejects symlinked locale paths and records", () => {
  withTempDirectory((recipesRoot) => {
    const target = path.join(recipesRoot, "target");
    mkdirSync(target);
    symlinkSync(target, path.join(recipesRoot, "en"));

    assert.throws(
      () => discoverRecipeFiles(recipesRoot),
      /Symbolic links are not allowed/
    );
  });

  withTempDirectory((recipesRoot) => {
    writeRecord(recipesRoot, "en", "source.json", localizedRecord("en", "source", "3000"));
    symlinkSync(
      path.join(recipesRoot, "en", "source.json"),
      path.join(recipesRoot, "en", "linked.json")
    );

    assert.throws(
      () => discoverRecipeFiles(recipesRoot),
      /Symbolic links are not allowed/
    );
  });
});

test("recipe tree guards detect locale directory replacement after discovery", () => {
  withTempDirectory((recipesRoot) => {
    writeRecord(
      recipesRoot,
      "en",
      "original.json",
      localizedRecord("en", "original", "3099")
    );
    const guard = createRecipeContentTreeGuard(recipesRoot);
    const movedLocale = `${recipesRoot}-original-en`;
    try {
      renameSync(path.join(recipesRoot, "en"), movedLocale);
      writeRecord(
        recipesRoot,
        "en",
        "replacement.json",
        localizedRecord("en", "replacement", "3100")
      );
      assert.throws(
        () => guard.assertUnchanged(),
        /Recipe content tree changed during catalog load/
      );
    } finally {
      rmSync(movedLocale, { force: true, recursive: true });
    }
  });
});

test("malformed JSON errors include the source file", () => {
  withTempDirectory((recipesRoot) => {
    const localeDirectory = path.join(recipesRoot, "en");
    mkdirSync(localeDirectory);
    const filePath = path.join(localeDirectory, "broken.json");
    writeFileSync(filePath, "{\"title\":", "utf8");

    assert.throws(
      () => loadRecipeCatalog(recipesRoot),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(`Malformed JSON in "${filePath}"`)
    );
  });
});

test("recipe files are bounded, strict UTF-8 JSON documents", () => {
  withTempDirectory((recipesRoot) => {
    writeRawRecord(
      recipesRoot,
      "en",
      "too-large.json",
      Buffer.alloc(recipeContentLimits.maxFileBytes + 1, 0x20)
    );
    assert.throws(
      () => loadRecipeCatalog(recipesRoot),
      /maximum size/
    );
  });

  withTempDirectory((recipesRoot) => {
    writeRawRecord(
      recipesRoot,
      "en",
      "invalid-utf8.json",
      Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])
    );
    assert.throws(
      () => loadRecipeCatalog(recipesRoot),
      /Unable to read recipe file.*UTF-8|Unable to read recipe file.*encoding/si
    );
  });

  withTempDirectory((recipesRoot) => {
    const record = JSON.stringify(localizedRecord("en", "bom", "3101"));
    writeRawRecord(
      recipesRoot,
      "en",
      "bom.json",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(record)])
    );
    assert.throws(
      () => loadRecipeCatalog(recipesRoot),
      /Malformed JSON.*Expected a JSON value at character 0/s
    );
  });
});

test("recipe file loading rejects duplicate object keys before schema parsing", () => {
  const serialized = JSON.stringify(
    localizedRecord("en", "duplicate", "3100")
  );

  withTempDirectory((recipesRoot) => {
    writeRawRecord(
      recipesRoot,
      "en",
      "duplicate.json",
      `{"slug":"shadow",${serialized.slice(1)}`
    );
    assert.throws(
      () => loadRecipeCatalog(recipesRoot),
      /Malformed JSON.*Duplicate JSON object key "slug"/s
    );
  });

  withTempDirectory((recipesRoot) => {
    writeRawRecord(
      recipesRoot,
      "en",
      "duplicate.json",
      `{"sl\\u0075g":"shadow",${serialized.slice(1)}`
    );
    assert.throws(
      () => loadRecipeCatalog(recipesRoot),
      /Malformed JSON.*Duplicate JSON object key "slug"/s
    );
  });
});

test("unknown JSON fields are rejected with file context", () => {
  withTempDirectory((recipesRoot) => {
    const serialized = JSON.stringify(localizedRecord("en", "unknown", "3000"));
    writeRecord(
      recipesRoot,
      "en",
      "unknown.json",
      JSON.parse(`${serialized.slice(0, -1)},"unknownField":true}`)
    );

    assert.throws(
      () => loadRecipeCatalog(recipesRoot),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("unknown.json") &&
        error.message.includes("Unrecognized key")
    );
  });
});

test("locale-folder mismatches are rejected with file context", () => {
  withTempDirectory((recipesRoot) => {
    const filePath = path.join(recipesRoot, "en", "french.json");
    writeRecord(recipesRoot, "en", "french.json", localizedRecord("fr", "bonjour", "3002"));

    assert.throws(
      () => loadRecipeCatalog(recipesRoot),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          `Locale-folder mismatch in "${filePath}": record locale "fr" does not match folder "en".`
    );
  });
});

test("recipe filenames exactly match NFC-normalized raw Unicode slugs", () => {
  withTempDirectory((recipesRoot) => {
    writeRecord(
      recipesRoot,
      "en",
      "wrong-name.json",
      localizedRecord("en", "right-name", "3110")
    );
    assert.throws(
      () => loadRecipeCatalog(recipesRoot),
      /Filename-slug mismatch.*expected "right-name\.json"/s
    );
  });

  withTempDirectory((recipesRoot) => {
    const decomposedFileName = `cafe\u0301.json`;
    writeRecord(
      recipesRoot,
      "fr",
      decomposedFileName,
      localizedRecord("fr", "café", "3111")
    );
    assert.throws(
      () => loadRecipeCatalog(recipesRoot),
      /filename must use NFC-normalized Unicode/
    );
  });

  withTempDirectory((recipesRoot) => {
    writeRecord(
      recipesRoot,
      "ru",
      "суп-с-фрикадельками.json",
      localizedRecord("ru", "суп-с-фрикадельками", "3112")
    );
    assert.equal(loadRecipeCatalog(recipesRoot)[0]?.slug, "суп-с-фрикадельками");
  });
});

test("duplicate IDs and localized slugs are rejected", () => {
  withTempDirectory((recipesRoot) => {
    writeRecord(recipesRoot, "en", "first.json", localizedRecord("en", "first", "3000"));
    writeRecord(recipesRoot, "fr", "second.json", {
      ...localizedRecord("fr", "second", "3001"),
      id: "wordpress:wprm:3000"
    });
    assert.throws(() => loadRecipeCatalog(recipesRoot), /Duplicate content ID/);
  });

  assert.throws(
    () => validateCatalog([
      localizedRecord("en", "first", "3000"),
      localizedRecord("en", "first", "3003")
    ]),
    /Duplicate localized slug/
  );
});

test("translation groups reject duplicate locales with both source paths", () => {
  withTempDirectory((recipesRoot) => {
    writeRecord(
      recipesRoot,
      "en",
      "first.json",
      localizedRecord("en", "first", "3000", "group-1")
    );
    writeRecord(
      recipesRoot,
      "en",
      "second.json",
      localizedRecord("en", "second", "3004", "group-1")
    );

    const secondPath = path.join(recipesRoot, "en", "second.json");
    assert.throws(
      () => loadRecipeCatalog(recipesRoot),
      (error: unknown) =>
        error instanceof Error
        && error.message.includes("Duplicate translation group locale")
        && error.message.includes(secondPath)
        && error.message.includes(path.join(recipesRoot, "en", "first.json"))
    );
  });
});

test("translation groups may be asymmetric across locales", () => {
  withTempDirectory((recipesRoot) => {
    writeRecord(
      recipesRoot,
      "en",
      "english.json",
      localizedRecord("en", "english", "3000", "group-2")
    );
    writeRecord(
      recipesRoot,
      "fr",
      "soupe.json",
      localizedRecord("fr", "soupe", "3005", "group-2")
    );

    assert.deepEqual(
      loadRecipeCatalog(recipesRoot).map((record) => record.locale),
      ["en", "fr"]
    );
  });
});

test("published recipes preserve source-backed WordPress URLs across slug changes", () => {
  const moved = {
    ...localizedRecord("ru", "новый-адрес", "3120"),
    source: {
      ...localizedRecord("ru", "новый-адрес", "3120").source,
      editorialPostId: "4120",
      editorialPostType: "post",
      editorialSourceSlug:
        "%d1%81%d1%82%d0%b0%d1%80%d1%8b%d0%b9-%d0%b0%d0%b4%d1%80%d0%b5%d1%81"
    },
    redirectFrom: [
      "/ru/%d1%81%d1%82%d0%b0%d1%80%d1%8b%d0%b9-%d0%b0%d0%b4%d1%80%d0%b5%d1%81/"
    ]
  };

  withTempDirectory((recipesRoot) => {
    writeRecord(recipesRoot, "ru", "новый-адрес.json", moved);
    assert.equal(loadRecipeCatalog(recipesRoot)[0]?.slug, "новый-адрес");
  });

  withTempDirectory((recipesRoot) => {
    writeRecord(recipesRoot, "ru", "новый-адрес.json", {
      ...moved,
      redirectFrom: []
    });
    const filePath = path.join(recipesRoot, "ru", "новый-адрес.json");
    assert.throws(
      () => loadRecipeCatalog(recipesRoot),
      (error: unknown) =>
        error instanceof Error
        && error.message.includes("does not preserve its WordPress source URL")
        && error.message.includes(filePath)
    );
  });
});

test("catalog redirects cannot collide with canonical routes or each other", () => {
  withTempDirectory((recipesRoot) => {
    writeRecord(
      recipesRoot,
      "en",
      "first.json",
      localizedRecord("en", "first", "3130")
    );
    writeRecord(recipesRoot, "en", "second.json", {
      ...localizedRecord("en", "second", "3131"),
      redirectFrom: ["/recipes/first/"]
    });
    assert.throws(
      () => loadRecipeCatalog(recipesRoot),
      /redirect source collides with a canonical route/
    );
  });

  withTempDirectory((recipesRoot) => {
    writeRecord(recipesRoot, "en", "first.json", {
      ...localizedRecord("en", "first", "3132"),
      redirectFrom: ["/old-recipe/"]
    });
    writeRecord(recipesRoot, "fr", "second.json", {
      ...localizedRecord("fr", "second", "3133"),
      redirectFrom: ["/old-recipe"]
    });
    assert.throws(
      () => loadRecipeCatalog(recipesRoot),
      /Duplicate recipe redirect source/
    );
  });
});

test("JSON loading preserves nested records and explicit null values", () => {
  withTempDirectory((recipesRoot) => {
    const written = localizedRecord("en", "nested-fixture", "3010");
    writeRecord(recipesRoot, "en", "nested-fixture.json", written);
    const source = JSON.parse(
      readFileSync(path.join(recipesRoot, "en/nested-fixture.json"), "utf8")
    ) as unknown;
    const [loaded] = loadRecipeCatalog(recipesRoot);

    assert.deepEqual(loaded, source);
    assert.equal(loaded.recipe.times.cook, written.recipe.times.cook);
    assert.equal(
      loaded.recipe.ingredientGroups[0]?.items[0]?.notes,
      written.recipe.ingredientGroups[0]?.items[0]?.notes
    );
    assert.equal(loaded.media[0]?.alt, written.media[0]?.alt);
  });
});

test("media validation requires regular files under public and keeps null alt valid", () => {
  withTempDirectory((publicRoot) => {
    const record = recipeRecordSchema.parse({
      ...localizedRecord("en", "media-fixture", "3011"),
      media: recipeFixture.media.map((media, index) => ({
        ...media,
        path: `/images/media-${index}.png`,
        alt: index === 0 ? null : media.alt
      }))
    });
    mkdirSync(path.join(publicRoot, "images"));
    writeFileSync(path.join(publicRoot, "images/media-0.png"), "image", "utf8");
    writeFileSync(path.join(publicRoot, "images/media-1.png"), "image", "utf8");

    assert.deepEqual(validateMediaPaths([record], publicRoot), [record]);
  });
});

test("media validation reports missing files and traversal", () => {
  withTempDirectory((publicRoot) => {
    const missing = recipeRecordSchema.parse({
      ...localizedRecord("en", "missing-media", "3012"),
      media: recipeFixture.media.map((media, index) => ({
        ...media,
        path: `/images/missing-${index}.png`
      }))
    });
    assert.throws(
      () => validateMediaPaths([missing], publicRoot),
      /Invalid media.*Missing media file/
    );

    assert.throws(
      () => recipeRecordSchema.parse({
        ...localizedRecord("en", "traversal-media", "3013"),
        media: recipeFixture.media.map((media) => ({
          ...media,
          path: "/%2e%2e/outside.png"
        }))
      }),
      /traversal/
    );
  });
});
