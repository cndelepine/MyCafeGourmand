import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  compareDiscoveredPaths,
  installInventoryTempFile,
  inventorySitemaps,
  normalizeRecordUrl,
  parseSitemapDocument,
  runUrlInventory
} from "../scripts/inventory-urls";
import { recipeFixture } from "./fixtures/recipe";
import { recipeRecordSchema } from "../src/content/schema";

const fixtureRoot = path.resolve(process.cwd(), "test/fixtures/sitemaps");
const indexFixture = path.join(fixtureRoot, "index.xml");

function fixture(name: string) {
  return path.join(fixtureRoot, name);
}

function withTempDirectory<T>(callback: (directory: string) => Promise<T> | T) {
  const directory = mkdtempSync(path.join(process.cwd(), ".inventory-test-"));
  return Promise.resolve(callback(directory)).finally(() => {
    rmSync(directory, { force: true, recursive: true });
  });
}

test("parses namespaced sitemap indexes and urlsets without crawling record URLs", async () => {
  const output = await inventorySitemaps({
    sitemap: indexFixture,
    compare: false
  });

  assert.equal(output.discoveryOnly, true);
  assert.equal(output.rootSource.status, "parsed");
  assert.equal(output.urls.length, 4);
  assert.deepEqual(
    output.urls.map((entry) => entry.path),
    [
      "/%D1%81%D1%83%D0%BF/%D0%BC%D1%8F%D1%81%D0%BE/",
      "/Recipes/Meatballs-Soup/?source=archive&lang=en",
      "/fr/recettes/soupe/",
      "/ru/%D1%81%D1%83%D0%BF/"
    ]
  );
  const archivedRecipe = output.urls.find((entry) =>
    entry.path.startsWith("/Recipes/")
  );
  assert.ok(archivedRecipe);
  assert.deepEqual(archivedRecipe.imageUrls, [
    "https://images.example.test/meatballs.jpg"
  ]);
  assert.deepEqual(
    archivedRecipe.hreflangAlternates.map((alternate) => alternate.hreflang),
    ["fr", "ru"]
  );
  assert.equal(
    archivedRecipe.hreflangAlternates[1]?.path,
    "/ru/%D1%81%D1%83%D0%BF/"
  );
  assert.equal(
    output.urls.find((entry) => entry.path.startsWith("/fr/"))?.locale,
    "fr"
  );
  assert.equal(
    output.urls.find((entry) => entry.path.startsWith("/ru/"))?.locale,
    "ru"
  );
  assert.ok(output.errors.some((error) => error.code === "duplicate-sitemap"));
  assert.ok(output.errors.some((error) => error.code === "duplicate-url"));
  assert.ok(output.errors.some((error) => error.code === "off-domain-url"));
  assert.ok(output.errors.some((error) => error.message.includes("credentials")));
});

test("normalizes allowed record URLs without changing path case, encoding, query, or slash", () => {
  assert.deepEqual(
    normalizeRecordUrl(
      "http://MYCAFEGOURMAND.COM/Path/%D1%81%D1%83%D0%BF/?q=%D0%B4"
    ),
    {
      originalUrl: "http://MYCAFEGOURMAND.COM/Path/%D1%81%D1%83%D0%BF/?q=%D0%B4",
      normalizedUrl: "https://mycafegourmand.com/Path/%D1%81%D1%83%D0%BF/?q=%D0%B4",
      path: "/Path/%D1%81%D1%83%D0%BF/?q=%D0%B4",
      locale: "en"
    }
  );
  assert.throws(
    () => normalizeRecordUrl("https://other.example.test/no"),
    /outside the allowed/
  );
  assert.throws(
    () => normalizeRecordUrl("https://user:pass@mycafegourmand.com/bad"),
    /credentials/
  );
  assert.throws(
    () => normalizeRecordUrl("https://mycafegourmand.com/fragment#bad"),
    /credentials or a fragment/
  );
  assert.throws(
    () => normalizeRecordUrl("https://mycafegourmand.com/fragment#"),
    /credentials or a fragment/
  );
});

test("reports malformed XML and never follows a urlset loc as a document", async () => {
  const malformed = await inventorySitemaps({
    sitemap: fixture("malformed.xml"),
    compare: false
  });
  assert.ok(malformed.errors.some((error) => error.code === "malformed-xml"));
  const unexpected = await inventorySitemaps({
    sitemap: fixture("unexpected.xml"),
    compare: false
  });
  assert.ok(unexpected.errors.some((error) => error.code === "unexpected-root"));

  const documents: string[] = [];
  const output = await inventorySitemaps({
    sitemap: "https://mycafegourmand.com/sitemap.xml",
    compare: false,
    fetchDocument: async (source) => {
      documents.push(source);
      return `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://mycafegourmand.com/record/</loc></url></urlset>`;
    }
  });
  assert.deepEqual(documents, ["https://mycafegourmand.com/sitemap.xml"]);
  assert.equal(output.urls[0]?.path, "/record/");
});

test("detects sitemap cycles and enforces depth and document limits", async () => {
  const cycle = await inventorySitemaps({
    sitemap: fixture("cycle-a.xml"),
    compare: false
  });
  assert.ok(cycle.errors.some((error) => error.code === "sitemap-cycle"));

  const limited = await inventorySitemaps({
    sitemap: fixture("limit-index.xml"),
    compare: false,
    limits: {
      maxDepth: 1,
      maxDocuments: 2
    }
  });
  assert.ok(
    limited.errors.some((error) =>
      error.code === "sitemap-document-limit" || error.code === "sitemap-depth-limit"
    )
  );
  assert.ok(limited.childSitemapSources.every((source) => source.depth <= 1));
  assert.equal(
    cycle.childSitemapSources.find((source) => source.source.endsWith("cycle-a.xml"))?.status,
    "cycle"
  );
  assert.equal(
    (await inventorySitemaps({
      sitemap: indexFixture,
      compare: false
    })).childSitemapSources.some((source) =>
      source.source.endsWith("english.xml") && source.status === "duplicate"
    ),
    true
  );
});

test("rewrites original child sitemap URLs through an archived Wayback capture", async () => {
  const root =
    "https://web.archive.org/web/20240101000000id_/https://mycafegourmand.com/sitemap_index.xml";
  const child =
    "https://mycafegourmand.com/wp-sitemap-posts-post-1.xml";
  const archivedChild =
    `https://web.archive.org/web/20240101000000id_/${child}`;
  const requested: string[] = [];
  const output = await inventorySitemaps({
    sitemap: root,
    compare: false,
    fetchDocument: async (source) => {
      requested.push(source);
      if (source === root) {
        return `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${child}</loc></sitemap></sitemapindex>`;
      }
      if (source === archivedChild) {
        return `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://mycafegourmand.com/ru/%D1%81%D1%83%D0%BF/</loc></url></urlset>`;
      }
      throw new Error(`unexpected fetch: ${source}`);
    }
  });

  assert.deepEqual(requested, [root, archivedChild]);
  assert.equal(output.childSitemapSources[0]?.source, child);
  assert.equal(output.childSitemapSources[0]?.fetchSource, archivedChild);
  assert.equal(output.urls[0]?.originalUrl, "https://mycafegourmand.com/ru/%D1%81%D1%83%D0%BF/");
});

test("rewrites children through the effective redirected Wayback capture", async () => {
  const requestedRoot =
    "https://web.archive.org/web/20240101000000id_/https://mycafegourmand.com/sitemap_index.xml";
  const effectiveRoot =
    "https://web.archive.org/web/20240202000000id_/https://mycafegourmand.com/sitemap_index.xml";
  const child = "https://mycafegourmand.com/wp-sitemap-posts-post-1.xml";
  const effectiveChild =
    "https://web.archive.org/web/20240202000000id_/" + child;
  const requested: string[] = [];
  const output = await inventorySitemaps({
    sitemap: requestedRoot,
    compare: false,
    fetchDocument: async (source) => {
      requested.push(source);
      if (source === requestedRoot) {
        return {
          body: `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${child}</loc></sitemap></sitemapindex>`,
          finalSource: effectiveRoot
        };
      }
      assert.equal(source, effectiveChild);
      return {
        body: `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://mycafegourmand.com/redirected/</loc></url></urlset>`,
        finalSource: effectiveChild
      };
    }
  });

  assert.deepEqual(requested, [requestedRoot, effectiveChild]);
  assert.equal(output.rootSource.fetchSource, requestedRoot);
  assert.equal(output.rootSource.effectiveFetchSource, effectiveRoot);
  assert.equal(output.childSitemapSources[0]?.source, child);
  assert.equal(output.childSitemapSources[0]?.fetchSource, effectiveChild);
});

test("rejects off-domain sitemap children before fetching them", async () => {
  const requested: string[] = [];
  const output = await inventorySitemaps({
    sitemap: "https://mycafegourmand.com/sitemap.xml",
    compare: false,
    fetchDocument: async (source) => {
      requested.push(source);
      return `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://evil.example.test/private.xml</loc></sitemap></sitemapindex>`;
    }
  });

  assert.deepEqual(requested, ["https://mycafegourmand.com/sitemap.xml"]);
  assert.equal(output.childSitemapSources.length, 0);
  assert.ok(output.errors.some((error) =>
    error.code === "invalid-sitemap-source" && error.message.includes("outside the allowed")
  ));
});

test("rejects symlinked and escaping local sitemap children", async () => {
  await withTempDirectory(async (directory) => {
    const nested = path.join(directory, "nested");
    mkdirSync(nested);
    const root = path.join(nested, "root.xml");
    const safe = path.join(nested, "safe.xml");
    const linked = path.join(nested, "linked.xml");
    writeFileSync(root, `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>../escape.xml</loc></sitemap>
      <sitemap><loc>linked.xml</loc></sitemap>
    </sitemapindex>`);
    writeFileSync(safe, `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://mycafegourmand.com/safe/</loc></url></urlset>`);
    symlinkSync(safe, linked);

    const output = await inventorySitemaps({
      sitemap: root,
      compare: false
    });

    assert.equal(output.urls.length, 0);
    assert.equal(output.childSitemapSources.length, 0);
    assert.equal(output.errors.filter((error) => error.code === "invalid-sitemap-source").length, 2);
    await assert.rejects(inventorySitemaps({
      sitemap: linked,
      compare: false
    }), /symlinked local sitemap source/);
  });
});

test("streams remote response limits and aborts timed-out bodies", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let canceled = false;
    globalThis.fetch = (async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("1234"));
          controller.enqueue(new TextEncoder().encode("5678"));
        },
        cancel() {
          canceled = true;
        }
      })
    )) as typeof fetch;
    const oversized = await inventorySitemaps({
      sitemap: "https://mycafegourmand.com/oversized.xml",
      compare: false,
      limits: { maxDocumentBytes: 5 }
    });
    assert.equal(oversized.rootSource.status, "fetch-failed");
    assert.ok(oversized.errors.some((error) => error.message.includes("document limit")));
    assert.equal(canceled, true);

    let aborted = false;
    globalThis.fetch = (async (_input, init) => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            controller.error(new Error("aborted"));
          }, { once: true });
        }
      })
    )) as typeof fetch;
    const timedOut = await inventorySitemaps({
      sitemap: "https://mycafegourmand.com/slow.xml",
      compare: false,
      limits: { requestTimeoutMs: 20 }
    });
    assert.equal(timedOut.rootSource.status, "fetch-failed");
    assert.ok(timedOut.errors.some((error) => error.message.includes("timed out")));
    assert.equal(aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reads local and remote gzip sitemap documents", async () => {
  const xml =
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    "<url><loc>https://mycafegourmand.com/gzip/</loc></url></urlset>";
  await withTempDirectory(async (directory) => {
    const localSource = path.join(directory, "sitemap.xml.gz");
    writeFileSync(localSource, gzipSync(xml));
    const local = await inventorySitemaps({
      sitemap: localSource,
      compare: false
    });
    assert.equal(local.rootSource.status, "parsed");
    assert.equal(local.urls[0]?.path, "/gzip/");
  });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(gzipSync(xml), {
      headers: { "content-type": "application/gzip" }
    })) as typeof fetch;
    const remote = await inventorySitemaps({
      sitemap: "https://mycafegourmand.com/sitemap.xml.gz",
      compare: false
    });
    assert.equal(remote.rootSource.status, "parsed");
    assert.equal(remote.urls[0]?.path, "/gzip/");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("applies maxDocumentBytes to decompressed gzip content", async () => {
  const xml =
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    `<url><loc>https://mycafegourmand.com/gzip-limit/</loc></url>` +
    `<description>${"x".repeat(10_000)}</description></urlset>`;
  const compressed = gzipSync(xml);
  assert.ok(compressed.byteLength < 1_000);

  await withTempDirectory(async (directory) => {
    const localSource = path.join(directory, "sitemap.xml.gz");
    writeFileSync(localSource, compressed);
    const local = await inventorySitemaps({
      sitemap: localSource,
      compare: false,
      limits: { maxDocumentBytes: 1_000 }
    });
    assert.equal(local.rootSource.status, "fetch-failed");
    assert.ok(local.errors.some((error) => error.message.includes("decompressed document limit")));
  });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(compressed)) as typeof fetch;
    const remote = await inventorySitemaps({
      sitemap: "https://mycafegourmand.com/sitemap.xml.gz",
      compare: false,
      limits: { maxDocumentBytes: 1_000 }
    });
    assert.equal(remote.rootSource.status, "fetch-failed");
    assert.ok(remote.errors.some((error) => error.message.includes("decompressed document limit")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects redirect targets outside the remote scope", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  try {
    globalThis.fetch = (async (input) => {
      requested.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private.xml" }
      });
    }) as typeof fetch;
    const output = await inventorySitemaps({
      sitemap: "https://mycafegourmand.com/redirect.xml",
      compare: false
    });
    assert.deepEqual(requested, ["https://mycafegourmand.com/redirect.xml"]);
    assert.equal(output.rootSource.status, "fetch-failed");
    assert.ok(output.errors.some((error) => error.message.includes("loopback or private")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("comparison is deterministic and does not create redirects", () => {
  const catalogRecord = recipeRecordSchema.parse({
    ...recipeFixture,
    redirectFrom: ["/old/soup/"]
  });
  const comparison = compareDiscoveredPaths(
    [
      { path: "/new/path/" },
      { path: "/old/soup/" },
      { path: "/recipes/fixture-recipe" }
    ],
    [catalogRecord]
  );

  assert.deepEqual(comparison.entries, [
    { path: "/new/path/", status: "discovered-only" },
    { path: "/old/soup/", status: "redirect-covered" },
    { path: "/recipes/fixture-recipe", status: "current-covered" }
  ]);
  assert.deepEqual(comparison.discoveredOnly, ["/new/path/"]);
  assert.deepEqual(comparison.redirectCovered, ["/old/soup/"]);
  assert.deepEqual(comparison.knownRedirectPaths, ["/old/soup/"]);
});

test("comparison equates non-root trailing slashes but keeps raw queries distinct", () => {
  const catalogRecord = recipeRecordSchema.parse({
    ...recipeFixture,
    redirectFrom: ["/old/path"]
  });
  const comparison = compareDiscoveredPaths(
    ["/recipes/fixture-recipe/", "/fr/", "/fr/?lang=fr", "/old/path/", "/old/path?source=archive"],
    [catalogRecord]
  );

  assert.deepEqual(comparison.entries, [
    { path: "/fr/", status: "current-covered" },
    { path: "/fr/?lang=fr", status: "discovered-only" },
    { path: "/old/path/", status: "redirect-covered" },
    { path: "/old/path?source=archive", status: "discovered-only" },
    { path: "/recipes/fixture-recipe/", status: "current-covered" }
  ]);
});

test("write mode checks safety and overwrite conflicts before fetching", async () => {
  await withTempDirectory(async (directory) => {
    const outputPath = path.join(directory, "inventory.json");
    let fetches = 0;
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      await runUrlInventory([
        "--sitemap",
        indexFixture,
        "--write",
        "--output",
        outputPath
      ]);
      assert.equal(existsSync(outputPath), true);
      const before = readFileSync(outputPath, "utf8");

      await assert.rejects(
        runUrlInventory([
          "--sitemap",
          "https://mycafegourmand.com/no-network.xml",
          "--write",
          "--output",
          outputPath
        ]),
        /already exists/
      );
      assert.equal(readFileSync(outputPath, "utf8"), before);

      const victimPath = path.join(directory, "victim.txt");
      const symlinkOutput = path.join(directory, "symlink-output.json");
      writeFileSync(victimPath, "do not replace");
      symlinkSync(victimPath, symlinkOutput);
      await assert.rejects(
        runUrlInventory([
          "--sitemap",
          indexFixture,
          "--write",
          "--overwrite",
          "--output",
          symlinkOutput
        ]),
        /symbolic link/
      );
      assert.equal(readFileSync(victimPath, "utf8"), "do not replace");
      assert.equal(readlinkSync(symlinkOutput), victimPath);

      const protectedPath = path.resolve(process.cwd(), "public/inventory.json");
      await assert.rejects(
        runUrlInventory([
          "--sitemap",
          "https://mycafegourmand.com/no-network.xml",
          "--write",
          "--output",
          protectedPath
        ]),
        /under public/
      );
      const linkedDirectory = path.join(directory, "linked-output");
      symlinkSync(path.resolve(process.cwd(), "public"), linkedDirectory);
      await assert.rejects(
        runUrlInventory([
          "--sitemap",
          "https://mycafegourmand.com/no-network.xml",
          "--write",
          "--output",
          path.join(linkedDirectory, "inventory.json")
        ]),
        /directory symlink/
      );

      const noCrawl = await inventorySitemaps({
        sitemap: "https://mycafegourmand.com/no-network.xml",
        compare: false,
        fetchDocument: async () => {
          fetches += 1;
          return `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://mycafegourmand.com/safe/</loc></url></urlset>`;
        }
      });
      assert.equal(noCrawl.urls.length, 1);
      assert.equal(fetches, 1);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });
});

test("non-overwrite temp installation fails without replacing a raced target", async () => {
  await withTempDirectory(async (directory) => {
    const targetPath = path.join(directory, "inventory.json");
    const temporaryPath = path.join(directory, ".inventory.json.tmp");
    writeFileSync(targetPath, "original");
    writeFileSync(temporaryPath, "replacement");

    await assert.rejects(
      installInventoryTempFile(temporaryPath, targetPath, false),
      (error: unknown) =>
        error instanceof Error
        && "code" in error
        && error.code === "EEXIST"
    );
    assert.equal(readFileSync(targetPath, "utf8"), "original");
    assert.equal(readFileSync(temporaryPath, "utf8"), "replacement");

    rmSync(targetPath);
    await installInventoryTempFile(temporaryPath, targetPath, false);
    assert.equal(readFileSync(targetPath, "utf8"), "replacement");
    assert.equal(existsSync(temporaryPath), false);

    const overwriteTemporaryPath = path.join(directory, ".inventory.json.overwrite.tmp");
    writeFileSync(overwriteTemporaryPath, "overwritten");
    await installInventoryTempFile(overwriteTemporaryPath, targetPath, true);
    assert.equal(readFileSync(targetPath, "utf8"), "overwritten");
  });
});

test("parseSitemapDocument exposes malformed fixtures rather than silently omitting them", () => {
  assert.throws(
    () => parseSitemapDocument(readFileSync(fixture("malformed.xml"), "utf8"), fixture("malformed.xml")),
    /Malformed XML/
  );
});
