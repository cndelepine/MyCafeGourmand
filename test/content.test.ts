import assert from "node:assert/strict";
import test from "node:test";
import { validateCatalog } from "../src/content/catalog";
import { meatballsSoup } from "../src/content/recipes/meatballs-soup";
import { validateRedirects } from "../src/content/redirects";
import { recipeRecordSchema } from "../src/content/schema";

test("the production catalog passes the canonical schema", () => {
  const [record] = validateCatalog();

  assert.equal(record.id, "wordpress:wprm:2980");
  assert.equal(record.locale, "en");
  assert.equal(record.translationGroupId, null);
});

test("missing translations remain missing", () => {
  const catalog = validateCatalog([meatballsSoup]);

  assert.deepEqual(catalog.map((record) => record.locale), ["en"]);
});

test("the schema rejects dangling media references", () => {
  const invalid = {
    ...meatballsSoup,
    recipe: {
      ...meatballsSoup.recipe,
      heroMediaId: "missing"
    }
  };

  assert.throws(() => recipeRecordSchema.parse(invalid), /Unknown media reference/);
});

test("the catalog rejects duplicate localized slugs", () => {
  const duplicate = {
    ...meatballsSoup,
    id: "wordpress:wprm:9999",
    source: {
      ...meatballsSoup.source,
      recipeId: "9999"
    }
  };

  assert.throws(
    () => validateCatalog([meatballsSoup, duplicate]),
    /Duplicate localized slug/
  );
});

test("redirect validation rejects duplicate sources and loops", () => {
  assert.throws(
    () => validateRedirects([
      { source: "/old", destination: "/new", status: 301 },
      { source: "/old", destination: "/newer", status: 301 }
    ]),
    /Duplicate redirect source/
  );

  assert.throws(
    () => validateRedirects([
      { source: "/one", destination: "/two", status: 301 },
      { source: "/two", destination: "/one", status: 301 }
    ]),
    /Redirect loop/
  );
});

test("redirect validation accounts for trailing-slash normalization", () => {
  assert.throws(
    () => validateRedirects([
      { source: "/legacy", destination: "/legacy/", status: 301 }
    ]),
    /Self-redirect/
  );

  assert.throws(
    () => validateRedirects([
      { source: "/one/", destination: "/two", status: 301 },
      { source: "/two/", destination: "/one", status: 301 }
    ]),
    /Redirect loop/
  );
});

test("redirect validation detects pathname-equivalent query and fragment loops", () => {
  assert.throws(
    () => validateRedirects([
      { source: "/legacy", destination: "/legacy?print=1", status: 301 }
    ]),
    /Self-redirect/
  );

  assert.throws(
    () => validateRedirects([
      { source: "/legacy/", destination: "/legacy/#print", status: 301 }
    ]),
    /Self-redirect/
  );
});

test("redirect validation preserves percent-encoded Cyrillic paths", () => {
  const source = "/ru/recipe/%D1%81%D1%83%D0%BF/";
  const [redirect] = validateRedirects([
    { source, destination: "/ru/recipes/soup/", status: 301 }
  ]);

  assert.equal(redirect.source, source);
});
