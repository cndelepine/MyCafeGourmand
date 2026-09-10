import { lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { familyTestPublicPages, familyTestRole } from "../src/lib/family-test-routes";
import { validateFamilyTestArtifact } from "./family-test-artifact";
import { readBoundedFile, sha256 } from "./release-artifact";
import { readBoundedDeploymentFile, writeNewDeploymentFile } from "./deployment-files";
import {
  contentTypes, createHttpsTransport, httpsTransport, validateSiteOrigin, wirePath,
  type SiteResponse, type SiteTransport
} from "./verify-deployed-site";
import { renderLegacyPage } from "./legacy-navigation";

type Check = { target: string; bytes: number; digest: string; types?: readonly string[]; slash: boolean };
const roleSchema = z.object({
  clientPrincipal: z.object({
    userId: z.string().min(1).max(500),
    identityProvider: z.enum(["aad", "github"]),
    userRoles: z.array(z.string()).max(100)
  }).nullable()
});
const cookieSchema = z.object({
  origin: z.string(),
  cookie: z.string().min(1).max(16_384).regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*(?:; [!#$%&'*+\-.^_`|~0-9A-Za-z]+=[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*)*$/u)
}).strict();

function outsideWorkspace(file: string, root: string) {
  if (!path.isAbsolute(file)) throw new Error("Private cookie/report paths must be absolute.");
  const resolved = path.resolve(file);
  for (const boundary of [path.resolve(root), process.cwd()]) {
    if (resolved === boundary || resolved.startsWith(`${boundary}${path.sep}`)) {
      throw new Error("Private cookie/report paths must be outside the checkout and artifact.");
    }
  }
  return resolved;
}

export function readFamilyCookie(file: string, origin: string, root: string) {
  validateSiteOrigin(origin, "staging");
  const resolved = outsideWorkspace(file, root);
  const stats = lstatSync(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
    || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    throw new Error("Cookie file must be private (0600), regular and not linked.");
  }
  const result = cookieSchema.safeParse(JSON.parse(
    readBoundedDeploymentFile(path.dirname(resolved), path.basename(resolved), 20_000).toString()
  ));
  if (!result.success || result.data.origin !== origin) throw new Error("Invalid private session file or origin.");
  return result.data.cookie;
}

export function familySessionTransport(origin: string, cookie: string): SiteTransport {
  validateSiteOrigin(origin, "staging");
  if (!cookieSchema.safeParse({ origin, cookie }).success) throw new Error("Invalid private session.");
  const transport = createHttpsTransport({ Cookie: cookie });
  return (requestedOrigin, target, maximum) => {
    if (requestedOrigin !== origin || target !== wirePath(target)) {
      throw new Error("Private session requests must stay on the exact approved origin and safe wire path.");
    }
    return transport(origin, target, maximum);
  };
}

function assertPolicy(response: SiteResponse, baseline: Record<string, string>) {
  for (const [key, value] of Object.entries(baseline)) {
    if (response.headers[key.toLowerCase()]?.trim() !== value.trim()) {
      throw new Error("Family response omitted a reviewed header.");
    }
  }
}

function assertDenied(response: SiteResponse, member: boolean, origin: string) {
  if (member) {
    if (response.status !== 403) throw new Error("A signed-in nonmember must receive 403.");
  } else {
    if (response.status === 401) return;
    if (response.status !== 302 || !response.headers.location) {
      throw new Error("Anonymous access must receive 401 or the exact 302 login entry redirect.");
    }
    const redirect = new URL(response.headers.location, origin);
    if (redirect.href !== `${origin}${familyTestPublicPages[0]}`) {
      throw new Error("Unexpected anonymous login redirect.");
    }
  }
}

async function checkRoles(transport: SiteTransport, origin: string, context: "anonymous" | "nonmember" | "member") {
  const response = await transport(origin, "/.auth/me", 32_768);
  if (response.status !== 200) throw new Error("Cannot establish the real platform session.");
  const principal = roleSchema.parse(JSON.parse(response.body.toString())).clientPrincipal;
  const roles = principal?.userRoles;
  if (context === "anonymous" ? roles !== undefined
    : !roles?.includes("authenticated") || (roles.includes(familyTestRole) !== (context === "member"))) {
    throw new Error("Platform session does not have the required actual role context.");
  }
  return principal === null ? null : `${principal.identityProvider}:${principal.userId}`;
}

export async function verifyFamilyTest(
  root: string,
  transports: { anonymous: SiteTransport; nonmember?: SiteTransport; member?: SiteTransport },
  anonymousOnly = false
) {
  const { metadata, manifest, artifactDigest } = validateFamilyTestArtifact(root);
  const origin = metadata.origin;
  const baseline = z.object({ globalHeaders: z.record(z.string(), z.string()) }).parse(JSON.parse(
    readBoundedFile(root, "out/staticwebapp.config.json").toString()
  )).globalHeaders;
  const deniedPage = readBoundedFile(root, `out${familyTestPublicPages[1]}`);
  function denied(response: SiteResponse, nonmember: boolean) {
    assertDenied(response, nonmember, origin);
    if (nonmember) {
      if (!response.body.equals(deniedPage)) throw new Error("A denied response must contain only the reviewed invitation notice.");
      assertPolicy(response, baseline);
    }
  }
  if (!anonymousOnly && (!transports.member || !transports.nonmember)) {
    throw new Error("Real member and signed-in nonmember sessions are required for family acceptance.");
  }
  await checkRoles(transports.anonymous, origin, "anonymous");
  if (!anonymousOnly) {
    const memberIdentity = await checkRoles(transports.member!, origin, "member");
    const nonmemberIdentity = await checkRoles(transports.nonmember!, origin, "nonmember");
    if (memberIdentity === nonmemberIdentity) throw new Error("Member and nonmember must be distinct actual identities.");
  }
  const checks = new Map<string, Check>();
  for (const file of metadata.files) {
    if (file.path === "staticwebapp.config.json") continue;
    const target = `/${file.path.split("/").map(encodeURIComponent).join("/")}`;
    const check = { target, bytes: file.bytes, digest: file.sha256, types: contentTypes(file.path), slash: false };
    checks.set(target, check);
    if (target.endsWith("/index.html")) {
      const directory = target.slice(0, -"index.html".length);
      checks.set(directory, { ...check, target: directory });
      if (directory !== "/") {
        const slashless = directory.slice(0, -1);
        checks.set(slashless, { ...check, target: slashless, slash: true });
      }
    }
  }
  for (const redirect of manifest.redirects) {
    const rendered = renderLegacyPage(redirect, "family-test");
    const target = wirePath(redirect.source);
    checks.set(target, {
      target, bytes: Buffer.byteLength(rendered), digest: sha256(rendered),
      types: ["text/html"], slash: !redirect.source.endsWith("/")
    });
    if (!checks.has(wirePath(redirect.destination))) throw new Error("Missing same-origin legacy destination.");
  }
  const publicPaths = new Set<string>(familyTestPublicPages);
  async function exact(check: Check, transport: SiteTransport) {
    let response = await transport(origin, check.target, check.bytes + 4_096);
    if (check.slash && [301, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location || new URL(location, origin).href !== `${origin}${check.target}/`) {
        throw new Error("Only exact same-origin legacy slash normalization is permitted.");
      }
      response = await transport(origin, `${check.target}/`, check.bytes + 4_096);
    }
    if (response.status !== 200 || response.body.length !== check.bytes || sha256(response.body) !== check.digest
      || (check.types && !check.types.includes(response.headers["content-type"]?.split(";")[0].trim().toLowerCase() ?? ""))) {
      throw new Error("Family content must return exact retained bytes and MIME directly.");
    }
    assertPolicy(response, baseline);
  }
  let next = 0;
  let failures = 0;
  const deadline = Date.now() + 20 * 60_000;
  const list = [...checks.values()];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < list.length) {
      if (Date.now() > deadline) throw new Error("Family verification exceeded its deadline.");
      const check = list[next++];
      try {
        if (publicPaths.has(check.target)) {
          await exact(check, transports.anonymous);
          continue;
        }
        denied(await transports.anonymous(origin, check.target, 16_384), false);
        if (!anonymousOnly) {
          denied(await transports.nonmember!(origin, check.target, 16_384), true);
          await exact(check, transports.member!);
          // Check cache isolation after an authorized read of the same URL.
          denied(await transports.anonymous(origin, check.target, 16_384), false);
        }
      } catch {
        failures += 1;
      }
    }
  }));
  for (const target of ["/__family_missing__", "/_next/__missing__", "/_search/__missing__.json"]) {
    denied(await transports.anonymous(origin, target, 16_384), false);
    if (!anonymousOnly) denied(await transports.nonmember!(origin, target, 16_384), true);
  }
  // Reserved config may be hidden by the platform; it must never be disclosed.
  const configResponse = await transports.anonymous(origin, "/staticwebapp.config.json", 24_096);
  if (![401, 403, 404].includes(configResponse.status)) assertDenied(configResponse, false, origin);
  if (failures) throw new Error(`Family access/content validation failed for ${failures} paths (no private session data logged).`);
  return {
    schemaVersion: 1, kind: anonymousOnly ? "family-test-anonymous-probe" : "family-test-access-evidence",
    promotion: "NONPROMOTABLE", artifactDigest, sourceCommit: metadata.sourceCommit, origin,
    purpose: metadata.purpose, checkedPaths: checks.size, checkedLegacySources: manifest.redirects.length,
    contexts: anonymousOnly ? ["anonymous"] : ["anonymous", "nonmember", "member"],
    checkedAt: new Date().toISOString()
  };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  void (async () => {
    const [root, ...args] = process.argv.slice(2);
    if (!root) throw new Error("Expected an artifact root.");
    if (args.length === 1 && args[0] === "--anonymous-only") {
      await verifyFamilyTest(root, { anonymous: httpsTransport }, true);
      console.log("Anonymous family-test probes passed; invited/nonmember acceptance remains UNVERIFIED.");
      return;
    }
    if (args.length !== 6 || args[0] !== "--member-cookie-file"
      || args[2] !== "--nonmember-cookie-file" || args[4] !== "--report") {
      throw new Error("Expected member and nonmember private cookie files and a private report path.");
    }
    const report = outsideWorkspace(args[5], root);
    const { metadata } = validateFamilyTestArtifact(root);
    const memberCookie = readFamilyCookie(args[1], metadata.origin, root);
    const nonmemberCookie = readFamilyCookie(args[3], metadata.origin, root);
    if (memberCookie === nonmemberCookie) throw new Error("Independent actual member/nonmember sessions are required.");
    const evidence = await verifyFamilyTest(root, {
      anonymous: httpsTransport,
      member: familySessionTransport(metadata.origin, memberCookie),
      nonmember: familySessionTransport(metadata.origin, nonmemberCookie)
    });
    writeNewDeploymentFile(report, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log("Family test access evidence written privately; NONPROMOTABLE, not production acceptance.");
  })().catch(() => {
    console.error("family-test-verification-failed: check artifact, private session permissions/roles and direct-origin access; no acceptance issued.");
    process.exitCode = 1;
  });
}
