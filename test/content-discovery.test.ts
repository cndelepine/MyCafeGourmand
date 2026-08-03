import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  discoverRecipeFiles,
  loadRecipeCatalog,
  recipeCatalog
} from "../src/content/catalog";
import { recipeRecordSchema } from "../src/content/schema";
import { validateMediaPaths } from "../src/content/validation";

const meatballsSoup = recipeCatalog[0]!;

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

function localizedRecord(
  locale: "en" | "fr" | "ru",
  slug: string,
  recipeId: string
) {
  return recipeRecordSchema.parse({
    ...meatballsSoup,
    id: `wordpress:wprm:${recipeId}`,
    locale,
    slug,
    source: {
      ...meatballsSoup.source,
      recipeId
    }
  });
}

test("recipe discovery is deterministic and permits absent locale folders", () => {
  withTempDirectory((recipesRoot) => {
    writeRecord(recipesRoot, "en", "zeta.json", meatballsSoup);
    writeRecord(recipesRoot, "en", "alpha.json", localizedRecord("en", "alpha", "3001"));

    const files = discoverRecipeFiles(recipesRoot);
    assert.deepEqual(
      files.map((file) => path.relative(recipesRoot, file.path)),
      ["en/alpha.json", "en/zeta.json"]
    );
    assert.deepEqual(loadRecipeCatalog(recipesRoot).map((record) => record.slug), [
      "alpha",
      "meatballs-soup"
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
    writeRecord(recipesRoot, "en", "source.json", meatballsSoup);
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

test("unknown JSON fields are rejected with file context", () => {
  withTempDirectory((recipesRoot) => {
    const serialized = JSON.stringify(meatballsSoup);
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

test("duplicate IDs and localized slugs are rejected", () => {
  withTempDirectory((recipesRoot) => {
    writeRecord(recipesRoot, "en", "first.json", meatballsSoup);
    writeRecord(recipesRoot, "fr", "second.json", {
      ...meatballsSoup,
      locale: "fr"
    });
    assert.throws(() => loadRecipeCatalog(recipesRoot), /Duplicate content ID/);
  });

  withTempDirectory((recipesRoot) => {
    writeRecord(recipesRoot, "en", "first.json", meatballsSoup);
    writeRecord(
      recipesRoot,
      "en",
      "second.json",
      localizedRecord("en", meatballsSoup.slug, "3003")
    );
    assert.throws(() => loadRecipeCatalog(recipesRoot), /Duplicate localized slug/);
  });
});

test("translation groups reject duplicate locales with both source paths", () => {
  withTempDirectory((recipesRoot) => {
    writeRecord(recipesRoot, "en", "first.json", {
      ...meatballsSoup,
      translationGroupId: "group-1"
    });
    writeRecord(recipesRoot, "en", "second.json", {
      ...localizedRecord("en", "second", "3004"),
      translationGroupId: "group-1"
    });

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
    writeRecord(recipesRoot, "en", "english.json", {
      ...meatballsSoup,
      translationGroupId: "group-2"
    });
    writeRecord(recipesRoot, "fr", "french.json", {
      ...localizedRecord("fr", "soupe", "3005"),
      translationGroupId: "group-2"
    });

    assert.deepEqual(
      loadRecipeCatalog(recipesRoot).map((record) => record.locale),
      ["en", "fr"]
    );
  });
});

test("JSON loading preserves nested records and explicit null values", () => {
  withTempDirectory((recipesRoot) => {
    writeRecord(recipesRoot, "en", "meatballs-soup.json", meatballsSoup);
    const source = JSON.parse(
      readFileSync(path.join(recipesRoot, "en/meatballs-soup.json"), "utf8")
    ) as unknown;
    const [loaded] = loadRecipeCatalog(recipesRoot);

    assert.deepEqual(loaded, source);
    assert.equal(loaded.recipe.times.cook, null);
    assert.equal(loaded.recipe.ingredientGroups[0]?.items[0]?.notes, null);
    assert.equal(loaded.media[0]?.alt, "A bowl of meatball soup");
  });
});

test("media validation requires regular files under public and keeps null alt valid", () => {
  withTempDirectory((publicRoot) => {
    const record = recipeRecordSchema.parse({
      ...meatballsSoup,
      media: meatballsSoup.media.map((media, index) => ({
        ...media,
        path: "/images/hero.png",
        alt: index === 0 ? null : media.alt
      }))
    });
    mkdirSync(path.join(publicRoot, "images"));
    writeFileSync(path.join(publicRoot, "images/hero.png"), "image", "utf8");

    assert.deepEqual(validateMediaPaths([record], publicRoot), [record]);
  });
});

test("media validation reports missing files and traversal", () => {
  withTempDirectory((publicRoot) => {
    const missing = recipeRecordSchema.parse({
      ...meatballsSoup,
      media: meatballsSoup.media.map((media) => ({
        ...media,
        path: "/images/missing.png"
      }))
    });
    assert.throws(
      () => validateMediaPaths([missing], publicRoot),
      /Invalid media.*Missing media file/
    );

    const traversal = recipeRecordSchema.parse({
      ...meatballsSoup,
      media: meatballsSoup.media.map((media) => ({
        ...media,
        path: "/%2e%2e/outside.png"
      }))
    });
    assert.throws(
      () => validateMediaPaths([traversal], publicRoot),
      /Invalid media.*traversal/
    );
  });
});
