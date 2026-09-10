import { request } from "node:https";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { validateSafeLocalPath } from "../src/content/url-path";
import { productionSiteOrigin, renderLegacyPage } from "./legacy-navigation";
import {
  readBoundedFile, sha256, validateReleaseArtifact, type DeploymentVariant
} from "./release-artifact";

export type SiteResponse = {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
};
export type SiteTransport = (origin: string, wirePath: string, maximumBytes: number) => Promise<SiteResponse>;

export function validateSiteOrigin(origin: string, variant: DeploymentVariant) {
  const parsed = new URL(origin);
  if (origin !== parsed.origin || parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password
    || (variant === "production" ? origin !== productionSiteOrigin
      : !/^[a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9][a-z0-9-]{0,62}){0,2}\.azurestaticapps\.net$/u.test(parsed.hostname))) {
    throw new Error("Expected the exact production origin or a generated HTTPS Azure staging origin.");
  }
  return origin;
}

export function wirePath(localPath: string) {
  validateSafeLocalPath(localPath, "Live acceptance path");
  // Retain existing percent escape spelling; encode only literal Unicode.
  return localPath.replace(/[^\x21-\x7e]/gu, (character) => encodeURIComponent(character));
}

export const httpsTransport: SiteTransport = (origin, target, maximumBytes) => new Promise((resolve, reject) => {
  const url = new URL(origin);
  const req = request({
    protocol: "https:", hostname: url.hostname, port: 443,
    method: "GET", path: target,
    headers: { "Accept-Encoding": "identity", "User-Agent": "MyCafeGourmand-release-acceptance/1" }
  }, (response) => {
    const parts: Buffer[] = [];
    let bytes = 0;
    response.on("data", (part: Buffer) => {
      bytes += part.length;
      if (bytes > maximumBytes) {
        response.destroy(new Error("Live response exceeded its artifact byte bound."));
      } else {
        parts.push(part);
      }
    });
    response.on("error", reject);
    response.on("aborted", () => reject(new Error("Live response was aborted.")));
    response.on("end", () => {
      const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [
        key.toLowerCase(), Array.isArray(value) ? value.join(", ") : value
      ]));
      resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(parts) });
    });
  });
  const timer = setTimeout(() => req.destroy(new Error("Live request deadline exceeded.")), 15_000);
  req.on("close", () => clearTimeout(timer));
  req.on("error", reject);
  req.end();
});

const receiptSchema = z.object({
  schemaVersion: z.literal(1),
  variant: z.enum(["production", "staging"]),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  origin: z.string().max(300),
  checkedFiles: z.number().int().positive(),
  checkedLegacySources: z.number().int().nonnegative(),
  checkedAt: z.string().datetime()
}).strict();
export type AcceptanceReceipt = z.infer<typeof receiptSchema>;

export function validateAcceptanceReceipt(
  root: string, receiptFile: string, variant: DeploymentVariant, expectedOrigin: string
) {
  const artifact = validateReleaseArtifact(root, "production");
  const receipt = receiptSchema.parse(JSON.parse(readBoundedFile(root, receiptFile, 10_000).toString()));
  validateSiteOrigin(expectedOrigin, variant);
  const expectedFiles = artifact.metadata.files.length - 1;
  if (receipt.variant !== variant || receipt.origin !== expectedOrigin
    || receipt.artifactDigest !== artifact.artifactDigest
    || receipt.sourceCommit !== artifact.metadata.sourceCommit
    || receipt.checkedFiles !== expectedFiles
    || receipt.checkedLegacySources !== artifact.manifest.redirects.length) {
    throw new Error("Acceptance receipt is not bound to this artifact, origin, and complete coverage.");
  }
  return receipt;
}

type Check = {
  target: string;
  digest: string;
  bytes: number;
  intrinsicNoindex: boolean;
  contentTypes?: readonly string[];
  allowSlashAppend: boolean;
};

function contentTypes(file: string): readonly string[] | undefined {
  const types: Record<string, readonly string[]> = {
    ".html": ["text/html"],
    ".js": ["text/javascript", "application/javascript"],
    ".css": ["text/css"],
    ".json": ["application/json"],
    ".txt": ["text/plain"],
    ".xml": ["application/xml", "text/xml"],
    ".svg": ["image/svg+xml"],
    ".png": ["image/png"],
    ".jpg": ["image/jpeg"],
    ".jpeg": ["image/jpeg"],
    ".webp": ["image/webp"],
    ".avif": ["image/avif"],
    ".gif": ["image/gif"],
    ".ico": ["image/x-icon", "image/vnd.microsoft.icon"],
    ".woff": ["font/woff"],
    ".woff2": ["font/woff2"]
  };
  return types[path.extname(file).toLowerCase()];
}

async function verifySite(
  root: string, variant: DeploymentVariant, origin: string, transport: SiteTransport,
  originPolicy: "canonical" | "azure" = "canonical"
): Promise<AcceptanceReceipt> {
  validateSiteOrigin(origin, originPolicy === "azure" ? "staging" : variant);
  const { metadata, manifest, artifactDigest } = validateReleaseArtifact(root, variant);
  const baselineHeaders = z.object({
    globalHeaders: z.record(z.string(), z.string())
  }).parse(JSON.parse(metadata.productionConfig)).globalHeaders;
  const checks: Check[] = [];
  const noindexMeta = /<meta(?=[^>]*\bname=["']robots["'])(?=[^>]*\bcontent=["'][^"']*\bnoindex\b)[^>]*>/iu;
  for (const file of metadata.files) {
    if (file.path === "staticwebapp.config.json") continue;
    const target = `/${file.path.split("/").map(encodeURIComponent).join("/")}`.replace(/\/index\.html$/u, "/");
    const intrinsicNoindex = file.path.endsWith(".html")
      && noindexMeta.test(readBoundedFile(root, `out/${file.path}`, 250 * 1024 * 1024).toString());
    checks.push({
      target, digest: file.sha256, bytes: file.bytes, intrinsicNoindex,
      contentTypes: contentTypes(file.path), allowSlashAppend: false
    });
  }
  for (const redirect of manifest.redirects) {
    const rendered = renderLegacyPage(redirect);
    checks.push({
      target: wirePath(redirect.source), digest: sha256(rendered), bytes: Buffer.byteLength(rendered),
      intrinsicNoindex: false, contentTypes: ["text/html"], allowSlashAppend: !redirect.source.endsWith("/")
    });
    const destination = wirePath(redirect.destination);
    if (!checks.some((check) => check.target === destination)) {
      throw new Error("Legacy destination is missing from artifact acceptance coverage.");
    }
  }
  let next = 0;
  const failures: string[] = [];
  const deadline = Date.now() + 10 * 60_000;
  async function checkOne(check: Check) {
    let target = check.target;
    let response = await transport(origin, target, check.bytes + 4_096);
    if ([301, 302, 307, 308].includes(response.status)) {
      if (!check.allowSlashAppend || ![301, 308].includes(response.status)) {
        throw new Error("Canonical URLs and assets must return HTTP 200 without redirects.");
      }
      const location = response.headers.location;
      if (!location) throw new Error("Missing normalization location.");
      const normalized = new URL(location, origin);
      const alternate = `${target}/`;
      if (normalized.origin !== origin || normalized.pathname !== alternate || normalized.search || normalized.hash) {
        throw new Error("Only same-origin trailing-slash normalization is allowed.");
      }
      target = alternate;
      response = await transport(origin, target, check.bytes + 4_096);
    }
    if (response.status !== 200 || response.body.length !== check.bytes || sha256(response.body) !== check.digest) {
      throw new Error("Expected HTTP 200 and exact retained artifact bytes.");
    }
    const responseType = response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (check.contentTypes !== undefined && !check.contentTypes.includes(responseType ?? "")) {
      throw new Error("Static assets must be served with their reviewed content type.");
    }
    for (const [name, value] of Object.entries(baselineHeaders)) {
      if (response.headers[name.toLowerCase()]?.trim() !== value.trim()) {
        throw new Error("Deployment omitted or changed a reviewed origin response header.");
      }
    }
    const noindex = /(?:^|[\s,])(?:noindex|none)(?:$|[\s,])/iu.test(response.headers["x-robots-tag"] ?? "");
    const blockedForm = /(?:^|;)\s*form-action\s+'none'\s*(?:;|$)/iu.test(response.headers["content-security-policy"] ?? "");
    if (variant === "staging" ? !noindex || !blockedForm : blockedForm || (noindex && !check.intrinsicNoindex)) {
      throw new Error("Deployment response policy does not match the environment.");
    }
  }
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < checks.length) {
      if (Date.now() > deadline) throw new Error("Live acceptance exceeded ten minutes.");
      const check = checks[next++];
      try {
        await checkOne(check);
      } catch {
        failures.push(check.target);
      }
    }
  }));
  if (failures.length > 0) {
    throw new Error(`Live acceptance failed for ${failures.length}/${checks.length} paths: ${failures.slice(0, 8).join(", ")}`);
  }
  return {
    schemaVersion: 1, variant, artifactDigest, sourceCommit: metadata.sourceCommit, origin,
    checkedFiles: metadata.files.length - 1, checkedLegacySources: manifest.redirects.length,
    checkedAt: new Date().toISOString()
  };
}

export function verifyDeployedSite(
  root: string, variant: DeploymentVariant, origin: string, transport: SiteTransport = httpsTransport
) {
  return verifySite(root, variant, origin, transport);
}

export async function verifyProductionOrigin(root: string, origin: string, transport: SiteTransport = httpsTransport) {
  const receipt = await verifySite(root, "production", origin, transport, "azure");
  return {
    kind: "production-origin-readiness",
    artifactDigest: receipt.artifactDigest,
    sourceCommit: receipt.sourceCommit,
    origin: receipt.origin,
    checkedFiles: receipt.checkedFiles,
    checkedLegacySources: receipt.checkedLegacySources
  };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const [command, root, variant, receiptFile, ...extra] = process.argv.slice(2);
  void (async () => {
    if (command === "verify-origin" && root && !variant && !receiptFile && !extra.length) {
      const origin = process.env.PRODUCTION_SITE_ORIGIN ?? "";
      validateSiteOrigin(origin, "staging");
      const actual = process.env.AZURE_UPLOAD_ORIGIN;
      if (actual !== origin && actual !== `${origin}/`) {
        throw new Error("Azure upload did not return the approved production origin.");
      }
      console.log(JSON.stringify(await verifyProductionOrigin(root, origin)));
      return;
    }
    if (!root || (variant !== "staging" && variant !== "production") || !receiptFile || extra.length) {
      throw new Error("Usage: verify-deployed-site.ts verify|receipt ROOT staging|production RECEIPT_RELATIVE_PATH");
    }
    const origin = variant === "production" ? productionSiteOrigin : process.env.STAGING_SITE_ORIGIN ?? "";
    if (command === "receipt") {
      validateAcceptanceReceipt(root, receiptFile, variant, origin);
    } else if (command === "verify") {
      if (receiptFile !== ".deployment/staging-acceptance.json" && receiptFile !== ".deployment/production-acceptance.json") {
        throw new Error("Live acceptance uses only the fixed metadata receipt paths.");
      }
      const receipt = await verifyDeployedSite(root, variant, origin);
      writeFileSync(path.join(root, receiptFile), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
      console.log(JSON.stringify(receipt));
    } else {
      throw new Error("Unknown live acceptance command.");
    }
  })().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Live acceptance failed.");
    process.exitCode = 1;
  });
}
