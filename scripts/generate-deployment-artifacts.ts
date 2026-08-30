#!/usr/bin/env node

import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
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
import { exactRedirectManifestPath } from "../src/lib/public-routes";
import { loadHandAuthoredStaticWebAppConfig } from "./staticwebapp-config";

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

  const redirectManifestOutputPath = path.join(
    outputRoot,
    exactRedirectManifestPath.slice(1)
  );
  const staticWebAppConfigPath = path.join(outputRoot, "staticwebapp.config.json");
  writeFileSync(redirectManifestOutputPath, redirectManifestContents, "utf8");
  writeFileSync(staticWebAppConfigPath, staticWebAppConfigContents, "utf8");
  return {
    redirectManifest,
    redirectManifestPath: redirectManifestOutputPath,
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
