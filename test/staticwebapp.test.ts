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

test("generates deterministic Azure redirects from recipe legacy URLs", () => {
  const record = recipeRecordSchema.parse({
    ...meatballsSoup,
    legacyUrls: [
      { path: "/old/soup/", kind: "legacy-recipe" },
      { path: "/old/soup-2", kind: "root-recipe" }
    ]
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
    legacyUrls: [{ path: "/ancienne-soupe", kind: "legacy-recipe" }]
  });

  assert.deepEqual(createStaticWebAppConfig([record]).routes, [
    {
      route: "/ancienne-soupe",
      redirect: "/fr/recipes/soupe/",
      statusCode: 301
    }
  ]);
});

test("keeps explicit redirects and preserves hand-authored config", () => {
  const config = createStaticWebAppConfig([meatballsSoup], {
    explicitRedirects: [
      { source: "/old/page", destination: "/new/page", status: 301 }
    ],
    handAuthoredConfig: {
      globalHeaders: { "X-Content-Type-Options": "nosniff" },
      routes: [{ route: "/*", rewrite: "/index.html" }]
    }
  });

  assert.deepEqual(config, {
    globalHeaders: { "X-Content-Type-Options": "nosniff" },
    routes: [
      { route: "/old/page", redirect: "/new/page", statusCode: 301 },
      { route: "/*", rewrite: "/index.html" }
    ]
  });
});

test("detects cycles between generated and exact hand-authored redirects", () => {
  assert.throws(
    () => createStaticWebAppConfig([], {
      explicitRedirects: [
        { source: "/legacy", destination: "/target", status: 301 }
      ],
      handAuthoredConfig: {
        routes: [{ route: "/target", redirect: "/legacy", statusCode: 301 }]
      }
    }),
    /merged redirect loop detected/
  );
});

test("rejects wildcard hand-authored redirects that cannot be checked exactly", () => {
  assert.throws(
    () => createStaticWebAppConfig([], {
      handAuthoredConfig: {
        routes: [{ route: "/legacy/*", redirect: "/target", statusCode: 301 }]
      }
    }),
    /Cannot safely merge non-exact/
  );
});

test("rejects redirect conflicts and Azure-incompatible paths", () => {
  assert.throws(
    () => createStaticWebAppConfig([recipeRecordSchema.parse({
      ...meatballsSoup,
      legacyUrls: [{ path: "/recipes/meatballs-soup/", kind: "legacy-recipe" }]
    })]),
    /Self-redirect/
  );
  assert.throws(
    () => createStaticWebAppConfig([], {
      explicitRedirects: [
        { source: "/old?print=1", destination: "/new", status: 301 }
      ]
    }),
    /cannot contain a query/
  );
  assert.throws(
    () => createStaticWebAppConfig([], {
      explicitRedirects: [
        { source: "/old*", destination: "/new", status: 301 }
      ]
    }),
    /cannot contain a wildcard/
  );
  assert.throws(
    () => createStaticWebAppConfig([], {
      explicitRedirects: [
        { source: "/one", destination: "/two", status: 301 },
        { source: "/two", destination: "/one", status: 301 }
      ]
    }),
    /Redirect loop/
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
