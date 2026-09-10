import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse } from "parse5";
import {
  createExactRedirectManifest,
  parseExactRedirectManifest,
  type ExactRedirectManifest
} from "../src/content/redirect-manifest";
import { recipeCatalog } from "../src/content/catalog";
import { editorialCatalog } from "../src/content/editorial-catalog";
import { galleryCatalog } from "../src/content/gallery-catalog";
import {
  assertFreshLegacyOutput,
  generateLegacyNavigation,
  getLegacyPageOutputPath,
  renderLegacyPage,
  validateLegacyNavigationOutput
} from "../scripts/legacy-navigation";

function temporary<T>(operation: (root: string) => T) {
  const root = mkdtempSync(path.join(process.cwd(), ".legacy-navigation-test-"));
  try {
    return operation(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function manifest(...sources: string[]): ExactRedirectManifest {
  return {
    schemaVersion: 2,
    mechanism: "html-refresh",
    redirects: sources.map((source) => ({
      source,
      destination: "/recipes/example/"
    }))
  };
}

test("legacy metadata describes HTML navigation, never HTTP 301", () => {
  const valid = manifest("/old/");
  assert.deepEqual(parseExactRedirectManifest(valid), valid);
  for (const invalid of [
    { ...valid, schemaVersion: 1 },
    { ...valid, mechanism: "http-redirect" },
    { ...valid, approved: true },
    { ...valid, redirects: [{ ...valid.redirects[0], status: 301 }] },
    { ...valid, redirects: [{ source: "/old/", destination: "/new" }] },
    { ...valid, redirects: [{ source: "/old/", destination: "/%2f/" }] },
    { ...valid, redirects: [{ source: "/a/", destination: "/b/" }, { source: "/b/", destination: "/a/" }] }
  ]) {
    assert.throws(() => parseExactRedirectManifest(invalid));
  }
});

test("legacy paths decode UTF-8 once to portable output paths", () => {
  assert.equal(getLegacyPageOutputPath("/ru/%d1%81%d1%83%d0%bf/"), "ru/суп/index.html");
  assert.equal(getLegacyPageOutputPath("/ru/суп/"), "ru/суп/index.html");
  assert.equal(getLegacyPageOutputPath("/caf%C3%A9/"), "café/index.html");
  assert.equal(getLegacyPageOutputPath("/old"), "old/index.html");
});

test("unsupported and unsafe legacy source paths fail explicitly", () => {
  for (const source of [
    "/", "//evil/", "/a//b/", "/%2e%2e/", "/%252e%252e/", "/a%2fb/",
    "/%252f/", "/a%5cb/", "/bad%/", "/%FF/", "/%25/", "/%2561/",
    "/cafe\u0301/", "/a b/", "/CON/", "/a:/", "/x?y/", "/x#y/"
  ]) {
    assert.throws(() => getLegacyPageOutputPath(source), Error, source);
  }
});

test("legacy HTML refresh, canonical and fallback agree without JavaScript", () => {
  const html = renderLegacyPage({ source: "/old/", destination: "/fr/recipes/café-\"été\"/" });
  const document = parse(html);
  const htmlElement = document.childNodes.find((node) => node.nodeName === "html");
  assert.ok(htmlElement && "childNodes" in htmlElement);
  const head = htmlElement.childNodes.find((node) => node.nodeName === "head");
  assert.ok(head && "childNodes" in head);
  const refresh = head.childNodes.find((node) =>
    "attrs" in node && node.attrs.some((attr) => attr.name === "http-equiv" && attr.value === "refresh")
  );
  const canonical = head.childNodes.find((node) =>
    "attrs" in node && node.attrs.some((attr) => attr.name === "rel" && attr.value === "canonical")
  );
  assert.ok(refresh && "attrs" in refresh);
  assert.ok(canonical && "attrs" in canonical);
  const destination = "https://mycafegourmand.com/fr/recipes/caf%C3%A9-%22%C3%A9t%C3%A9%22/";
  assert.equal(refresh.attrs.find((attr) => attr.name === "content")?.value, `0;url=${destination}`);
  assert.equal(canonical.attrs.find((attr) => attr.name === "href")?.value, destination);
  assert.match(html, /<html lang="fr">/u);
  assert.ok(html.includes(`<a href="${destination}">`));
  assert.doesNotMatch(html, /<script|noindex|unsafe-inline/iu);
});

test("every published historical mapping generates and validates a static page", () => {
  temporary((root) => {
    const actual = createExactRedirectManifest(recipeCatalog, editorialCatalog, galleryCatalog);
    generateLegacyNavigation(actual, root);
    validateLegacyNavigationOutput(actual, root);
    for (const redirect of actual.redirects) {
      assert.equal(
        readFileSync(path.join(root, getLegacyPageOutputPath(redirect.source)), "utf8"),
        renderLegacyPage(redirect)
      );
    }
    assert.throws(() => assertFreshLegacyOutput(root), /fresh static build/u);
  });
});

test("legacy generation rejects portable collisions before writing pages", () => {
  for (const sources of [
    ["/Old/", "/old/"],
    ["/Top/one/", "/top/two/"],
    ["/one/", "/one/index.html/two/"]
  ]) {
    temporary((root) => {
      assert.throws(() => generateLegacyNavigation(manifest(...sources), root), /collision|conflict/u);
      assert.equal(existsSync(path.join(root, getLegacyPageOutputPath(sources[0]!))), false);
    });
  }
});

test("legacy generation never overwrites canonical files or conflicting assets", () => {
  temporary((root) => {
    mkdirSync(path.join(root, "old"));
    writeFileSync(path.join(root, "old/index.html"), "<p>Canonical</p>");
    assert.throws(() => generateLegacyNavigation(manifest("/old/"), root), /overwrite/u);
    assert.equal(readFileSync(path.join(root, "old/index.html"), "utf8"), "<p>Canonical</p>");
  });
  temporary((root) => {
    writeFileSync(path.join(root, "old"), "asset");
    assert.throws(() => generateLegacyNavigation(manifest("/old/"), root), /conflicts/u);
  });
  temporary((root) => {
    mkdirSync(path.join(root, "Old"));
    assert.throws(() => generateLegacyNavigation(manifest("/old/"), root), /conflicts/u);
  });
});

test("legacy output validation detects missing, modified and stale pages", () => {
  temporary((root) => {
    const current = manifest("/old/");
    assert.throws(() => validateLegacyNavigationOutput(current, root), /Missing/u);
    generateLegacyNavigation(current, root);
    assert.throws(() => validateLegacyNavigationOutput(manifest(), root), /Stale/u);
    writeFileSync(path.join(root, "old/index.html"), "<p>Changed</p>");
    assert.throws(() => validateLegacyNavigationOutput(current, root), /Modified/u);
  });
});

test("legacy output refuses symlinked roots and ancestors", { skip: process.platform === "win32" }, () => {
  temporary((root) => {
    const output = path.join(root, "out");
    const target = path.join(root, "target");
    mkdirSync(target);
    symlinkSync(target, output);
    assert.throws(() => generateLegacyNavigation(manifest("/old/"), output), /regular directory/u);
    rmSync(output);
    mkdirSync(output);
    symlinkSync(target, path.join(output, "old"));
    assert.throws(() => generateLegacyNavigation(manifest("/old/"), output), /regular files/u);
  });
});
