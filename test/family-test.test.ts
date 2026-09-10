import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { familyTestPublicPages } from "../src/lib/family-test-routes";
import { assertRecipeMediaBuildEnvironment } from "../src/lib/recipe-media";
import {
  familyTestConfig, validateFamilyTestArtifact, writeFamilyTestArtifact, familyMetadataPath
} from "../scripts/family-test-artifact";
import { createFamilyTestBuildEnvironment, createReleaseBuildEnvironment } from "../scripts/build-static";
import { renderLegacyPage } from "../scripts/legacy-navigation";
import { prepareStagingArtifact, validateReleaseArtifact, writeReleaseArtifactMetadata } from "../scripts/release-artifact";
import { validateAcceptanceReceipt, wirePath, type SiteResponse, type SiteTransport } from "../scripts/verify-deployed-site";
import { familySessionTransport, readFamilyCookie, verifyFamilyTest } from "../scripts/verify-family-test";
import { buildFamilyBootstrap } from "../scripts/build-family-test";
import { releaseFixture } from "./release-artifact-fixture";

const origin = "https://family-test-fixture.azurestaticapps.net";
const media = "https://fixture.blob.core.windows.net/media";

function fixture() {
  const result = releaseFixture(false);
  writeFamilyTestArtifact(result.root, origin, media);
  return result;
}

function fakeTransport(
  root: string, context: "anonymous" | "nonmember" | "member",
  mutate?: (target: string, response: SiteResponse) => SiteResponse
): SiteTransport {
  const configuredHeaders = z.object({ globalHeaders: z.record(z.string(), z.string()) }).parse(
    JSON.parse(readFileSync(path.join(root, "out/staticwebapp.config.json"), "utf8"))
  ).globalHeaders;
  const headers = Object.fromEntries(Object.entries(configuredHeaders).map(([key, value]) => [key.toLowerCase(), value]));
  return async (requestedOrigin, target) => {
    assert.equal(requestedOrigin, origin);
    let response: SiteResponse;
    if (target === "/.auth/me") {
      response = { status: 200, headers: {}, body: Buffer.from(JSON.stringify({
        clientPrincipal: context === "anonymous" ? null : {
          userId: `sanitized-${context}`, identityProvider: "aad",
          userRoles: context === "member" ? ["anonymous", "authenticated", "family"] : ["anonymous", "authenticated"]
        }
      })) };
    } else if (!familyTestPublicPages.some((route) => route === target) && context !== "member") {
      response = {
        status: context === "anonymous" ? 302 : 403,
        headers: context === "anonymous" ? { location: familyTestPublicPages[0] } : headers,
        body: context === "anonymous" ? Buffer.alloc(0) : readFileSync(path.join(root, "out", familyTestPublicPages[1]))
      };
    } else {
      const file = decodeURIComponent(target).slice(1);
      const relative = !file || file.endsWith("/") ? `${file}index.html`
        : path.extname(file) ? file : `${file}/index.html`;
      response = {
        status: 200, body: readFileSync(path.join(root, "out", relative)),
        headers: {
          ...headers,
          "content-type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html"
        }
      };
    }
    return mutate ? mutate(target, response) : response;
  };
}

test("family access uses one final all-method custom-role gate and no fallback", () => {
  const config = JSON.parse(familyTestConfig(JSON.stringify({
    trailingSlash: "always", routes: [], globalHeaders: { "X-Content-Type-Options": "nosniff" }
  })));
  assert.deepEqual(config.routes, [
    ...familyTestPublicPages.map((route) => ({ route, allowedRoles: ["anonymous"] })),
    { route: "/.auth/*", allowedRoles: ["anonymous"] },
    { route: "/*", allowedRoles: ["family"] }
  ]);
  assert.equal(config.navigationFallback, undefined);
  assert.deepEqual(config.responseOverrides["401"], { statusCode: 302, redirect: familyTestPublicPages[0] });
  assert.deepEqual(config.responseOverrides["403"], { rewrite: familyTestPublicPages[1] });
  assert.equal(config.globalHeaders["Cache-Control"], "private, no-store");
  assert.equal(config.globalHeaders["X-Robots-Tag"], "noindex");
  for (const patch of [
    { routes: [{ route: "/*", allowedRoles: ["authenticated"] }] },
    { navigationFallback: { rewrite: "/index.html" } },
    { auth: { rolesSource: "/api/roles" } },
    { globalHeaders: { "Cache-Control": "public" } }
  ]) {
    assert.throws(() => familyTestConfig(JSON.stringify({ trailingSlash: "always", globalHeaders: {}, ...patch })));
  }
});

test("family build flags cannot be used in release/local and canonical stays production", () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    npm_lifecycle_event: "build:family-test", FAMILY_TEST_SITE_ORIGIN: origin,
    NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL: media
  };
  const build = createFamilyTestBuildEnvironment(env);
  assert.equal(build.NEXT_PUBLIC_SITE_URL, "https://mycafegourmand.com");
  assert.doesNotThrow(() => assertRecipeMediaBuildEnvironment("family-test", build));
  assert.throws(() => assertRecipeMediaBuildEnvironment("release", build));
  assert.throws(() => assertRecipeMediaBuildEnvironment("non-release", build));
  assert.throws(() => createReleaseBuildEnvironment(env));
  assert.throws(() => createFamilyTestBuildEnvironment({ ...env, NEXT_PUBLIC_SITE_URL: origin }));
  assert.throws(() => createFamilyTestBuildEnvironment({ ...env, npm_lifecycle_event: "build:release" }));
  assert.throws(() => createFamilyTestBuildEnvironment({ ...env, MY_CAFE_GOURMAND_RELEASE_BUILD: "1" }));
});

test("family artifact keeps canonical but test navigation stays local and production rejects it", () => {
  const data = fixture();
  try {
    const result = validateFamilyTestArtifact(data.root);
    assert.equal(result.metadata.promotion, "NONPROMOTABLE");
    assert.equal(result.manifest.redirects.length, data.manifest.redirects.length);
    assert.throws(() => validateFamilyTestArtifact(data.root, "f".repeat(40)));
    assert.throws(() => validateFamilyTestArtifact(data.root, undefined, "https://wrong.azurestaticapps.net"));
    const redirect = data.manifest.redirects[0];
    const production = renderLegacyPage(redirect);
    assert.equal(production, renderLegacyPage(redirect, "production"));
    assert.match(production, /content="0;url=https:\/\/mycafegourmand.com\/recipes\/new\/"/u);
    const family = renderLegacyPage(redirect, "family-test");
    assert.match(family, /content="0;url=\/recipes\/new\/"/u);
    assert.match(family, /rel="canonical" href="https:\/\/mycafegourmand.com\/recipes\/new\/"/u);
    assert.match(family, /<a href="\/recipes\/new\/">/u);
    assert.throws(() => validateReleaseArtifact(data.root, "production"), /NONPROMOTABLE/u);
    assert.throws(() => writeReleaseArtifactMetadata(data.root), /NONPROMOTABLE/u);
    assert.throws(() => prepareStagingArtifact(data.root, path.join(data.base, "stage")), /NONPROMOTABLE/u);
    assert.throws(() => validateAcceptanceReceipt(data.root, ".deployment/family-report.json", "production",
      "https://mycafegourmand.com"), /NONPROMOTABLE/u);
    const login = readFileSync(path.join(data.root, "out/_family-test/login.html"), "utf8");
    for (const locale of ["en", "fr", "ru"]) assert.ok(login.includes(`lang="${locale}"`));
    assert.match(login, /\/.auth\/login\/aad/u);
    assert.match(login, /\/.auth\/login\/github/u);
    assert.ok(!login.includes("<script"));
    writeFileSync(path.join(data.root, "out/app.js"), "changed");
    assert.throws(() => validateFamilyTestArtifact(data.root), /inventory/u);
  } finally { data.cleanup(); }
});

test("production cannot be relabeled family and mixed receipt metadata is rejected", () => {
  const production = releaseFixture();
  const family = fixture();
  try {
    assert.throws(() => writeFamilyTestArtifact(production.root, origin, media), /production artifacts/u);
    assert.throws(() => validateFamilyTestArtifact(production.root));
    for (const file of ["release-artifact.json", "staging-acceptance.json", "production-acceptance.json"]) {
      writeFileSync(path.join(family.root, ".deployment", file), "{}");
      assert.throws(() => validateFamilyTestArtifact(family.root), /production artifacts/u);
      rmSync(path.join(family.root, ".deployment", file));
    }
    const metadata = JSON.parse(readFileSync(path.join(family.root, familyMetadataPath), "utf8"));
    writeFileSync(path.join(family.root, familyMetadataPath), JSON.stringify({ ...metadata, promotion: "production" }));
    assert.throws(() => validateFamilyTestArtifact(family.root));
  } finally { production.cleanup(); family.cleanup(); }
});

test("family namespace collisions and stale regenerated output fail closed", () => {
  for (const directory of ["_family-test", ".auth", "_FAMILY-TEST"]) {
    const data = releaseFixture(false);
    try {
      mkdirSync(path.join(data.root, "out", directory));
      writeFileSync(path.join(data.root, "out", directory, "data.json"), "{}");
      assert.throws(() => writeFamilyTestArtifact(data.root, origin, media), /reserved/u);
    } finally { data.cleanup(); }
  }
  const data = fixture();
  try {
    assert.throws(() => writeFamilyTestArtifact(data.root, origin, media));
  } finally { data.cleanup(); }
});

test("family verifier covers original encoding and index aliases in three simulated role contexts", async () => {
  const data = fixture();
  try {
    const requested = new Map<string, Set<string>>();
    const make = (context: "anonymous" | "nonmember" | "member") =>
      fakeTransport(data.root, context, (target, response) => {
        if (!requested.has(context)) requested.set(context, new Set());
        requested.get(context)!.add(target);
        return response;
      });
    const evidence = await verifyFamilyTest(data.root, {
      anonymous: make("anonymous"), nonmember: make("nonmember"), member: make("member")
    });
    assert.equal(evidence.kind, "family-test-access-evidence");
    assert.equal(evidence.promotion, "NONPROMOTABLE");
    assert.equal(evidence.checkedLegacySources, 3);
    for (const context of ["anonymous", "nonmember", "member"]) {
      for (const target of ["/app.js", "/recipes/new/index.html", "/recipes/new/", "/recipes/new",
        "/ru/%d0%ba%d0%be%d1%82/", wirePath("/fr/café/")]) {
        assert.ok(requested.get(context)!.has(target), `${context} missing ${target}`);
      }
    }
  } finally { data.cleanup(); }
});

test("live verification rejects self-signup/default-role bypass, login HTTP200, missing noindex and unavailable sessions", async () => {
  const data = fixture();
  try {
    const anonymous = fakeTransport(data.root, "anonymous");
    const nonmember = fakeTransport(data.root, "nonmember");
    const member = fakeTransport(data.root, "member");
    await assert.rejects(verifyFamilyTest(data.root, { anonymous, member }), /Real member/u);
    await assert.rejects(verifyFamilyTest(data.root, { anonymous, nonmember: member, member }), /role context/u);
    await assert.rejects(verifyFamilyTest(data.root, {
      anonymous: fakeTransport(data.root, "anonymous", (target, response) =>
        target === "/app.js" ? { ...response, status: 200 } : response), nonmember, member
    }), /validation failed/u);
    await assert.rejects(verifyFamilyTest(data.root, {
      anonymous, nonmember: fakeTransport(data.root, "nonmember", (target, response) =>
        target === "/app.js" ? { ...response, status: 200 } : response), member
    }), /validation failed/u);
    await assert.rejects(verifyFamilyTest(data.root, {
      anonymous, nonmember: fakeTransport(data.root, "nonmember", (target, response) =>
        target === "/app.js" ? { ...response, body: Buffer.from("application data with a 403 status") } : response), member
    }), /validation failed/u);
    await assert.rejects(verifyFamilyTest(data.root, {
      anonymous, nonmember, member: fakeTransport(data.root, "member", (target, response) =>
        target === "/app.js" ? { ...response, headers: { "content-type": "text/javascript" } } : response)
    }), /validation failed/u);
    const probe = await verifyFamilyTest(data.root, { anonymous }, true);
    assert.equal(probe.kind, "family-test-anonymous-probe");
    assert.deepEqual(probe.contexts, ["anonymous"]);
  } finally { data.cleanup(); }
});

test("private session files bind origin, reject permissions and never allow off-origin transport", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "family-session-test-"));
  const file = path.join(directory, "session.json");
  try {
    writeFileSync(file, JSON.stringify({ origin, cookie: "StaticWebAppsAuthCookie=sanitized-fixture" }), { mode: 0o600 });
    assert.equal(readFamilyCookie(file, origin, process.cwd()), "StaticWebAppsAuthCookie=sanitized-fixture");
    assert.throws(() => readFamilyCookie(file, "https://wrong.azurestaticapps.net", process.cwd()));
    if (process.platform !== "win32") {
      chmodSync(file, 0o644);
      assert.throws(() => readFamilyCookie(file, origin, process.cwd()), /private/u);
      chmodSync(file, 0o600);
    }
    const transport = familySessionTransport(origin, "StaticWebAppsAuthCookie=sanitized-fixture");
    assert.throws(() => transport("https://evil.example", "/", 100));
    assert.throws(() => transport(origin, "//evil.example/", 100));
    assert.throws(() => familySessionTransport(origin, "cookie=value\r\nInjected: secret"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("bootstrap is content-free, freshly generated and nonpromotable", () => {
  const root = mkdtempSync(path.join(process.cwd(), ".family-bootstrap-test-"));
  try {
    mkdirSync(path.join(root, "config"));
    writeFileSync(path.join(root, "config/staticwebapp.config.json"),
      JSON.stringify({ trailingSlash: "always", globalHeaders: {} }));
    const result = buildFamilyBootstrap(root, origin);
    assert.equal(result.metadata.purpose, "bootstrap");
    assert.equal(result.metadata.mediaBase, null);
    assert.equal(result.metadata.files.length, 4);
    assert.equal(result.manifest.redirects.length, 0);
    assert.throws(() => buildFamilyBootstrap(root, origin), /fresh checkout/u);
    assert.throws(() => validateReleaseArtifact(root, "production"), /NONPROMOTABLE/u);
    assert.match(readFileSync(path.join(root, "out/_family-test/login.html"), "utf8"), /probe.html/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("family reports cannot substitute for production staging receipts", async () => {
  const family = fixture();
  const production = releaseFixture();
  try {
    const evidence = await verifyFamilyTest(family.root, {
      anonymous: fakeTransport(family.root, "anonymous"),
      nonmember: fakeTransport(family.root, "nonmember"),
      member: fakeTransport(family.root, "member")
    });
    writeFileSync(path.join(production.root, ".deployment/staging-acceptance.json"), JSON.stringify(evidence));
    assert.throws(() => validateAcceptanceReceipt(production.root, ".deployment/staging-acceptance.json", "staging", origin));
  } finally { family.cleanup(); production.cleanup(); }
});

test("CLI does not print invalid cookie contents or issue evidence on a private-input failure", () => {
  const data = fixture();
  const directory = mkdtempSync(path.join(os.tmpdir(), "family-cookie-redaction-"));
  const cookie = path.join(directory, "session.json");
  try {
    writeFileSync(cookie, "sanitized-sensitive-marker invalid json", { mode: 0o600 });
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "scripts/verify-family-test.ts", data.root,
      "--member-cookie-file", cookie, "--nonmember-cookie-file", cookie,
      "--report", path.join(directory, "report.json")
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /family-test-verification-failed/u);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /sanitized-sensitive-marker/u);
  } finally { data.cleanup(); rmSync(directory, { recursive: true, force: true }); }
});

test("family deployment workflow is manual, protected, isolated and never issues production acceptance", () => {
  const text = readFileSync(path.join(process.cwd(), ".github/workflows/family-test.yml"), "utf8");
  assert.match(text, /workflow_dispatch:/u);
  assert.match(text, /environment: family-test/u);
  assert.match(text, /scripts\/workflow-family-test.ts/u);
  assert.match(text, /family-test-NONPROMOTABLE/u);
  assert.match(text, /--anonymous-only/u);
  assert.match(text, /skip_app_build: true/u);
  assert.match(text, /skip_api_build: true/u);
  assert.match(text, /cancel-in-progress: false/u);
  assert.doesNotMatch(text, /pull_request:|push:|build:release|accepted-production|production-acceptance|staging-acceptance|cookie-file|deployment_environment:/u);
  const actions = [...text.matchAll(/uses: ([^\s]+)/gu)].map((match) => match[1]);
  assert.ok(actions.every((action) => /@[a-f0-9]{40}$/u.test(action)));
});
