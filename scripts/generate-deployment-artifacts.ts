#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createExactRedirectManifest,
  serializeExactRedirectManifest
} from "../src/content/redirect-manifest";
import {
  createStaticWebAppConfig,
  serializeStaticWebAppConfig
} from "../src/content/staticwebapp";
import { validateContent } from "../src/content/validation";
import { loadHandAuthoredStaticWebAppConfig } from "./staticwebapp-config";
import {
  deploymentMetadataDirectoryName,
  stagedDeploymentMetadataDirectoryName,
  previousDeploymentMetadataDirectoryName,
  removeManagedDirectory,
  validateManagedDirectory
} from "./deployment-metadata";
const redirectManifestFileName = "redirect-manifest.json";

function assertMetadataOutsideOutput(metadataRoot: string, outputRoot: string) {
  if (
    metadataRoot === outputRoot
    || metadataRoot.startsWith(`${outputRoot}${path.sep}`)
    || outputRoot.startsWith(`${metadataRoot}${path.sep}`)
  ) {
    throw new Error("Deployment metadata directory must be outside the static export.");
  }
}

function removeLegacyPublicRedirectManifest(outputRoot: string) {
  const legacyPath = path.join(outputRoot, redirectManifestFileName);
  if (!existsSync(legacyPath)) {
    return;
  }
  const stats = lstatSync(legacyPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(
      `Legacy public redirect manifest is not a regular file: "${legacyPath}"`
    );
  }
  rmSync(legacyPath);
}

function replaceDeploymentMetadata(
  projectRoot: string,
  outputRoot: string,
  redirectManifestContents: string
) {
  const metadataRoot = path.join(projectRoot, deploymentMetadataDirectoryName);
  const stagedRoot = path.join(projectRoot, stagedDeploymentMetadataDirectoryName);
  const previousRoot = path.join(projectRoot, previousDeploymentMetadataDirectoryName);
  assertMetadataOutsideOutput(metadataRoot, outputRoot);
  assertMetadataOutsideOutput(stagedRoot, outputRoot);
  assertMetadataOutsideOutput(previousRoot, outputRoot);

  removeManagedDirectory(stagedRoot, "Staged deployment metadata path");
  removeManagedDirectory(previousRoot, "Previous deployment metadata path");
  mkdirSync(stagedRoot);
  const stagedManifestPath = path.join(stagedRoot, redirectManifestFileName);
  writeFileSync(stagedManifestPath, redirectManifestContents, "utf8");

  let movedPrevious = false;
  try {
    if (existsSync(metadataRoot)) {
      validateManagedDirectory(metadataRoot, "Deployment metadata path");
      renameSync(metadataRoot, previousRoot);
      movedPrevious = true;
    }
    renameSync(stagedRoot, metadataRoot);
  } catch (error) {
    if (movedPrevious && !existsSync(metadataRoot) && existsSync(previousRoot)) {
      renameSync(previousRoot, metadataRoot);
    }
    removeManagedDirectory(stagedRoot, "Staged deployment metadata path");
    throw error;
  }
  if (movedPrevious) {
    removeManagedDirectory(previousRoot, "Previous deployment metadata path");
  }
  return path.join(metadataRoot, redirectManifestFileName);
}

export function generateDeploymentArtifacts(
  projectRoot: string = process.cwd(),
  outputDirectory = path.join(projectRoot, "out")
) {
  const root = path.resolve(projectRoot);
  const outputRoot = path.resolve(outputDirectory);
  const handAuthoredConfig = loadHandAuthoredStaticWebAppConfig(root);
  const {
    editorialRecords,
    galleryRecords,
    records
  } = validateContent({
    editorialGalleryMediaManifestPath: path.join(
      root,
      "content",
      "editorial-gallery-media-manifest.json"
    ),
    editorialRoot: path.join(root, "content", "editorial"),
    galleriesRoot: path.join(root, "content", "galleries"),
    mediaManifestPath: path.join(root, "content", "media-manifest.json"),
    publicRoot: path.join(root, "public"),
    recipesRoot: path.join(root, "content/recipes")
  });
  const redirectManifest = createExactRedirectManifest(
    records,
    editorialRecords,
    galleryRecords
  );
  const staticWebAppConfig = createStaticWebAppConfig(records, {
    editorialRecords,
    galleryRecords,
    handAuthoredConfig
  });
  const redirectManifestContents = serializeExactRedirectManifest(redirectManifest);
  const staticWebAppConfigContents = serializeStaticWebAppConfig(staticWebAppConfig);

  if (!existsSync(outputRoot)) {
    mkdirSync(outputRoot, { recursive: true });
  }
  const outputStats = lstatSync(outputRoot);
  if (outputStats.isSymbolicLink() || !outputStats.isDirectory()) {
    throw new Error(`Static export output is not a directory: "${outputRoot}"`);
  }

  const staticWebAppConfigPath = path.join(outputRoot, "staticwebapp.config.json");
  removeLegacyPublicRedirectManifest(outputRoot);
  writeFileSync(staticWebAppConfigPath, staticWebAppConfigContents, "utf8");
  const redirectManifestPath = replaceDeploymentMetadata(
    root,
    outputRoot,
    redirectManifestContents
  );
  return {
    redirectManifest,
    redirectManifestPath,
    staticWebAppConfig,
    staticWebAppConfigPath
  };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    const {
      redirectManifest,
      redirectManifestPath,
      staticWebAppConfigPath
    } = generateDeploymentArtifacts();
    console.log(
      `Generated ${redirectManifestPath} with ` +
      `${redirectManifest.redirects.length} exact redirect(s).`
    );
    console.log(`Generated ${staticWebAppConfigPath}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
