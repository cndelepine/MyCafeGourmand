import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { recipeFixture } from "./fixtures/recipe";
import { recipeCatalog } from "../src/content/catalog";
import { editorialCatalog } from "../src/content/editorial-catalog";
import { editorialPageRecordSchema } from "../src/content/editorial-schema";
import {
  createExactRedirectManifest,
  serializeExactRedirectManifest
} from "../src/content/redirect-manifest";
import { recipeRecordSchema } from "../src/content/schema";
import {
  createStaticWebAppConfig,
  maxStaticWebAppConfigBytes,
  serializeStaticWebAppConfig
} from "../src/content/staticwebapp";
import {
  cleanDeploymentMetadata,
  generateDeploymentArtifacts
} from "../scripts/generate-deployment-artifacts";
import { loadHandAuthoredStaticWebAppConfig } from "../scripts/staticwebapp-config";

function withTempDirectory<T>(callback: (directory: string) => T) {
  const directory = mkdtempSync(path.join(process.cwd(), ".staticwebapp-test-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function copyBuildInputs(projectRoot: string) {
  mkdirSync(projectRoot, { recursive: true });
  for (const directory of ["config", "content"]) {
    cpSync(path.join(process.cwd(), directory), path.join(projectRoot, directory), {
      recursive: true
    });
  }
}

test("generates deterministic provider-neutral redirects from recipe redirect sources", () => {
  const record = recipeRecordSchema.parse({
    ...recipeFixture,
    redirectFrom: ["/old/soup/", "/old/soup-2"]
  });
  const manifest = createExactRedirectManifest([record]);

  assert.deepEqual(manifest, {
    schemaVersion: 1,
    redirects: [
      {
        source: "/old/soup/",
        destination: "/recipes/fixture-recipe/",
        status: 301
      },
      {
        source: "/old/soup-2",
        destination: "/recipes/fixture-recipe/",
        status: 301
      }
    ]
  });
  assert.equal(
    serializeExactRedirectManifest(manifest),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
});

test("keeps exact redirects out of the Static Web Apps route table", () => {
  const record = recipeRecordSchema.parse({
    ...recipeFixture,
    redirectFrom: ["/old/soup/"]
  });

  assert.deepEqual(createStaticWebAppConfig([record]).routes, []);
});

test("uses trailing-slash canonical destinations for localized recipes", () => {
  const record = recipeRecordSchema.parse({
    ...recipeFixture,
    id: "test:recipe:fr",
    locale: "fr",
    slug: "soupe",
    source: {
      ...recipeFixture.source,
      recipeId: "2"
    },
    redirectFrom: ["/ancienne-soupe"]
  });

  assert.deepEqual(createExactRedirectManifest([record]).redirects, [
    {
      source: "/ancienne-soupe",
      destination: "/fr/recipes/soupe/",
      status: 301
    }
  ]);
});

test("preserves hand-authored Azure config", () => {
  const config = createStaticWebAppConfig([recipeFixture], {
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

test("committed Azure config uses bounded baseline headers and stages CSP", () => {
  const config = createStaticWebAppConfig([], {
    handAuthoredConfig: loadHandAuthoredStaticWebAppConfig(process.cwd())
  });

  assert.equal(config.trailingSlash, "always");
  assert.deepEqual(config.globalHeaders, {
    "Strict-Transport-Security": "max-age=31536000",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy":
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), " +
      "microphone=(), payment=(), usb=()"
  });
  assert.ok(
    config.globalHeaders !== null
    && typeof config.globalHeaders === "object"
    && !Array.isArray(config.globalHeaders)
  );
  const headerNames = Object.keys(config.globalHeaders).map((name) => name.toLowerCase());
  assert.equal(headerNames.includes("content-security-policy"), false);
  assert.equal(headerNames.includes("content-security-policy-report-only"), false);
  assert.ok(
    Buffer.byteLength(serializeStaticWebAppConfig(config), "utf8")
    <= maxStaticWebAppConfigBytes
  );
});

test("rejects Static Web Apps config larger than the documented bound", () => {
  assert.throws(
    () => serializeStaticWebAppConfig({
      routes: [],
      globalHeaders: {
        "X-Oversized": "é".repeat(maxStaticWebAppConfigBytes)
      }
    }),
    /maximum is 20000 bytes/u
  );
});

test("detects cycles between generated and exact hand-authored redirects", () => {
  const record = recipeRecordSchema.parse({
    ...recipeFixture,
    redirectFrom: ["/old-recipe"]
  });
  assert.throws(
    () => createStaticWebAppConfig([record], {
      handAuthoredConfig: {
        routes: [{
          route: "/recipes/fixture-recipe",
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
      ...recipeFixture,
      redirectFrom: ["/recipes/fixture-recipe/"]
    }),
    /canonical recipe route/
  );
  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
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
    ...recipeFixture,
    redirectFrom: ["/old/soup"]
  });
  const second = recipeRecordSchema.parse({
    ...recipeFixture,
    id: "test:recipe:other",
    slug: "other-soup",
    source: {
      ...recipeFixture.source,
      recipeId: "3"
    },
    redirectFrom: ["/old/soup/"]
  });

  assert.throws(
    () => createStaticWebAppConfig([first, second]),
    /redirect source conflict/
  );
});

test("exact redirects cannot shadow generated static assets", () => {
  for (const redirectFrom of [
    "/robots.txt",
    "/sitemap.xml",
    "/_search/en.json",
    "/staticwebapp.config.json"
  ]) {
    const record = recipeRecordSchema.parse({
      ...recipeFixture,
      redirectFrom: [redirectFrom]
    });
    assert.throws(
      () => createExactRedirectManifest([record]),
      /conflicts with a canonical route/u,
      redirectFrom
    );
    assert.throws(
      () => createStaticWebAppConfig([], {
        handAuthoredConfig: {
          routes: [{ route: redirectFrom, redirect: "/target/", statusCode: 301 }]
        }
      }),
      /conflicts with a canonical route/u,
      redirectFrom
    );
  }
});

test("isolates exact redirect metadata from the bounded Azure origin artifact", () => {
  withTempDirectory((directory) => {
    const projectRoot = path.join(directory, "project");
    const outputDirectory = path.join(projectRoot, "out");
    const metadataDirectory = path.join(projectRoot, ".deployment");
    const stagedDirectory = path.join(projectRoot, ".deployment.next");
    const previousDirectory = path.join(projectRoot, ".deployment.previous");
    copyBuildInputs(projectRoot);
    assert.equal(existsSync(path.join(projectRoot, "public")), false);
    mkdirSync(outputDirectory);
    writeFileSync(
      path.join(outputDirectory, "redirect-manifest.json"),
      "{\"legacy\":true}\n"
    );
    for (const staleDirectory of [
      metadataDirectory,
      stagedDirectory,
      previousDirectory
    ]) {
      mkdirSync(staleDirectory);
      writeFileSync(path.join(staleDirectory, "stale.json"), "{}\n");
    }
    const {
      redirectManifest,
      redirectManifestPath,
      staticWebAppConfig,
      staticWebAppConfigPath
    } = generateDeploymentArtifacts(projectRoot, outputDirectory);
    const expectedRedirects = recipeCatalog.reduce(
      (count, record) => count + record.redirectFrom.length,
      0
    ) + editorialCatalog.reduce(
      (count, record) => count + (record.redirectFrom?.length ?? 0),
      0
    );

    assert.equal(redirectManifest.redirects.length, expectedRedirects);
    assert.equal(
      readFileSync(redirectManifestPath, "utf8"),
      serializeExactRedirectManifest(redirectManifest)
    );
    assert.equal(
      readFileSync(staticWebAppConfigPath, "utf8"),
      serializeStaticWebAppConfig(staticWebAppConfig)
    );
    assert.equal(path.basename(redirectManifestPath), "redirect-manifest.json");
    assert.equal(path.dirname(redirectManifestPath), metadataDirectory);
    assert.equal(path.basename(staticWebAppConfigPath), "staticwebapp.config.json");
    assert.deepEqual(staticWebAppConfig.routes, []);
    assert.deepEqual(readdirSync(metadataDirectory), ["redirect-manifest.json"]);
    assert.equal(existsSync(stagedDirectory), false);
    assert.equal(existsSync(previousDirectory), false);
    assert.equal(
      existsSync(path.join(outputDirectory, "redirect-manifest.json")),
      false
    );
  });
});

test("cleans all deployment metadata before a new static build", () => {
  withTempDirectory((directory) => {
    for (const name of [
      ".deployment",
      ".deployment.next",
      ".deployment.previous"
    ]) {
      const candidate = path.join(directory, name);
      mkdirSync(candidate);
      writeFileSync(path.join(candidate, "stale.json"), "{}\n");
    }

    cleanDeploymentMetadata(directory);

    assert.equal(existsSync(path.join(directory, ".deployment")), false);
    assert.equal(existsSync(path.join(directory, ".deployment.next")), false);
    assert.equal(existsSync(path.join(directory, ".deployment.previous")), false);
  });
});

test("derives every content path from an alternate project root", () => {
  withTempDirectory((directory) => {
    const projectRoot = path.join(directory, "alternate-project");
    copyBuildInputs(projectRoot);
    const record = editorialPageRecordSchema.parse({
      schemaVersion: 1,
      kind: "editorial-page",
      id: "wordpress:page:999999",
      locale: "en",
      canonicalPath: "/alternate-root-only/",
      translationGroupId: null,
      source: {
        system: "wordpress",
        postId: 999999,
        sourcePath: "/alternate-root-only/",
        sourceSlug: "alternate-root-only",
        createdAt: null,
        modifiedAt: null
      },
      title: "Alternate root",
      excerpt: null,
      publishedAt: null,
      modifiedAt: null,
      content: null,
      featuredMediaId: null,
      featuredMediaAlt: null,
      media: null,
      redirectFrom: ["/old-alternate-root-only/"]
    });
    const editorialDirectory = path.join(projectRoot, "content", "editorial", "en");
    mkdirSync(editorialDirectory, { recursive: true });
    writeFileSync(
      path.join(editorialDirectory, "999999.json"),
      `${JSON.stringify(record, null, 2)}\n`
    );

    const { redirectManifest } = generateDeploymentArtifacts(
      projectRoot,
      path.join(projectRoot, "out")
    );
    assert.equal(
      redirectManifest.redirects.some((redirect) =>
        redirect.source === "/old-alternate-root-only/"
        && redirect.destination === "/alternate-root-only/"
      ),
      true
    );
  });
});
