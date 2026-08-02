import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { recipeCatalog } from "../src/content/catalog";
import { recipeRecordSchema } from "../src/content/schema";
import {
  createStaticWebAppConfig,
  serializeStaticWebAppConfig
} from "../src/content/staticwebapp";
import { generateStaticWebAppConfig } from "../scripts/generate-staticwebapp";

const meatballsSoup = recipeCatalog[0]!;

function withTempDirectory<T>(callback: (directory: string) => T) {
  const directory = mkdtempSync(path.join(process.cwd(), ".staticwebapp-test-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("generates deterministic Azure redirects from recipe redirect sources", () => {
  const record = recipeRecordSchema.parse({
    ...meatballsSoup,
    redirectFrom: ["/old/soup/", "/old/soup-2"]
  });
  const config = createStaticWebAppConfig([record]);

  assert.deepEqual(config.routes, [
    {
      route: "/old/soup/",
      redirect: "/recipes/meatballs-soup/",
      statusCode: 301
    },
    {
      route: "/old/soup-2",
      redirect: "/recipes/meatballs-soup/",
      statusCode: 301
    }
  ]);
  assert.equal(
    serializeStaticWebAppConfig(config),
    `${JSON.stringify(config, null, 2)}\n`
  );
});

test("uses trailing-slash canonical destinations for localized recipes", () => {
  const record = recipeRecordSchema.parse({
    ...meatballsSoup,
    id: "wordpress:wprm:2981",
    locale: "fr",
    slug: "soupe",
    source: {
      ...meatballsSoup.source,
      recipeId: "2981"
    },
    redirectFrom: ["/ancienne-soupe"]
  });

  assert.deepEqual(createStaticWebAppConfig([record]).routes, [
    {
      route: "/ancienne-soupe",
      redirect: "/fr/recipes/soupe/",
      statusCode: 301
    }
  ]);
});

test("preserves hand-authored Azure config", () => {
  const config = createStaticWebAppConfig([meatballsSoup], {
    handAuthoredConfig: {
      globalHeaders: { "X-Content-Type-Options": "nosniff" },
      routes: [{ route: "/*", rewrite: "/index.html" }]
    }
  });

  assert.deepEqual(config, {
    globalHeaders: { "X-Content-Type-Options": "nosniff" },
    routes: [{ route: "/*", rewrite: "/index.html" }]
  });
});

test("detects cycles between generated and exact hand-authored redirects", () => {
  const record = recipeRecordSchema.parse({
    ...meatballsSoup,
    redirectFrom: ["/old-recipe"]
  });
  assert.throws(
    () => createStaticWebAppConfig([record], {
      handAuthoredConfig: {
        routes: [{
          route: "/recipes/meatballs-soup",
          redirect: "/old-recipe",
          statusCode: 301
        }]
      }
    }),
    /merged redirect loop detected/
  );
});

test("rejects wildcard hand-authored redirects that cannot be checked exactly", () => {
  for (const route of ["/old-recipe/*", "/old-recipe/%2a", "/old-recipe/%252a"]) {
    assert.throws(
      () => createStaticWebAppConfig([], {
        handAuthoredConfig: {
          routes: [{ route, redirect: "/target", statusCode: 301 }]
        }
      }),
      /Cannot safely merge non-exact/
    );
  }
});

test("rejects encoded traversal and malformed exact hand-authored redirect sources", () => {
  for (const route of [
    "/%2e%2e/private",
    "/%252e%252e/private",
    "/%25252e%25252e/private",
    "/%2fprivate",
    "/%252fprivate",
    "/safe%2fprivate",
    "/safe%252fprivate",
    "/%5cprivate",
    "/malformed%"
  ]) {
    assert.throws(
      () => createStaticWebAppConfig([], {
        handAuthoredConfig: {
          routes: [{ route, redirect: "/target", statusCode: 301 }]
        }
      }),
      /unsafe|traversal|URL encoding/
    );
  }
});

test("preserves valid encoded Unicode in exact hand-authored redirect sources", () => {
  const route = "/ru/%D1%81%D1%83%D0%BF";
  const config = createStaticWebAppConfig([], {
    handAuthoredConfig: {
      routes: [{ route, redirect: "/target", statusCode: 301 }]
    }
  });

  assert.deepEqual(config.routes, [
    { route, redirect: "/target", statusCode: 301 }
  ]);
});

test("accepts a terminal literal percent in an exact hand-authored path", () => {
  const config = createStaticWebAppConfig([], {
    handAuthoredConfig: {
      routes: [{ route: "/recipe%25", redirect: "/target", statusCode: 301 }]
    }
  });

  assert.deepEqual(config.routes, [
    { route: "/recipe%25", redirect: "/target", statusCode: 301 }
  ]);
});

test("rejects redirect conflicts and Azure-incompatible paths", () => {
  assert.throws(
    () => recipeRecordSchema.parse({
      ...meatballsSoup,
      redirectFrom: ["/recipes/meatballs-soup/"]
    }),
    /canonical recipe route/
  );
  assert.throws(
    () => recipeRecordSchema.parse({
      ...meatballsSoup,
      redirectFrom: ["/old?print=1"]
    }),
    /cannot contain a query/
  );
  assert.throws(
    () => createStaticWebAppConfig([], {
      handAuthoredConfig: {
        routes: [
          { route: "/one", redirect: "/two", statusCode: 301 },
          { route: "/two", redirect: "/one", statusCode: 301 }
        ]
      }
    }),
    /merged redirect loop/
  );
});

test("rejects duplicate generated redirect sources across recipes", () => {
  const first = recipeRecordSchema.parse({
    ...meatballsSoup,
    redirectFrom: ["/old/soup"]
  });
  const second = recipeRecordSchema.parse({
    ...meatballsSoup,
    id: "wordpress:wprm:2981",
    slug: "other-soup",
    source: {
      ...meatballsSoup.source,
      recipeId: "2981"
    },
    redirectFrom: ["/old/soup/"]
  });

  assert.throws(
    () => createStaticWebAppConfig([first, second]),
    /redirect source conflict/
  );
});

test("emits the validated artifact into the static export directory", () => {
  withTempDirectory((directory) => {
    const outputDirectory = path.join(directory, "out");
    const { outputPath, config } = generateStaticWebAppConfig(process.cwd(), outputDirectory);

    assert.equal(readFileSync(outputPath, "utf8"), serializeStaticWebAppConfig(config));
    assert.equal(path.basename(outputPath), "staticwebapp.config.json");
  });
});
