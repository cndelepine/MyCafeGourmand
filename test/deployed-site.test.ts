import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { prepareStagingArtifact } from "../scripts/release-artifact";
import {
  validateAcceptanceReceipt, validateSiteOrigin, verifyDeployedSite, verifyProductionOrigin, wirePath,
  type SiteResponse, type SiteTransport
} from "../scripts/verify-deployed-site";
import { releaseFixture } from "./release-artifact-fixture";

const preview = "calm-tree-123456789-staging.westeurope.2.azurestaticapps.net";
const previewOrigin = `https://${preview}`;
const productionOrigin = "https://mycafegourmand.com";

function transport(root: string, staging: boolean, mutate?: (target: string, response: SiteResponse) => SiteResponse): SiteTransport {
  return async (_origin, target, maximum) => {
    const relative = decodeURIComponent(target).slice(1);
    const pagePath = relative.endsWith("/") || !relative
      ? `${relative}index.html`
      : path.extname(relative) ? relative : `${relative}/index.html`;
    const body = readFileSync(path.join(root, "out", pagePath));
    assert.ok(body.length < maximum);
    const response: SiteResponse = {
      status: 200, body, headers: {
        "x-content-type-options": "nosniff",
        "content-type": target.endsWith(".js") ? "text/javascript"
          : target.endsWith(".css") ? "text/css" : "text/html; charset=utf-8",
        ...(staging ? { "x-robots-tag": "noindex", "content-security-policy": "form-action 'none'" } : {})
      }
    };
    return mutate ? mutate(target, response) : response;
  };
}

test("HTTPS origins are bounded to canonical production and generated Azure staging", () => {
  assert.equal(validateSiteOrigin(productionOrigin, "production"), productionOrigin);
  assert.equal(validateSiteOrigin(previewOrigin, "staging"), previewOrigin);
  for (const invalid of [
    "http://mycafegourmand.com", "https://mycafegourmand.com/", "https://localhost",
    "https://127.0.0.1", "https://user:pass@example.azurestaticapps.net",
    "https://example.azurestaticapps.net:444", "https://example.azurestaticapps.net.evil.test",
    "https://example.azurestaticapps.net/path"
  ]) {
    assert.throws(() => validateSiteOrigin(invalid, "staging"));
  }
  assert.throws(() => validateSiteOrigin(previewOrigin, "production"));
  assert.throws(() => validateSiteOrigin(productionOrigin, "staging"));
});

test("wire paths preserve original percent hex case and encode raw Unicode exactly once", () => {
  assert.equal(wirePath("/ru/%d0%ba%d0%be%d1%82/"), "/ru/%d0%ba%d0%be%d1%82/");
  assert.equal(wirePath("/ru/кот/"), "/ru/%D0%BA%D0%BE%D1%82/");
  assert.equal(wirePath("/fr/café/"), "/fr/caf%C3%A9/");
  assert.throws(() => wirePath("/%2fetc/"));
  assert.throws(() => wirePath("/../private"));
});

test("live acceptance verifies all retained bytes and all source spellings without network access", async () => {
  const fixture = releaseFixture();
  try {
    const requests: string[] = [];
    const fake = transport(fixture.root, false, (target, response) => {
      requests.push(target);
      return response;
    });
    const receipt = await verifyDeployedSite(fixture.root, "production", productionOrigin, fake);
    assert.equal(receipt.checkedLegacySources, 3);
    assert.ok(receipt.checkedFiles >= 10);
    assert.ok(requests.includes("/archive/"));
    assert.ok(!requests.some((requested) => requested.includes("/contact/")));
    assert.ok(requests.includes("/ru/%d0%ba%d0%be%d1%82/"));
    assert.ok(requests.includes("/fr/caf%C3%A9/"));
    const receiptFile = ".deployment/production-acceptance.json";
    writeFileSync(path.join(fixture.root, receiptFile), JSON.stringify(receipt));
    assert.equal(validateAcceptanceReceipt(fixture.root, receiptFile, "production", productionOrigin).artifactDigest, receipt.artifactDigest);
    writeFileSync(path.join(fixture.root, receiptFile), JSON.stringify({ ...receipt, artifactDigest: "a".repeat(64) }));
    assert.throws(() => validateAcceptanceReceipt(fixture.root, receiptFile, "production", productionOrigin), /not bound/u);
  } finally {
    fixture.cleanup();
  }
});

test("contact-free artifacts retain generic noindex and complete file checks", async () => {
  const fixture = releaseFixture();
  try {
    await verifyDeployedSite(fixture.root, "production", productionOrigin,
      transport(fixture.root, false, (target, response) => target === "/archive/"
        ? { ...response, headers: { ...response.headers, "x-robots-tag": "noindex" } }
        : response));
    await assert.rejects(verifyDeployedSite(fixture.root, "production", productionOrigin,
      transport(fixture.root, false, (target, response) => target === "/archive/"
        ? { ...response, status: 404 }
        : response)), /acceptance failed/u);
    await assert.rejects(verifyDeployedSite(fixture.root, "production", productionOrigin,
      transport(fixture.root, false, (target, response) => target === "/archive/"
        ? { ...response, body: Buffer.from("<p>No longer noindex</p>") }
        : response)), /acceptance failed/u);
  } finally {
    fixture.cleanup();
  }
});
test("staging checks noindex and browser submission blocking without modifying content", async () => {
  const fixture = releaseFixture();
  try {
    const stage = path.join(fixture.base, "staging");
    prepareStagingArtifact(fixture.root, stage);
    const result = await verifyDeployedSite(stage, "staging", previewOrigin, transport(stage, true));
    assert.equal(result.variant, "staging");
    await assert.rejects(verifyDeployedSite(stage, "staging", previewOrigin, transport(stage, false)), /acceptance failed/u);
    await assert.rejects(verifyDeployedSite(stage, "staging", previewOrigin, transport(stage, true, (_target, response) => ({
      ...response, headers: { "x-robots-tag": "noindex" }
    }))), /acceptance failed/u);
  } finally {
    fixture.cleanup();
  }
});

test("production rejects staging policy, wrong bytes, status failures, and cross-origin redirects", async () => {
  const fixture = releaseFixture();
  try {
    await assert.rejects(verifyDeployedSite(fixture.root, "production", productionOrigin, transport(fixture.root, true)), /acceptance failed/u);
    await assert.rejects(verifyDeployedSite(fixture.root, "production", productionOrigin, transport(fixture.root, false, (target, response) =>
      target === "/old/" ? { ...response, body: Buffer.from("wrong refresh page") } : response)), /acceptance failed/u);
    await assert.rejects(verifyDeployedSite(fixture.root, "production", productionOrigin, transport(fixture.root, false, (target, response) =>
      target === "/old/" ? { ...response, status: 404 } : response)), /acceptance failed/u);
    await assert.rejects(verifyDeployedSite(fixture.root, "production", productionOrigin, transport(fixture.root, false, (target, response) =>
      target === "/old/" ? { ...response, headers: { "content-type": "text/plain" } } : response)), /acceptance failed/u);
    await assert.rejects(verifyDeployedSite(fixture.root, "production", productionOrigin, transport(fixture.root, false, (target, response) =>
      target === "/old/" ? { ...response, status: 301, headers: { location: "https://evil.test/old" } } : response)), /acceptance failed/u);
  } finally {
    fixture.cleanup();
  }
});

test("live acceptance bounds parallel requests and fails on transport errors", async () => {
  const fixture = releaseFixture();
  try {
    let active = 0;
    let maximumActive = 0;
    const base = transport(fixture.root, false);
    const fake: SiteTransport = async (origin, target, maximum) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      try {
        return await base(origin, target, maximum);
      } finally {
        active--;
      }
    };
    await verifyDeployedSite(fixture.root, "production", productionOrigin, fake);
    assert.equal(maximumActive, 6);
    await assert.rejects(verifyDeployedSite(fixture.root, "production", productionOrigin,
      async () => { throw new Error("connection failed"); }), /acceptance failed/u);
  } finally {
    fixture.cleanup();
  }
});

test("only a slashless historical source may normalize to its trailing-slash page", async () => {
  const fixture = releaseFixture();
  try {
    const base = transport(fixture.root, false);
    const fake: SiteTransport = async (origin, target, maximum) => {
      if (target === "/old") return { status: 301, headers: { location: "/old/" }, body: Buffer.alloc(0) };
      return base(origin, target, maximum);
    };
    await verifyDeployedSite(fixture.root, "production", productionOrigin, fake);
    await assert.rejects(verifyDeployedSite(fixture.root, "production", productionOrigin,
      async () => ({ status: 301, headers: { location: "/other/" }, body: Buffer.alloc(0) })), /acceptance failed/u);
  } finally {
    fixture.cleanup();
  }
});

test("canonical slash removal and wrong script or stylesheet MIME fail acceptance", async () => {
  const fixture = releaseFixture();
  try {
    const base = transport(fixture.root, false);
    await assert.rejects(verifyDeployedSite(fixture.root, "production", productionOrigin,
      async (origin, target, maximum) => target === "/recipes/new/"
        ? { status: 302, headers: { location: "/recipes/new" }, body: Buffer.alloc(0) }
        : base(origin, target, maximum)), /acceptance failed/u);
    for (const target of ["/app.js", "/style.css"]) {
      await assert.rejects(verifyDeployedSite(fixture.root, "production", productionOrigin,
        transport(fixture.root, false, (requested, response) => requested === target
          ? { ...response, headers: { ...response.headers, "content-type": "text/plain" } }
          : response)), /acceptance failed/u);
    }
  } finally {
    fixture.cleanup();
  }
});

test("live acceptance requires the reviewed baseline response headers", async () => {
  const fixture = releaseFixture();
  try {
    await assert.rejects(verifyDeployedSite(fixture.root, "production", productionOrigin,
      transport(fixture.root, false, (_target, response) => ({
        ...response,
        headers: { ...response.headers, "x-content-type-options": undefined }
      }))), /acceptance failed/u);
  } finally {
    fixture.cleanup();
  }
});

test("direct production origin readiness cannot substitute for canonical acceptance", async () => {
  const fixture = releaseFixture();
  try {
    const origin = "https://calm-tree-123456789.2.azurestaticapps.net";
    const report = await verifyProductionOrigin(fixture.root, origin, transport(fixture.root, false));
    assert.equal(report.kind, "production-origin-readiness");
    const receiptFile = ".deployment/production-acceptance.json";
    writeFileSync(path.join(fixture.root, receiptFile), JSON.stringify(report));
    assert.throws(() => validateAcceptanceReceipt(fixture.root, receiptFile, "production", productionOrigin));
    await assert.rejects(verifyProductionOrigin(fixture.root, productionOrigin, transport(fixture.root, false)));
  } finally {
    fixture.cleanup();
  }
});
