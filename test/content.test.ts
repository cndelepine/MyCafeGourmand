import assert from "node:assert/strict";
import test from "node:test";
import {
  recipeCatalog,
  validateCatalog,
  validateNormalizedRecipeCatalog
} from "../src/content/catalog";
import { recipeFixture } from "./fixtures/recipe";
import {
  recipeContentLimits,
  recipeRecordSchema
} from "../src/content/schema";
import {
  decodeLocalPath,
  decodeRecipeSlug,
  validateSafeLocalPath
} from "../src/content/url-path";
import {
  validateCatalogBehavior,
  validateNormalizedRecipeDisplayText
} from "../src/content/validation";

function assertTooBig(input: unknown, expectedPath: string) {
  const result = recipeRecordSchema.safeParse(input);
  assert.equal(result.success, false);
  if (result.success) {
    return;
  }
  assert.equal(
    result.error.issues.some((issue) =>
      issue.code === "too_big" && issue.path.map(String).join(".") === expectedPath
    ),
    true,
    JSON.stringify(result.error.issues)
  );
}

test("the production catalog passes the canonical schema", () => {
  const validated = validateNormalizedRecipeCatalog(recipeCatalog);
  const localeCounts = Object.fromEntries(
    ["en", "fr", "ru"].map((locale) => [
      locale,
      validated.filter((record) => record.locale === locale).length
    ])
  );

  assert.equal(validated.length, 522);
  assert.deepEqual(localeCounts, { en: 162, fr: 172, ru: 188 });
  assert.equal(new Set(validated.map((record) => record.id)).size, validated.length);
  assert.equal(
    validated.reduce((total, record) => total + record.redirectFrom.length, 0),
    570
  );
  assert.equal(
    validated.every((record) => record.schemaVersion === 1 && record.kind === "recipe"),
    true
  );
  assert.doesNotThrow(() => validateNormalizedRecipeDisplayText(validated));

  const authoritative = validated.find((record) => record.id === "wordpress:wprm:21681");
  assert.ok(authoritative);
  assert.equal(authoritative.schemaVersion, 1);
  if (authoritative.schemaVersion !== 1) {
    throw new Error("Expected a WordPress v1 recipe.");
  }
  assert.equal(authoritative.locale, "en");
  assert.equal(authoritative.slug, "meatballs-soup");
  assert.equal(authoritative.source.recipeId, "21681");
});

test("intentionally partial recipes retain their verified canonical legacy redirects", () => {
  const expectedRedirects = new Map([
    ["25047", "/petits-choux/"],
    ["25967", "/fr/rochers-a-la-noix-de-coco/"],
    [
      "26044",
      "/ru/%d1%84%d1%80%d0%b0%d0%bd%d1%86%d1%83%d0%b7%d1%81%d0%ba%d0%be%d0%b5-%d0%ba%d0%be%d0%ba%d0%be%d1%81%d0%be%d0%b2%d0%be%d0%b5-%d0%bf%d0%b5%d1%87%d0%b5%d0%bd%d1%8c%d0%b5/"
    ]
  ]);

  for (const [recipeId, redirect] of expectedRedirects) {
    const record = recipeCatalog.find((candidate) =>
      candidate.schemaVersion === 1 && candidate.source.recipeId === recipeId
    );
    assert.ok(record, `Missing intentionally partial recipe ${recipeId}`);
    assert.deepEqual(record.redirectFrom, [redirect]);
  }
});

test("missing translations remain missing", () => {
  const catalog = validateCatalog([recipeFixture]);

  assert.deepEqual(catalog.map((record) => record.locale), ["en"]);
});

test("recipe catalog, strings, and arrays have explicit generous bounds", () => {
  assert.throws(
    () => validateCatalog(
      new Array(recipeContentLimits.maxCatalogRecords + 1).fill(recipeFixture)
    ),
    /maximum.*records/
  );

  assertTooBig({
    ...recipeFixture,
    title: "x".repeat(recipeContentLimits.maxStringLength + 1)
  }, "title");
  assertTooBig({
    ...recipeFixture,
    redirectFrom: Array.from(
      { length: recipeContentLimits.maxRedirects + 1 },
      (_, index) => `/old-recipe-${index}/`
    )
  }, "redirectFrom");
  assertTooBig({
    ...recipeFixture,
    taxonomies: Array.from(
      { length: recipeContentLimits.maxTaxonomies + 1 },
      (_, index) => ({
        ...recipeFixture.taxonomies[0]!,
        sourceId: String(index),
        name: `Taxonomy ${index}`,
        slug: `taxonomy-${index}`
      })
    )
  }, "taxonomies");
  assertTooBig({
    ...recipeFixture,
    recipe: {
      ...recipeFixture.recipe,
      equipment: Array.from(
        { length: recipeContentLimits.maxEquipment + 1 },
        (_, index) => ({
          sourceIndex: index,
          sourceId: String(index),
          name: `Equipment ${index}`,
          amount: null,
          notes: null
        })
      )
    }
  }, "recipe.equipment");
  assertTooBig({
    ...recipeFixture,
    recipe: {
      ...recipeFixture.recipe,
      ingredientGroups: new Array(
        recipeContentLimits.maxIngredientGroups + 1
      ).fill(recipeFixture.recipe.ingredientGroups[0])
    }
  }, "recipe.ingredientGroups");
  assertTooBig({
    ...recipeFixture,
    recipe: {
      ...recipeFixture.recipe,
      ingredientGroups: [{
        ...recipeFixture.recipe.ingredientGroups[0]!,
        items: new Array(
          recipeContentLimits.maxIngredientsPerGroup + 1
        ).fill(recipeFixture.recipe.ingredientGroups[0]!.items[0])
      }]
    }
  }, "recipe.ingredientGroups.0.items");
  assertTooBig({
    ...recipeFixture,
    recipe: {
      ...recipeFixture.recipe,
      instructionGroups: new Array(
        recipeContentLimits.maxInstructionGroups + 1
      ).fill(recipeFixture.recipe.instructionGroups[0])
    }
  }, "recipe.instructionGroups");
  assertTooBig({
    ...recipeFixture,
    recipe: {
      ...recipeFixture.recipe,
      instructionGroups: [{
        ...recipeFixture.recipe.instructionGroups[0]!,
        steps: new Array(
          recipeContentLimits.maxStepsPerGroup + 1
        ).fill(recipeFixture.recipe.instructionGroups[0]!.steps[0])
      }]
    }
  }, "recipe.instructionGroups.0.steps");
  assertTooBig({
    ...recipeFixture,
    media: Array.from(
      { length: recipeContentLimits.maxMedia + 1 },
      (_, index) => ({
        id: `media-${index}`,
        sourceId: null,
        path: `/recipes/fixture-recipe/media-${index}.png`,
        alt: null,
        width: 1,
        height: 1
      })
    )
  }, "media");
});

test("the promoted catalog has deterministic category, pagination, and sitemap coverage", () => {
  const summary = validateCatalogBehavior(recipeCatalog);

  assert.deepEqual(summary.categoriesByLocale, { en: 11, fr: 10, ru: 12 });
  assert.deepEqual(summary.categoryMembershipsByLocale, { en: 225, fr: 250, ru: 265 });
  assert.deepEqual(summary.landingPagesByLocale, { en: 7, fr: 8, ru: 8 });
  assert.deepEqual(summary.categoryPagesByLocale, { en: 15, fr: 15, ru: 18 });
  assert.equal(summary.staticPaths, 593);
  assert.equal(summary.sitemapPaths, 593);
});

test("the schema rejects dangling media references", () => {
  const invalid = {
    ...recipeFixture,
    recipe: {
      ...recipeFixture.recipe,
      heroMediaId: "missing"
    }
  };

  assert.throws(() => recipeRecordSchema.parse(invalid), /Unknown media reference/);
});

test("recipe and managed media identities remain source-backed and closed", () => {
  assert.throws(
    () => validateCatalog([{
      ...recipeFixture,
      id: "wordpress:wprm:999"
    }]),
    /content ID does not match source identity/
  );

  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      media: [{
        ...recipeFixture.media[0]!,
        sourceId: "900",
        path: "/recipes/media/wordpress/900.jpg"
      }, recipeFixture.media[1]]
    }),
    /Managed recipe media ID must be wordpress-attachment:900/
  );

  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      recipe: {
        ...recipeFixture.recipe,
        heroMediaId: "wordpress-attachment:900"
      },
      media: [{
        ...recipeFixture.media[0]!,
        id: "wordpress-attachment:900",
        sourceId: "901",
        path: "/recipes/media/wordpress/900.jpg"
      }, recipeFixture.media[1]]
    }),
    /source ID must match attachment 900/
  );

  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      media: [{
        ...recipeFixture.media[0]!,
        sourceId: "900"
      }, recipeFixture.media[1]]
    }),
    /source ID must use a managed media path/
  );

  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      media: [
        ...recipeFixture.media,
        {
          id: "unused",
          sourceId: null,
          path: "/recipes/fixture-recipe/unused.png",
          alt: null,
          width: 1,
          height: 1
        }
      ]
    }),
    /Unreferenced recipe media/
  );
});

test("catalog validation always preserves source-backed WordPress URLs", () => {
  const sourceBacked = {
    ...recipeFixture,
    source: {
      ...recipeFixture.source,
      editorialPostId: "20",
      editorialPostType: "post",
      editorialSourceSlug: "old-fixture-recipe"
    }
  };
  assert.throws(
    () => validateCatalog([sourceBacked]),
    /does not preserve its WordPress source URL.*\/old-fixture-recipe\//
  );
  assert.doesNotThrow(() => validateCatalog([{
    ...sourceBacked,
    redirectFrom: ["/old-fixture-recipe/"]
  }]));
});

test("shared WordPress parent URLs remain ambiguous rather than forcing duplicate redirects", () => {
  const first = {
    ...recipeFixture,
    source: {
      ...recipeFixture.source,
      editorialPostId: "20",
      editorialPostType: "post",
      editorialSourceSlug: "shared-parent"
    }
  };
  const second = {
    ...first,
    id: "wordpress:wprm:2",
    slug: "second-recipe",
    source: {
      ...first.source,
      recipeId: "2"
    }
  };
  assert.doesNotThrow(() => validateCatalog([first, second]));
  assert.doesNotThrow(() => validateCatalog([
    { ...first, redirectFrom: ["/shared-parent/"] },
    second
  ]));
  assert.throws(
    () => validateCatalog([
      { ...first, redirectFrom: ["/shared-parent/"] },
      { ...second, redirectFrom: ["/shared-parent"] }
    ]),
    /Duplicate recipe redirect source/
  );
});

test("recipe safe parsing reports invalid slugs without throwing", () => {
  for (const slug of ["", "bad slug", "e\u0301clair", "bad%2fslug"]) {
    const result = recipeRecordSchema.safeParse({
      ...recipeFixture,
      slug
    });
    assert.equal(result.success, false);
  }
});

test("content validation rejects HTML from every normalized recipe display field", () => {
  assert.throws(
    () => validateNormalizedRecipeDisplayText([recipeRecordSchema.parse({
      ...recipeFixture,
      description: "<p>Unnormalized description</p>"
    })]),
    /contains HTML markup/
  );
  assert.throws(
    () => validateNormalizedRecipeDisplayText([recipeRecordSchema.parse({
      ...recipeFixture,
      recipe: {
        ...recipeFixture.recipe,
        instructionGroups: [{
          ...recipeFixture.recipe.instructionGroups[0]!,
          name: "<strong>Unnormalized group</strong>"
        }]
      }
    })]),
    /contains HTML markup/
  );
  assert.doesNotThrow(() => validateNormalizedRecipeDisplayText([recipeRecordSchema.parse({
    ...recipeFixture,
    description: "Normalized description."
  })]));
});

test("recipe slugs reject unsafe encoded path segments and preserve Cyrillic", () => {
  for (const slug of [
    ".",
    "..",
    "%2e",
    "%252e%252e",
    "%25252e%25252e",
    "unsafe/slug",
    "unsafe%2fslug",
    "unsafe%252fslug",
    "unsafe%5cslug",
    "malformed%",
    "malformed%2",
    "bad\ud800slug",
    "bad\udfffslug",
    "trailing\ud800"
  ]) {
    assert.throws(
      () => recipeRecordSchema.parse({ ...recipeFixture, slug }),
      /unsafe path segment|URL encoding|raw Unicode|well-formed Unicode/
    );
  }

  const cyrillic = recipeRecordSchema.parse({
    ...recipeFixture,
    locale: "ru",
    slug: "суп-с-фрикадельками",
    redirectFrom: []
  });

  assert.equal(cyrillic.slug, "суп-с-фрикадельками");
  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      slug: "cafe\u0301"
    }),
    /NFC-normalized Unicode/
  );

  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      locale: "ru",
      slug: "%D1%81%D1%83%D0%BF",
      redirectFrom: []
    }),
    /raw Unicode/
  );
});

test("recipe slug boundary decoding accepts Unicode but rejects unsafe layers", () => {
  const encoded = encodeURIComponent("суп-с-фрикадельками");
  assert.equal(decodeRecipeSlug(encoded), "суп-с-фрикадельками");
  assert.equal(decodeRecipeSlug(encodeURIComponent(encoded)), "суп-с-фрикадельками");

  for (const slug of [
    "unsafe/slug",
    "unsafe%2fslug",
    "unsafe%252fslug",
    "%2e%2e",
    "%252e%252e",
    "%3fquery",
    "%20space",
    "%2awildcard",
    "malformed%",
    "literal%25",
    "bad\ud800slug",
    "bad\udfffslug",
    "trailing\ud800"
  ]) {
    assert.throws(() => decodeRecipeSlug(slug));
  }

  let excessivelyEncoded = "%41";
  for (let index = 0; index < 10; index += 1) {
    excessivelyEncoded = encodeURIComponent(excessivelyEncoded);
  }
  assert.throws(
    () => decodeRecipeSlug(excessivelyEncoded),
    /excessive URL encoding/
  );
});

test("the catalog rejects duplicate localized slugs", () => {
  const duplicate = {
    ...recipeFixture,
    id: "wordpress:wprm:9999",
    source: {
      ...recipeFixture.source,
      recipeId: "9999"
    }
  };

  assert.throws(
    () => validateCatalog([recipeFixture, duplicate]),
    /Duplicate localized slug/
  );
});

test("recipe redirect sources preserve encoded Unicode and reject unsafe paths", () => {
  const source = "/ru/%D1%81%D1%83%D0%BF/";
  const record = recipeRecordSchema.parse({
    ...recipeFixture,
    locale: "ru",
    slug: "суп",
    redirectFrom: [source]
  });

  assert.equal(record.redirectFrom[0], source);
  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      redirectFrom: ["//external.example/recipe"]
    }),
    /root-relative/
  );
  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      redirectFrom: ["https://example.com/recipe"]
    }),
    /root-relative/
  );
  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      redirectFrom: ["/old?source=archive"]
    }),
    /query, fragment/
  );
  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      redirectFrom: ["/%2e%2e/private"]
    }),
    /traversal/
  );
  for (const redirectFrom of [
    "/%252e%252e/private",
    "/%25252e%25252e/private",
    "/%2fprivate",
    "/%252fprivate",
    "/safe%2fprivate",
    "/safe%252fprivate",
    "/%5cprivate",
    "/%255cprivate"
  ]) {
    assert.throws(
      () => recipeRecordSchema.parse({ ...recipeFixture, redirectFrom: [redirectFrom] }),
      /traversal|unsafe separator|unsafe character/
    );
  }
  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      redirectFrom: ["/malformed%"]
    }),
    /valid URL encoding/
  );
  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      redirectFrom: ["/"]
    }),
    /site root/
  );
});

test("safe local paths inspect repeated encodings and preserve encoded Unicode", () => {
  for (const path of [
    "/%2e%2e/private",
    "/%252e%252e/private",
    "/%25252e%25252e/private",
    "/%2fprivate",
    "/%252fprivate",
    "/safe%2fprivate",
    "/safe%252fprivate",
    "/%5cprivate",
    "/malformed%",
    "/malformed%2",
    "/bad\ud800path",
    "/bad\udfffpath",
    "/trailing\ud800"
  ]) {
    assert.throws(() => validateSafeLocalPath(path, "Test path"));
  }
  assert.throws(
    () => decodeLocalPath("/bad\ud800path"),
    /well-formed Unicode/
  );
  assert.throws(
    () => decodeLocalPath("/bad\udfffpath"),
    /well-formed Unicode/
  );
  assert.throws(
    () => decodeLocalPath("/trailing\ud800"),
    /well-formed Unicode/
  );
  assert.doesNotThrow(() => validateSafeLocalPath("/emoji-\ud83d\ude00", "Test path"));

  assert.doesNotThrow(() =>
    validateSafeLocalPath(
      "/ru/%D1%81%D1%83%D0%BF/",
      "Test path"
    )
  );
  assert.doesNotThrow(() => validateSafeLocalPath("/recipe%25", "Test path"));

  let excessivelyEncoded = "%41";
  for (let index = 0; index < 10; index += 1) {
    excessivelyEncoded = encodeURIComponent(excessivelyEncoded);
  }
  assert.throws(
    () => validateSafeLocalPath(`/${excessivelyEncoded}`, "Test path"),
    /excessive URL encoding/
  );
});

test("media paths reject managed aliases and compare effective local paths", () => {
  for (const mediaPath of [
    "/recipes/media/%77ordpress/900.jpg",
    "/recipes/media/%2577ordpress/900.jpg",
    "/recipes/media/wordpress/900.jp%67",
    "/recipes/media/wordpress/900.jpg%",
    "/recipes/media/wordpress",
    "/recipes/media/wordpress/",
    "/recipes/media/wordpress//"
  ]) {
    assert.throws(
      () => recipeRecordSchema.parse({
        ...recipeFixture,
        recipe: {
          ...recipeFixture.recipe,
          heroMediaId: "wordpress-attachment:900"
        },
        media: [{
          ...recipeFixture.media[0]!,
          id: "wordpress-attachment:900",
          sourceId: "900",
          path: mediaPath
        }, recipeFixture.media[1]]
      }),
      /managed media namespace|canonical WordPress recipe media key|valid URL encoding/
    );
  }

  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      media: [{
        ...recipeFixture.media[0]!,
        path: "/images/apple.png"
      }, {
        ...recipeFixture.media[1]!,
        path: "/images/%61pple.png"
      }]
    }),
    /Duplicate effective media path/
  );
});

test("recipe redirect sources reject duplicates and the canonical route", () => {
  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      redirectFrom: ["/old", "/old/"]
    }),
    /Duplicate recipe redirect source/
  );
  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      redirectFrom: ["/recipes/fixture-recipe/"]
    }),
    /canonical recipe route/
  );
});
