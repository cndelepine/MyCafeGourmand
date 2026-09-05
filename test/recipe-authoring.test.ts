import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAuthoredRecipeDocument } from "../src/content/authored-recipe";
import {
  loadRecipeCatalog,
  parsePersistedRecipeDocument,
  validateNormalizedRecipeCatalog
} from "../src/content/catalog";
import { getCategoryCatalog, getRecipeCategories } from "../src/content/categories";
import {
  authoredRecipeInputSchema,
  normalizeRecipeDocument,
  quantitySchema,
  type AuthoredRecipeInput
} from "../src/content/schema";
import { recipeRuntimeOnlyInvariants } from "../src/content/recipe-runtime-invariants";
import {
  validateCatalogBehavior,
  validateNormalizedRecipeDisplayText
} from "../src/content/validation";
import {
  findRecipeBySegments,
  getRecipeSegments,
  getRecipeTranslations
} from "../src/lib/recipe-routes";
import { recipeMatchesQuery } from "../src/lib/recipe-search";
import { getRecipeStructuredData } from "../src/lib/recipe-structured-data";
import { formatIngredient } from "../src/lib/scale-quantity";
import { getSitemapEntries } from "../src/lib/site-map";
import { runRecipeCli } from "../scripts/recipes/cli";
import { checkRecipeDocumentFormatting } from "../scripts/recipes/check";
import {
  AtomicWriteCommittedError,
  AtomicWriteIndeterminateError,
  writeAtomicFile
} from "../scripts/recipes/files";
import { createNewRecipe } from "../scripts/recipes/new";
import {
  createRecipeReport,
  serializeRecipeReport
} from "../scripts/recipes/report";
import {
  assertRecipeSchemaCurrent,
  serializeRecipeJsonSchema
} from "../scripts/recipes/schema-output";
import { recipeFixture } from "./fixtures/recipe";

const recordId = "123e4567-e89b-42d3-a456-426614174000";
const createdAt = "2026-08-30T12:00:00.000Z";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const authoredInput: AuthoredRecipeInput = authoredRecipeInputSchema.parse({
  locale: "ru",
  slug: "яблочный-десерт",
  title: "Яблочный десерт",
  description: null,
  publishedAt: "2026-08-29T10:00:00.000Z",
  modifiedAt: "2026-08-30T10:00:00.000Z",
  categories: [{
    name: "Десерты",
    slug: "десерты"
  }],
  recipe: {
    notes: null,
    servings: {
      raw: "2 порции",
      value: 2,
      unit: "порции",
      scalable: true
    },
    times: {
      prep: {
        raw: "10 минут",
        minutes: 10
      },
      cook: null,
      rest: null,
      total: {
        raw: "10 минут",
        minutes: 10
      },
      custom: null
    },
    ingredientGroups: [{
      name: null,
      items: [{
        raw: "1 яблоко",
        quantity: {
          raw: "1",
          value: 1,
          unit: null,
          scalable: true
        },
        name: "яблоко",
        pluralName: "яблока",
        notes: null
      }]
    }],
    instructionGroups: [{
      name: null,
      steps: [{
        text: "Нарежьте яблоко."
      }]
    }]
  },
  seo: null
});

function withTempRepository<T>(
  callback: (values: {
    repositoryRoot: string;
    recipesRoot: string;
    inputPath: string;
  }) => Promise<T> | T
) {
  const repositoryRoot = mkdtempSync(
    path.join(process.cwd(), ".recipe-authoring-test-")
  );
  const recipesRoot = path.join(repositoryRoot, "content", "recipes");
  for (const locale of ["en", "fr", "ru"]) {
    mkdirSync(path.join(recipesRoot, locale), { recursive: true });
  }
  const inputPath = path.join(repositoryRoot, "author-input.json");
  writeFileSync(inputPath, `${JSON.stringify(authoredInput, null, 2)}\n`, "utf8");
  return Promise.resolve(callback({ repositoryRoot, recipesRoot, inputPath }))
    .finally(() => {
      rmSync(repositoryRoot, { force: true, recursive: true });
    });
}

test("authored v2 normalizes source-neutral fields without inventing media", () => {
  const document = createAuthoredRecipeDocument(
    authoredInput,
    recordId,
    createdAt
  );
  const record = normalizeRecipeDocument(document);
  const validated = validateNormalizedRecipeCatalog([record]);

  assert.equal(document.id, `authored:recipe:${recordId}`);
  assert.equal(document.source.createdAt, createdAt);
  assert.equal("equipment" in document.recipe, false);
  assert.equal(record.recipe.equipment, undefined);
  assert.equal(record.description, null);
  assert.equal(record.editorial.content, null);
  assert.equal(record.recipe.heroMediaId, null);
  assert.equal(record.recipe.instructionGroups[0]?.steps[0]?.mediaId, null);
  assert.deepEqual(record.media, []);
  assert.equal(record.recipe.ingredientGroups[0]?.sourceIndex, 0);
  assert.equal(record.recipe.ingredientGroups[0]?.items[0]?.sourceIndex, 0);
  assert.equal(validated[0], record);
  assert.throws(
    () => parsePersistedRecipeDocument({ ...document, media: [] }),
    /Unrecognized key/
  );
  assert.throws(
    () => parsePersistedRecipeDocument({ ...document, id: "authored:recipe:different" }),
    /Authored recipe ID must be/
  );
});

test("authored timestamps are factual publication metadata, not source creation guesses", () => {
  const document = createAuthoredRecipeDocument(
    authoredInput,
    recordId,
    createdAt
  );
  const record = normalizeRecipeDocument(document);
  const data = getRecipeStructuredData(record);
  const recipeEntry = getSitemapEntries([record]).find(
    (entry) => decodeURIComponent(new URL(entry.url).pathname).includes("яблочный-десерт")
  );

  assert.equal(data.datePublished, authoredInput.publishedAt);
  assert.equal(data.dateModified, authoredInput.modifiedAt);
  assert.notEqual(data.datePublished, createdAt);
  assert.equal(
    recipeEntry?.lastModified instanceof Date
      ? recipeEntry.lastModified.toISOString()
      : recipeEntry?.lastModified,
    authoredInput.modifiedAt
  );

  assert.throws(
    () => authoredRecipeInputSchema.parse({
      ...authoredInput,
      modifiedAt: "2026-08-28T10:00:00.000Z"
    }),
    /modifiedAt cannot be earlier/
  );
});

test("authored v2 participates in routes, categories, search, scaling, and JSON-LD", () => {
  const record = normalizeRecipeDocument(
    createAuthoredRecipeDocument(authoredInput, recordId, createdAt)
  );
  validateNormalizedRecipeDisplayText([record]);
  const behavior = validateCatalogBehavior([record]);
  const segments = getRecipeSegments(record);
  const categories = getCategoryCatalog([record]);

  assert.equal(findRecipeBySegments(segments, [record]), record);
  assert.equal(recipeMatchesQuery(record, "яблоко десерты"), true);
  assert.equal(categories[0]?.identity, "authored:ru:десерты");
  assert.deepEqual(getRecipeCategories(record, categories), categories);
  assert.equal(
    formatIngredient(record.recipe.ingredientGroups[0]!.items[0]!, 2),
    "2 яблока"
  );
  assert.equal(getRecipeStructuredData(record).image, undefined);
  assert.equal(getRecipeStructuredData(record).recipeIngredient[0], "1 яблоко");
  assert.equal(behavior.byLocale.ru, 1);
  assert.equal(behavior.categoriesByLocale.ru, 1);
});

test("authored categories join matching WordPress routes without replacing source identity", () => {
  const wordpress = {
    ...recipeFixture,
    taxonomies: [{
      scope: "editorial" as const,
      taxonomy: "category",
      sourceId: "100",
      sourceTaxonomyId: "200",
      name: "Desserts",
      slug: "desserts"
    }]
  };
  const authored = normalizeRecipeDocument(createAuthoredRecipeDocument({
    ...authoredInput,
    locale: "en",
    slug: "new-apple-dessert",
    title: "New apple dessert",
    categories: [{ name: "Desserts", slug: "desserts" }]
  }, recordId, createdAt));
  assert.equal(authored.schemaVersion, 2);
  if (authored.schemaVersion !== 2) {
    throw new Error("Expected an authored v2 recipe.");
  }
  const records = validateNormalizedRecipeCatalog([wordpress, authored]);
  const categories = getCategoryCatalog(records);

  assert.equal(categories.length, 1);
  assert.equal(categories[0]?.identity, "en:200");
  assert.equal(categories[0]?.sourceTaxonomyId, "200");
  assert.deepEqual(categories[0]?.recipes, records);
  assert.throws(
    () => getCategoryCatalog([
      wordpress,
      {
        ...authored,
        taxonomies: authored.taxonomies.map((taxonomy) => ({
          ...taxonomy,
          name: "Sweet dishes"
        }))
      }
    ]),
    /Inconsistent localized category/
  );
  assert.throws(
    () => getCategoryCatalog([
      wordpress,
      {
        ...wordpress,
        id: "wordpress:wprm:2",
        slug: "another-recipe",
        source: {
          ...wordpress.source,
          recipeId: "2"
        },
        taxonomies: [{
          ...wordpress.taxonomies[0]!,
          slug: "sweet-dishes"
        }]
      }
    ]),
    /Inconsistent editorial category identity/
  );
  assert.throws(
    () => authoredRecipeInputSchema.parse({
      ...authoredInput,
      categories: [{ name: "Invalid", slug: "CON" }]
    }),
    /Windows-reserved path component/
  );
  const collidingCategory = normalizeRecipeDocument(createAuthoredRecipeDocument({
    ...authoredInput,
    locale: "en",
    slug: "second-apple-dessert",
    title: "Second apple dessert",
    categories: [{ name: "Desserts", slug: "DESSERTS" }]
  }, "7db6de4d-5e43-49d1-b7fe-0597f304e31d", createdAt));
  assert.throws(
    () => getCategoryCatalog([authored, collidingCategory]),
    /Cross-platform category path collision/
  );
});

test("authored translation groups preserve intentional absence without inference", () => {
  const russian = {
    ...createAuthoredRecipeDocument(authoredInput, recordId, createdAt),
    translationGroupId: "authored:translations:fruit-dessert"
  };
  const englishId = "8db1d9cf-d91f-4610-8b23-342b154bc403";
  const english = {
    ...createAuthoredRecipeDocument({
      ...authoredInput,
      locale: "en",
      slug: "apple-dessert",
      title: "Apple dessert",
      categories: [{ name: "Desserts", slug: "desserts" }]
    }, englishId, createdAt),
    translationGroupId: "authored:translations:fruit-dessert"
  };
  const records = validateNormalizedRecipeCatalog([
    normalizeRecipeDocument(parsePersistedRecipeDocument(russian)),
    normalizeRecipeDocument(parsePersistedRecipeDocument(english))
  ]);

  assert.deepEqual(
    getRecipeTranslations(records[0]!, records).map((record) => record.locale),
    ["ru", "en"]
  );
  assert.equal(records.some((record) => record.locale === "fr"), false);
});

test("new is deterministic in dry-run and exclusively creates one Unicode file", async () => {
  await withTempRepository(async ({ repositoryRoot, recipesRoot, inputPath }) => {
    const dependencies = {
      repositoryRoot,
      recipesRoot,
      createRecordId: () => recordId,
      now: () => new Date(createdAt)
    };
    const first = await createNewRecipe({ input: inputPath }, dependencies);
    const second = await createNewRecipe({ input: inputPath }, dependencies);
    assert.deepEqual(first, second);
    assert.equal(first.mode, "dry-run");
    assert.equal(loadRecipeCatalog(recipesRoot).length, 0);

    const written = await createNewRecipe(
      {
        input: inputPath,
        recordId: first.document.source.recordId,
        createdAt: first.document.source.createdAt,
        write: true
      },
      { repositoryRoot, recipesRoot }
    );
    const destination = path.join(
      recipesRoot,
      "ru",
      "яблочный-десерт.json"
    );
    assert.equal(written.mode, "write");
    assert.equal(readFileSync(destination, "utf8"), `${JSON.stringify(written.document, null, 2)}\n`);
    assert.equal(loadRecipeCatalog(recipesRoot)[0]?.schemaVersion, 2);
    await assert.rejects(
      () => createNewRecipe({ input: inputPath, write: true }, dependencies),
      /Duplicate content ID|Duplicate localized slug|already exists/
    );
  });
});

test("new removes its staged file when exclusive installation fails", async () => {
  await withTempRepository(async ({ repositoryRoot, recipesRoot, inputPath }) => {
    await assert.rejects(
      () => createNewRecipe(
        { input: inputPath, write: true },
        {
          repositoryRoot,
          recipesRoot,
          createRecordId: () => recordId,
          now: () => new Date(createdAt),
          beforeInstall: () => {
            assert.deepEqual(readdirSync(path.join(recipesRoot, "ru")), []);
            assert.equal(
              readdirSync(repositoryRoot).some((name) =>
                /^\.recipe-authoring-.*\.tmp$/u.test(name)
              ),
              true
            );
            throw new Error("injected installation failure");
          }
        }
      ),
      /injected installation failure/
    );
    assert.deepEqual(readdirSync(path.join(recipesRoot, "ru")), []);
  });
});

test("new never installs or deletes a replaced staged file", async () => {
  await withTempRepository(async ({ repositoryRoot, recipesRoot, inputPath }) => {
    let stagedPath: string | undefined;
    await assert.rejects(
      () => createNewRecipe(
        {
          input: inputPath,
          recordId,
          createdAt,
          write: true
        },
        {
          repositoryRoot,
          recipesRoot,
          beforeInstall: () => {
            const stagedName = readdirSync(repositoryRoot).find((name) =>
              /^\.recipe-authoring-[^.].*\.tmp$/u.test(name)
            );
            assert.ok(stagedName);
            stagedPath = path.join(repositoryRoot, stagedName);
            rmSync(stagedPath);
            writeFileSync(stagedPath, "concurrent staged replacement", "utf8");
          }
        }
      ),
      /cleanup also failed/
    );
    assert.deepEqual(readdirSync(path.join(recipesRoot, "ru")), []);
    assert.ok(stagedPath);
    assert.equal(
      readFileSync(stagedPath, "utf8"),
      "concurrent staged replacement"
    );
  });
});

test("new rejects non-portable filenames before dry-run succeeds", async () => {
  await withTempRepository(async ({ repositoryRoot, recipesRoot, inputPath }) => {
    writeFileSync(
      inputPath,
      `${JSON.stringify({ ...authoredInput, slug: "CON" }, null, 2)}\n`,
      "utf8"
    );
    await assert.rejects(
      () => createNewRecipe(
        { input: inputPath },
        {
          repositoryRoot,
          recipesRoot,
          createRecordId: () => recordId,
          now: () => new Date(createdAt)
        }
      ),
      /Windows-reserved path component/
    );
    assert.deepEqual(readdirSync(path.join(recipesRoot, "ru")), []);
  });
});

test("new refuses to create locale record 513", async () => {
  await withTempRepository(async ({ repositoryRoot, recipesRoot, inputPath }) => {
    for (let index = 0; index < 512; index += 1) {
      const slug = `existing-recipe-${index + 1}`;
      const recipeId = String(index + 10_000);
      const record = {
        ...recipeFixture,
        id: `wordpress:wprm:${recipeId}`,
        locale: "ru" as const,
        slug,
        source: {
          ...recipeFixture.source,
          recipeId
        }
      };
      writeFileSync(
        path.join(recipesRoot, "ru", `${slug}.json`),
        `${JSON.stringify(record, null, 2)}\n`,
        "utf8"
      );
    }

    await assert.rejects(
      () => createNewRecipe(
        {
          input: inputPath,
          recordId,
          createdAt,
          write: true
        },
        { repositoryRoot, recipesRoot }
      ),
      /Recipe locale "ru" exceeds the maximum of 512 records/
    );
    assert.equal(
      readdirSync(path.join(recipesRoot, "ru")).includes("яблочный-десерт.json"),
      false
    );
  });
});

test("new rolls back a verified target when post-link finalization fails", async () => {
  await withTempRepository(async ({ repositoryRoot, recipesRoot, inputPath }) => {
    for (const dependencies of [
      {
        afterInstall: () => {
          throw new Error("injected temporary cleanup failure");
        }
      },
      {
        beforeDirectorySync: () => {
          throw new Error("injected directory durability failure");
        }
      }
    ]) {
      await assert.rejects(
        () => createNewRecipe(
          {
            input: inputPath,
            recordId,
            createdAt,
            write: true
          },
          {
            repositoryRoot,
            recipesRoot,
            ...dependencies
          }
        ),
        /injected (temporary cleanup|directory durability) failure/
      );
      assert.deepEqual(readdirSync(path.join(recipesRoot, "ru")), []);
      assert.equal(
        readdirSync(repositoryRoot).some((name) =>
          /^\.recipe-authoring-.*\.tmp$/u.test(name)
          || name === ".recipe-authoring.lock"
        ),
        false
      );
    }
  });
});

test("CLI reports committed success when only lock cleanup fails", async () => {
  await withTempRepository(async ({ repositoryRoot, recipesRoot, inputPath }) => {
    let output = "";
    await runRecipeCli([
      "new",
      "--input",
      inputPath,
      "--id",
      recordId,
      "--created-at",
      createdAt,
      "--write"
    ], {
      repositoryRoot,
      recipesRoot,
      beforeLockRelease: () => {
        throw new Error("injected lock cleanup failure");
      },
      writeOutput: (value) => {
        output += value;
      }
    });
    const result = JSON.parse(output) as unknown;
    assert.ok(isRecord(result));
    assert.equal(result.mode, "committed-with-cleanup-error");
    assert.match(String(result.cleanupError), /injected lock cleanup failure/);
    assert.equal(
      loadRecipeCatalog(recipesRoot)[0]?.id,
      `authored:recipe:${recordId}`
    );
    assert.equal(
      readdirSync(repositoryRoot).some((name) =>
        /^\.recipe-authoring-quarantine-.*\.tmp$/u.test(name)
      ),
      true
    );
  });
});

test("combined write and lock cleanup failure preserves committed state", async () => {
  await withTempRepository(async ({ repositoryRoot, recipesRoot, inputPath }) => {
    let caught: unknown;
    try {
      await createNewRecipe(
        {
          input: inputPath,
          recordId,
          createdAt,
          write: true
        },
        {
          repositoryRoot,
          recipesRoot,
          afterInstall: () => {
            throw new Error("injected post-commit failure");
          },
          beforeRollback: () => {
            throw new Error("injected rollback failure");
          },
          beforeCommittedDirectorySync: () => {
            throw new Error("injected committed sync failure");
          },
          beforeLockRelease: () => {
            throw new Error("injected lock release failure");
          }
        }
      );
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof AtomicWriteCommittedError);
    assert.equal(caught.committed, true);
    assert.match(caught.message, /^COMMITTED:/u);
    assert.equal(loadRecipeCatalog(recipesRoot).length, 1);
  });
});

test("rollback durability failure is reported as indeterminate", async () => {
  await withTempRepository(async ({ repositoryRoot, recipesRoot, inputPath }) => {
    let caught: unknown;
    try {
      await createNewRecipe(
        {
          input: inputPath,
          recordId,
          createdAt,
          write: true
        },
        {
          repositoryRoot,
          recipesRoot,
          afterInstall: () => {
            throw new Error("injected post-link failure");
          },
          beforeRollbackDirectorySync: () => {
            throw new Error("injected rollback sync failure");
          }
        }
      );
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof AtomicWriteIndeterminateError);
    assert.equal(caught.committed, "indeterminate");
    assert.match(caught.message, /^INDETERMINATE:/u);
    assert.deepEqual(readdirSync(path.join(recipesRoot, "ru")), []);
  });
});

test("Windows uses handle-bound exclusive destination creation", async () => {
  await withTempRepository(async ({ repositoryRoot, recipesRoot, inputPath }) => {
    const written = await createNewRecipe(
      {
        input: inputPath,
        recordId,
        createdAt,
        write: true
      },
      {
        repositoryRoot,
        recipesRoot,
        platform: "win32"
      }
    );
    assert.equal(written.mode, "write");
    assert.equal(
      readdirSync(repositoryRoot).some((name) =>
        /^\.recipe-authoring-[^.].*\.tmp$/u.test(name)
      ),
      false
    );
  });
});

test("Windows exclusive creation refuses a last-moment reparse entry", async () => {
  await withTempRepository(async ({ repositoryRoot, inputPath }) => {
    const target = path.join(repositoryRoot, "windows-target.json");
    await assert.rejects(
      () => writeAtomicFile(
        target,
        "{}\n",
        false,
        {
          platform: "win32",
          stagingDirectory: repositoryRoot,
          beforeInstall: () => {
            symlinkSync(inputPath, target);
          }
        }
      ),
      /reparse or non-file entry/
    );
    assert.equal(readFileSync(target, "utf8").includes("\"locale\""), true);
  });
});

test("Windows post-close destination ambiguity is indeterminate", async () => {
  await withTempRepository(async ({ repositoryRoot, recipesRoot, inputPath }) => {
    let caught: unknown;
    try {
      await createNewRecipe(
        {
          input: inputPath,
          recordId,
          createdAt,
          write: true
        },
        {
          repositoryRoot,
          recipesRoot,
          platform: "win32",
          afterWindowsHandleClose: (targetPath) => {
            rmSync(targetPath);
          }
        }
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof AtomicWriteIndeterminateError);
    assert.equal(caught.committed, "indeterminate");
    assert.match(caught.message, /^INDETERMINATE:/u);
  });
});

test("Windows post-close callback failure is indeterminate", async () => {
  await withTempRepository(async ({ repositoryRoot, recipesRoot, inputPath }) => {
    let caught: unknown;
    try {
      await createNewRecipe(
        {
          input: inputPath,
          recordId,
          createdAt,
          write: true
        },
        {
          repositoryRoot,
          recipesRoot,
          platform: "win32",
          afterWindowsHandleClose: () => {
            throw new Error("injected post-close failure");
          }
        }
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof AtomicWriteIndeterminateError);
    assert.equal(caught.committed, "indeterminate");
    assert.match(caught.message, /^INDETERMINATE:/u);
  });
});

test("new serializes concurrent catalog mutations with an exclusive lock", async () => {
  await withTempRepository(async ({ repositoryRoot, recipesRoot, inputPath }) => {
    let enterInstall: (() => void) | undefined;
    let releaseInstall: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enterInstall = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    const first = createNewRecipe(
      {
        input: inputPath,
        recordId,
        createdAt,
        write: true
      },
      {
        repositoryRoot,
        recipesRoot,
        beforeInstall: async () => {
          enterInstall?.();
          await release;
        }
      }
    );
    await entered;
    await assert.rejects(
      () => createNewRecipe(
        {
          input: inputPath,
          recordId: "bd6414f4-981b-442e-a3f3-3fd0d609b8e6",
          createdAt,
          write: true
        },
        { repositoryRoot, recipesRoot }
      ),
      /Recipe authoring is locked/
    );
    releaseInstall?.();
    await first;
    assert.equal(loadRecipeCatalog(recipesRoot).length, 1);
  });
});

test("report, schema, formatting checks, and CLI help are deterministic and strict", async () => {
  const serializedSchema = serializeRecipeJsonSchema();
  assert.equal(serializedSchema, serializeRecipeJsonSchema());
  assert.doesNotThrow(() => assertRecipeSchemaCurrent(process.cwd()));
  const schema = JSON.parse(serializedSchema) as unknown;
  assert.ok(isRecord(schema));
  assert.ok(Array.isArray(schema.anyOf));
  const authoredBranch = schema.anyOf.find((branch) => {
    if (!isRecord(branch) || !isRecord(branch.properties)) {
      return false;
    }
    const version = branch.properties.schemaVersion;
    return isRecord(version) && version.const === 2;
  });
  assert.ok(isRecord(authoredBranch));
  assert.ok(isRecord(authoredBranch.properties));
  assert.equal("media" in authoredBranch.properties, false);
  assert.equal("categories" in authoredBranch.properties, true);
  assert.match(serializedSchema, /"const": false/u);
  assert.match(serializedSchema, /"not": \{\}/u);
  assert.deepEqual(
    recipeRuntimeOnlyInvariants.map((invariant) => invariant.code),
    [
      "recipe-slug-path-and-filename-safety",
      "category-slug-path-safety",
      "quantity-range-order",
      "redirect-route-closure",
      "recipe-media-path-safety",
      "wordpress-managed-media-identity",
      "recipe-media-reference-closure",
      "authored-id-source-match",
      "authored-timestamp-order",
      "catalog-record-and-file-closure",
      "wordpress-source-identity-and-route",
      "normalized-display-text"
    ]
  );
  assert.ok(Array.isArray(schema["x-runtime-invariants"]));

  await withTempRepository(async ({ repositoryRoot, recipesRoot, inputPath }) => {
    await createNewRecipe(
      { input: inputPath, write: true },
      {
        repositoryRoot,
        recipesRoot,
        createRecordId: () => recordId,
        now: () => new Date(createdAt)
      }
    );
    const report = createRecipeReport(recipesRoot);
    assert.equal(serializeRecipeReport(report), serializeRecipeReport(report));
    assert.equal(report.summary.byVersion["2"], 1);
    assert.equal(report.summary.byProvenance.authored, 1);
    assert.equal(report.summary.ungroupedRecipes, 1);
    assert.deepEqual(
      report.fieldUsage.find(
        (field) => field.path === "source.createdAt/source.modifiedAt"
      )?.uses,
      ["structured-data", "provenance-only"]
    );
    assert.doesNotThrow(() => checkRecipeDocumentFormatting(recipesRoot));

    const destination = path.join(recipesRoot, "ru", "яблочный-десерт.json");
    const value = JSON.parse(readFileSync(destination, "utf8")) as unknown;
    writeFileSync(destination, JSON.stringify(value), "utf8");
    assert.throws(
      () => checkRecipeDocumentFormatting(recipesRoot),
      /not canonically formatted/
    );
  });

  let output = "";
  await runRecipeCli(["new", "--help"], {
    writeOutput: (value) => {
      output += value;
    }
  });
  assert.match(output, /Without --write/);
  await assert.rejects(
    () => runRecipeCli(["new", "--input", "one.json", "--input", "two.json"]),
    /Duplicate command-line option/
  );
  await assert.rejects(
    () => runRecipeCli(["report", "--write"]),
    /Unknown command-line option/
  );
  await assert.rejects(
    () => runRecipeCli(["unknown"]),
    /Unknown recipes command/
  );
  for (const inheritedName of ["constructor", "toString", "__proto__"]) {
    await assert.rejects(
      () => runRecipeCli([inheritedName]),
      /Unknown recipes command/
    );
    await assert.rejects(
      () => runRecipeCli([inheritedName, "--help"]),
      /Unknown recipes command/
    );
    await assert.rejects(
      () => runRecipeCli(["new", `--${inheritedName}`, "value"]),
      /Unknown command-line option/
    );
  }
});

test("quantity schema structurally rejects lossy parsed-value combinations", () => {
  const base = {
    raw: "source amount",
    unit: null
  };
  for (const invalid of [
    { ...base, value: 1, min: 1, max: 2, scalable: true },
    { ...base, min: 1, scalable: true },
    { ...base, max: 2, scalable: true },
    { ...base, scalable: true }
  ]) {
    assert.equal(quantitySchema.safeParse(invalid).success, false);
  }
  assert.equal(
    quantitySchema.safeParse({ ...base, scalable: false }).success,
    true
  );
  assert.equal(
    quantitySchema.safeParse({ ...base, value: 1, scalable: true }).success,
    true
  );
  assert.equal(
    quantitySchema.safeParse({ ...base, min: 1, max: 2, scalable: true }).success,
    true
  );
  assert.equal(
    quantitySchema.safeParse({ ...base, min: 2, max: 1, scalable: true }).success,
    false
  );
});

test("machine report orders non-ASCII translation IDs by code unit", async () => {
  await withTempRepository(({ recipesRoot }) => {
    const documents = [
      {
        document: createAuthoredRecipeDocument({
          ...authoredInput,
          locale: "en",
          slug: "accent-group",
          title: "Accent group"
        }, "35058d04-eb60-4897-92ed-23301d3b0d55", createdAt),
        group: "é-group"
      },
      {
        document: createAuthoredRecipeDocument({
          ...authoredInput,
          locale: "fr",
          slug: "zed-group",
          title: "Zed group"
        }, "66c0ad38-d9ed-4c83-b0d4-223647767c87", createdAt),
        group: "z-group"
      }
    ];
    for (const { document, group } of documents) {
      const grouped = { ...document, translationGroupId: group };
      writeFileSync(
        path.join(recipesRoot, grouped.locale, `${grouped.slug}.json`),
        `${JSON.stringify(grouped, null, 2)}\n`,
        "utf8"
      );
    }

    assert.deepEqual(
      createRecipeReport(recipesRoot).translations.groups.map((group) => group.id),
      ["z-group", "é-group"]
    );
  });
});

test("post-link rollback preserves a concurrently replaced target", async () => {
  await withTempRepository(async ({ repositoryRoot, recipesRoot, inputPath }) => {
    const destination = path.join(recipesRoot, "ru", "яблочный-десерт.json");
    let caught: unknown;
    try {
      await createNewRecipe(
        {
          input: inputPath,
          recordId,
          createdAt,
          write: true
        },
        {
          repositoryRoot,
          recipesRoot,
          afterInstall: () => {
            rmSync(destination);
            writeFileSync(destination, "concurrent replacement", "utf8");
          }
        }
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof AtomicWriteIndeterminateError);
    assert.equal(readFileSync(destination, "utf8"), "concurrent replacement");
  });
});

test("post-link validation preserves an in-place mutated target", async () => {
  await withTempRepository(async ({ repositoryRoot, recipesRoot, inputPath }) => {
    const destination = path.join(recipesRoot, "ru", "яблочный-десерт.json");
    let caught: unknown;
    try {
      await createNewRecipe(
        {
          input: inputPath,
          recordId,
          createdAt,
          write: true
        },
        {
          repositoryRoot,
          recipesRoot,
          afterInstall: () => {
            writeFileSync(destination, "in-place concurrent mutation", "utf8");
          }
        }
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof AtomicWriteIndeterminateError);
    assert.equal(
      readFileSync(destination, "utf8"),
      "in-place concurrent mutation"
    );
  });
});

test("post-link rollback preserves a non-file replacement in quarantine", async () => {
  await withTempRepository(async ({ repositoryRoot, recipesRoot, inputPath }) => {
    const destination = path.join(recipesRoot, "ru", "яблочный-десерт.json");
    let caught: unknown;
    try {
      await createNewRecipe(
        {
          input: inputPath,
          recordId,
          createdAt,
          write: true
        },
        {
          repositoryRoot,
          recipesRoot,
          afterInstall: () => {
            rmSync(destination);
            mkdirSync(destination);
            writeFileSync(path.join(destination, "marker.txt"), "preserved", "utf8");
          }
        }
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof AtomicWriteIndeterminateError);
    const quarantineName = readdirSync(repositoryRoot).find((name) =>
      /^\.recipe-authoring-quarantine-.*\.tmp$/u.test(name)
    );
    assert.ok(quarantineName);
    assert.equal(
      readFileSync(path.join(repositoryRoot, quarantineName, "marker.txt"), "utf8"),
      "preserved"
    );
  });
});

test("lock cleanup preserves a replacement quarantine entry", async () => {
  await withTempRepository(async ({ repositoryRoot, recipesRoot, inputPath }) => {
    let replacementPath: string | undefined;
    const result = await createNewRecipe(
      {
        input: inputPath,
        recordId,
        createdAt,
        write: true
      },
      {
        repositoryRoot,
        recipesRoot,
        beforeLockRelease: (quarantinePath) => {
          replacementPath = quarantinePath;
          rmSync(quarantinePath);
          writeFileSync(quarantinePath, "concurrent quarantine replacement", "utf8");
        }
      }
    );

    assert.equal(result.mode, "committed-with-cleanup-error");
    assert.ok(replacementPath);
    assert.equal(
      readFileSync(replacementPath, "utf8"),
      "concurrent quarantine replacement"
    );
    assert.equal(loadRecipeCatalog(recipesRoot).length, 1);
  });
});
