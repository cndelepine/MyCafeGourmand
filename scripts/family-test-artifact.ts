import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseExactRedirectManifest } from "../src/content/redirect-manifest";
import { decodeLocalPath } from "../src/content/url-path";
import {
  familyTestPrefix, familyTestPublicPages, familyTestProbePath, familyTestRole,
  isFamilyTestReservedPath
} from "../src/lib/family-test-routes";
import { requireRecipeMediaBaseUrl } from "../src/lib/recipe-media";
import { fileSchema, inventoryOutput, readBoundedFile, sha256 } from "./release-artifact";
import { writeNewDeploymentFile } from "./deployment-files";
import {
  getLegacyPageOutputPath, productionSiteOrigin, renderLegacyPage, validateLegacyNavigationOutput
} from "./legacy-navigation";
import { validateSiteOrigin } from "./verify-deployed-site";

export const familyMetadataPath = ".deployment/family-test-artifact.json";
const manifestPath = ".deployment/redirect-manifest.json";
const configPath = "staticwebapp.config.json";
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const schema = z.object({
  schemaVersion: z.literal(1),
  artifactClass: z.literal("family-test"),
  promotion: z.literal("NONPROMOTABLE"),
  purpose: z.enum(["bootstrap", "site"]),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  origin: z.string(),
  canonicalOrigin: z.literal(productionSiteOrigin),
  mediaBase: z.string().nullable(),
  baseConfig: z.string().max(20_000),
  manifestDigest: digest,
  files: z.array(fileSchema).min(1).max(15_000)
}).strict();
export type FamilyTestArtifact = z.infer<typeof schema>;

export function familyTestConfig(base: string) {
  const config = z.object({
    trailingSlash: z.literal("always"),
    globalHeaders: z.record(z.string(), z.string()),
    routes: z.array(z.never()).optional()
  }).strict().parse(JSON.parse(base));
  const permitted = new Set([
    "strict-transport-security", "x-content-type-options", "x-frame-options",
    "referrer-policy", "permissions-policy"
  ]);
  if (Object.keys(config.globalHeaders).some((key) => !permitted.has(key.toLowerCase()))) {
    throw new Error("Family test requires a reviewed baseline header adapter.");
  }
  const result = `${JSON.stringify({
    trailingSlash: config.trailingSlash,
    routes: [
      ...familyTestPublicPages.map((route) => ({ route, allowedRoles: ["anonymous"] })),
      { route: "/.auth/*", allowedRoles: ["anonymous"] },
      { route: "/*", allowedRoles: [familyTestRole] }
    ],
    responseOverrides: {
      "401": { statusCode: 302, redirect: familyTestPublicPages[0] },
      "403": { rewrite: familyTestPublicPages[1] }
    },
    globalHeaders: {
      ...config.globalHeaders,
      "X-Robots-Tag": "noindex",
      "Content-Security-Policy": "form-action 'none'",
      "Cache-Control": "private, no-store"
    }
  }, null, 2)}\n`;
  if (Buffer.byteLength(result) > 20_000) throw new Error("Family configuration exceeds Azure limits.");
  return result;
}

// Static entry pages contain no application data and work before site scripts are authorized.
export function familyEntryPage(kind: "login" | "denied", origin: string, bootstrap = false) {
  validateSiteOrigin(origin, "staging");
  const denied = kind === "denied";
  const returnTo = encodeURIComponent(`${origin}${bootstrap ? familyTestProbePath : "/"}`);
  const logoutTo = encodeURIComponent(`${origin}${familyTestPublicPages[0]}`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>My Cafe Gourmand - family test</title></head>
<body><main>
<section lang="en"><h1>${denied ? "Invitation required" : "Family test sign-in"}</h1><p>This is a test, not the live website. Use the account and provider in your invitation. Signing in alone does not grant access.</p></section>
<section lang="fr"><h2>${denied ? "Invitation requise" : "Connexion au test familial"}</h2><p>Ceci est un test, pas le site public. Utilisez le compte et le fournisseur de votre invitation. La connexion seule ne donne pas accès.</p></section>
<section lang="ru"><h2>${denied ? "Требуется приглашение" : "Вход для семейного тестирования"}</h2><p>Это тест, а не основной сайт. Используйте аккаунт и сервис из приглашения. Сам по себе вход не предоставляет доступ.</p></section>
<p><a href="/.auth/login/aad?post_login_redirect_uri=${returnTo}">Microsoft</a> |
<a href="/.auth/login/github?post_login_redirect_uri=${returnTo}">GitHub</a></p>
<p><a href="/">English</a> | <a href="/fr/">Français</a> | <a href="/ru/">Русский</a></p>
<p><a href="/.auth/logout?post_logout_redirect_uri=${logoutTo}">Sign out / Déconnexion / Выйти</a></p>
</main></body></html>
`;
}

const probe = "<!doctype html><html lang=\"en\"><head><meta name=\"robots\" content=\"noindex\"><title>Family access probe</title></head><body>Invited family access is active. NONPROMOTABLE test.</body></html>\n";

function rejectProductionMetadata(root: string) {
  for (const file of ["release-artifact.json", "staging-acceptance.json", "production-acceptance.json"]) {
    if (existsSync(path.join(root, ".deployment", file))) {
      throw new Error("Family tests cannot contain production artifacts or acceptance receipts.");
    }
  }
}

export function writeFamilyTestArtifact(
  root: string, origin: string, mediaBase: string | null, purpose: "bootstrap" | "site" = "site"
) {
  validateSiteOrigin(origin, "staging");
  if (purpose === "site") requireRecipeMediaBaseUrl(mediaBase ?? undefined);
  else if (mediaBase !== null) throw new Error("Bootstrap must not configure media.");
  rejectProductionMetadata(root);
  const output = path.join(root, "out");
  const manifestBytes = readBoundedFile(root, manifestPath);
  const manifest = parseExactRedirectManifest(JSON.parse(manifestBytes.toString()));
  validateLegacyNavigationOutput(manifest, output);
  const initialFiles = inventoryOutput(output);
  if (initialFiles.some((file) => isFamilyTestReservedPath(`/${file.path}`))
    || manifest.redirects.some(({ source, destination }) =>
      [source, destination].some((route) => isFamilyTestReservedPath(decodeLocalPath(route))))) {
    throw new Error("Content collides with reserved family-test or Azure auth paths.");
  }
  if (purpose === "bootstrap" && (manifest.redirects.length !== 0
    || initialFiles.length !== 1 || initialFiles[0].path !== configPath)) {
    throw new Error("Bootstrap must contain only the base configuration before generation.");
  }
  const baseConfig = readBoundedFile(output, configPath, 20_000).toString();
  const config = familyTestConfig(baseConfig);
  mkdirSync(path.join(output, familyTestPrefix.slice(1)));
  for (const kind of ["login", "denied"] as const) {
    writeNewDeploymentFile(path.join(output, familyTestPrefix, `${kind}.html`), familyEntryPage(kind, origin, purpose === "bootstrap"));
  }
  if (purpose === "bootstrap") {
    writeNewDeploymentFile(path.join(output, familyTestProbePath), probe);
  }
  for (const redirect of manifest.redirects) {
    writeFileSync(path.join(output, getLegacyPageOutputPath(redirect.source)), renderLegacyPage(redirect, "family-test"));
  }
  writeFileSync(path.join(output, configPath), config);
  const metadata = schema.parse({
    schemaVersion: 1, artifactClass: "family-test", promotion: "NONPROMOTABLE", purpose,
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    origin, canonicalOrigin: productionSiteOrigin, mediaBase, baseConfig,
    manifestDigest: sha256(manifestBytes), files: inventoryOutput(output)
  });
  writeNewDeploymentFile(path.join(root, familyMetadataPath), `${JSON.stringify(metadata, null, 2)}\n`);
  return validateFamilyTestArtifact(root);
}

export function validateFamilyTestArtifact(root: string, expectedCommit?: string, expectedOrigin?: string) {
  rejectProductionMetadata(root);
  const bytes = readBoundedFile(root, familyMetadataPath);
  const metadata = schema.parse(JSON.parse(bytes.toString()));
  validateSiteOrigin(metadata.origin, "staging");
  if ((expectedCommit !== undefined && metadata.sourceCommit !== expectedCommit)
    || (expectedOrigin !== undefined && metadata.origin !== expectedOrigin)) {
    throw new Error("Family artifact does not match trusted commit/origin.");
  }
  if (metadata.purpose === "site") requireRecipeMediaBaseUrl(metadata.mediaBase ?? undefined);
  else if (metadata.mediaBase !== null) throw new Error("Bootstrap cannot contain media configuration.");
  const output = path.join(root, "out");
  if (JSON.stringify(inventoryOutput(output)) !== JSON.stringify(metadata.files)
    || readBoundedFile(output, configPath).toString() !== familyTestConfig(metadata.baseConfig)) {
    throw new Error("Family artifact inventory or access policy mismatch.");
  }
  for (const kind of ["login", "denied"] as const) {
    if (readBoundedFile(output, `${familyTestPrefix.slice(1)}${kind}.html`).toString()
      !== familyEntryPage(kind, metadata.origin, metadata.purpose === "bootstrap")) {
      throw new Error("Family entry page mismatch.");
    }
  }
  const allowedReserved = new Set<string>([
    ...familyTestPublicPages, ...(metadata.purpose === "bootstrap" ? [familyTestProbePath] : [])
  ]);
  if (metadata.files.some((file) => isFamilyTestReservedPath(`/${file.path}`)
    && !allowedReserved.has(`/${file.path}`))) {
    throw new Error("Unexpected reserved-namespace output.");
  }
  const manifestBytes = readBoundedFile(root, manifestPath);
  if (sha256(manifestBytes) !== metadata.manifestDigest) throw new Error("Family manifest digest mismatch.");
  const manifest = parseExactRedirectManifest(JSON.parse(manifestBytes.toString()));
  if (manifest.redirects.some(({ source, destination }) =>
    [source, destination].some((route) => isFamilyTestReservedPath(decodeLocalPath(route))))) {
    throw new Error("Legacy map collides with access routes.");
  }
  validateLegacyNavigationOutput(manifest, output, "family-test");
  for (const { destination } of manifest.redirects) {
    const expected = `${decodeLocalPath(destination).slice(1)}index.html`;
    if (!metadata.files.some((file) => file.path === expected)) throw new Error("Missing legacy destination.");
  }
  if (metadata.purpose === "bootstrap" && (manifest.redirects.length !== 0 || metadata.files.length !== 4
    || readBoundedFile(output, familyTestProbePath.slice(1)).toString() !== probe)) {
    throw new Error("Bootstrap contains unexpected content.");
  }
  return { metadata, manifest, artifactDigest: sha256(bytes) };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    const [command, root, commit, origin, ...extra] = process.argv.slice(2);
    if (command !== "validate" || !root || extra.length) throw new Error("Expected validate <root> [commit] [origin].");
    validateFamilyTestArtifact(root, commit, origin);
    console.log("Validated NONPROMOTABLE family-test artifact.");
  } catch {
    console.error("family-test-artifact-failed: invalid artifact, origin, or invocation.");
    process.exitCode = 1;
  }
}
