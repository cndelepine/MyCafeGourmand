import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseExactRedirectManifest } from "../src/content/redirect-manifest";
import { portablePathComponentKey } from "../src/content/url-path";
import { productionSiteOrigin, validateLegacyNavigationOutput } from "./legacy-navigation";
import { readBoundedDeploymentFile, writeNewDeploymentFile } from "./deployment-files";

const configName = "staticwebapp.config.json";
const metadataName = ".deployment/release-artifact.json";
const manifestName = ".deployment/redirect-manifest.json";
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const fileSchema = z.object({
  path: z.string().min(1).max(4_096),
  bytes: z.number().int().nonnegative().max(250 * 1024 * 1024),
  sha256: digestSchema
}).strict();
const artifactSchema = z.object({
  schemaVersion: z.literal(1),
  artifactClass: z.literal("production"),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  canonicalOrigin: z.literal("https://mycafegourmand.com"),
  configurationDigest: digestSchema,
  manifestDigest: digestSchema,
  legacyPageCount: z.number().int().nonnegative().max(15_000),
  contentDigest: digestSchema,
  productionConfig: z.string().max(20_000),
  productionConfigDigest: digestSchema,
  stagingConfigDigest: digestSchema,
  files: z.array(fileSchema).min(1).max(15_000)
}).strict();
export type ReleaseArtifact = z.infer<typeof artifactSchema>;
export type DeploymentVariant = "production" | "staging";

export function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function regularDirectory(directory: string) {
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Artifact directories must be regular directories.");
  }
}

export function readBoundedFile(root: string, relative: string, maximum = 8 * 1024 * 1024) {
  return readBoundedDeploymentFile(root, relative, maximum);
}

export function inventoryOutput(output: string) {
  regularDirectory(output);
  const files: z.infer<typeof fileSchema>[] = [];
  let bytes = 0;
  const portableNames = new Set<string>();
  const visit = (directory: string, prefix: string, depth: number) => {
    if (depth > 40) throw new Error("Artifact directory nesting exceeds limit.");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      const key = relative.split("/").map((part) =>
        portablePathComponentKey(part, "Artifact path")
      ).join("/");
      if (portableNames.has(key)) throw new Error("Artifact has portable path collisions.");
      portableNames.add(key);
      const full = path.join(directory, entry.name);
      const stats = lstatSync(full);
      if (stats.isSymbolicLink()) throw new Error("Artifact contains a symlink.");
      if (stats.isDirectory()) {
        visit(full, `${relative}/`, depth + 1);
      } else {
        if (!stats.isFile() || stats.nlink !== 1) throw new Error("Artifact contains a nonregular file.");
        if (stats.size > 250 * 1024 * 1024 - bytes || files.length >= 15_000) {
          throw new Error("Artifact exceeds Azure Free output limits.");
        }
        const contents = readBoundedFile(output, relative, 250 * 1024 * 1024 - bytes);
        bytes += contents.length;
        files.push({ path: relative, bytes: contents.length, sha256: sha256(contents) });
      }
    }
  };
  visit(output, "", 0);
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

const headersSchema = z.record(z.string(), z.string());
const configSchema = z.object({
  globalHeaders: headersSchema
}).passthrough();

export function stagingConfig(production: string) {
  if (Buffer.byteLength(production) > 20_000) throw new Error("Origin configuration exceeds 20,000 bytes.");
  const config = configSchema.parse(JSON.parse(production));
  // Unknown CSP or route-level overrides require a reviewed adapter, not erasure.
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach((child) => inspect(child));
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        const lower = key.toLowerCase();
        if (lower.startsWith("content-security-policy") || lower === "x-robots-tag") {
          throw new Error("Unsupported production staging-policy headers.");
        }
        inspect(child);
      }
    }
  };
  inspect(config);
  const result = `${JSON.stringify({
    ...config,
    globalHeaders: {
      ...config.globalHeaders,
      "X-Robots-Tag": "noindex",
      "Content-Security-Policy": "form-action 'none'"
    }
  }, null, 2)}\n`;
  if (Buffer.byteLength(result) > 20_000) throw new Error("Staging configuration exceeds 20,000 bytes.");
  return result;
}

function contentDigest(files: ReleaseArtifact["files"]) {
  return sha256(JSON.stringify(files.filter((file) => file.path !== configName)));
}

export function writeReleaseArtifactMetadata(projectRoot: string) {
  const root = path.resolve(projectRoot);
  const manifestBytes = readBoundedFile(root, manifestName, 4 * 1024 * 1024);
  const manifest = parseExactRedirectManifest(JSON.parse(manifestBytes.toString()));
  validateLegacyNavigationOutput(manifest, path.join(root, "out"));
  const productionConfig = readBoundedFile(root, `out/${configName}`, 20_000).toString();
  const files = inventoryOutput(path.join(root, "out"));
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const configuration = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key.startsWith("NEXT_PUBLIC_"))
    .sort(([left], [right]) => left.localeCompare(right)));
  const metadata = artifactSchema.parse({
    schemaVersion: 1,
    artifactClass: "production",
    sourceCommit,
    canonicalOrigin: productionSiteOrigin,
    configurationDigest: sha256(JSON.stringify(configuration)),
    manifestDigest: sha256(manifestBytes),
    legacyPageCount: manifest.redirects.length,
    contentDigest: contentDigest(files),
    productionConfig,
    productionConfigDigest: sha256(productionConfig),
    stagingConfigDigest: sha256(stagingConfig(productionConfig)),
    files
  });
  const target = path.join(root, metadataName);
  writeNewDeploymentFile(target, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

export function validateReleaseArtifact(root: string, variant: DeploymentVariant, expectedCommit?: string) {
  const metadataBytes = readBoundedFile(root, metadataName);
  const metadata = artifactSchema.parse(JSON.parse(metadataBytes.toString()));
  if (expectedCommit !== undefined && metadata.sourceCommit !== expectedCommit) {
    throw new Error("Artifact source commit does not match trusted workflow provenance.");
  }
  const stage = stagingConfig(metadata.productionConfig);
  if (sha256(metadata.productionConfig) !== metadata.productionConfigDigest
    || sha256(stage) !== metadata.stagingConfigDigest
    || contentDigest(metadata.files) !== metadata.contentDigest) {
    throw new Error("Artifact metadata digests do not match.");
  }
  const expectedConfig = variant === "production" ? metadata.productionConfig : stage;
  const actualFiles = inventoryOutput(path.join(root, "out"));
  const expectedFiles = metadata.files.map((file) => file.path === configName ? {
    path: file.path, bytes: Buffer.byteLength(expectedConfig), sha256: sha256(expectedConfig)
  } : file);
  if (!metadata.files.some((file) => file.path === configName
    && file.sha256 === metadata.productionConfigDigest
    && file.bytes === Buffer.byteLength(metadata.productionConfig))
    || JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("Artifact inventory mismatch: missing, additional, modified, or unsafe output.");
  }
  const manifestBytes = readBoundedFile(root, manifestName, 4 * 1024 * 1024);
  if (sha256(manifestBytes) !== metadata.manifestDigest) throw new Error("Legacy manifest digest mismatch.");
  const manifest = parseExactRedirectManifest(JSON.parse(manifestBytes.toString()));
  if (manifest.redirects.length !== metadata.legacyPageCount) throw new Error("Legacy coverage count mismatch.");
  validateLegacyNavigationOutput(manifest, path.join(root, "out"));
  return { metadata, manifest, artifactDigest: sha256(metadataBytes) };
}

export function prepareStagingArtifact(productionRoot: string, stagingRoot: string) {
  const production = path.resolve(productionRoot);
  const staging = path.resolve(stagingRoot);
  if (staging === production || staging.startsWith(`${production}${path.sep}`)
    || production.startsWith(`${staging}${path.sep}`) || existsSync(staging)) {
    throw new Error("Staging requires a new, isolated sibling workspace.");
  }
  regularDirectory(path.dirname(staging));
  const { metadata } = validateReleaseArtifact(production, "production");
  mkdirSync(staging);
  mkdirSync(path.join(staging, "out"));
  mkdirSync(path.join(staging, ".deployment"));
  for (const file of metadata.files) {
    if (file.path === configName) continue;
    const target = path.join(staging, "out", file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(production, "out", file.path), target);
  }
  for (const name of [metadataName, manifestName]) {
    copyFileSync(path.join(production, name), path.join(staging, name));
  }
  writeNewDeploymentFile(path.join(staging, "out", configName), stagingConfig(metadata.productionConfig));
  validateReleaseArtifact(staging, "staging", metadata.sourceCommit);
  validateReleaseArtifact(production, "production", metadata.sourceCommit);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    const [command, root, argument, commit, ...extra] = process.argv.slice(2);
    if (command === "validate" && root && (argument === "production" || argument === "staging") && extra.length === 0) {
      const result = validateReleaseArtifact(root, argument, commit);
      console.log(JSON.stringify({ artifactDigest: result.artifactDigest, sourceCommit: result.metadata.sourceCommit }));
    } else if (command === "prepare-staging" && root && argument && !commit && extra.length === 0) {
      prepareStagingArtifact(root, argument);
    } else {
      throw new Error("Usage: release-artifact.ts validate ROOT production|staging [EXPECTED_SHA] | prepare-staging PRODUCTION_ROOT NEW_STAGING_ROOT");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Artifact validation failed.");
    process.exitCode = 1;
  }
}
