import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
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
  type AuthoredRecipeInput
} from "../src/content/schema";
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
});
