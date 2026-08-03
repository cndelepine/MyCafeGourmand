#!/usr/bin/env node

import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateContent } from "../src/content/validation";
import {
  createStaticWebAppConfig,
  serializeStaticWebAppConfig
} from "../src/content/staticwebapp";
import { loadHandAuthoredStaticWebAppConfig } from "./staticwebapp-config";

export function generateStaticWebAppConfig(
  projectRoot: string = process.cwd(),
  outputDirectory = path.join(projectRoot, "out")
) {
  const root = path.resolve(projectRoot);
  const outputRoot = path.resolve(outputDirectory);
  const handAuthoredConfig = loadHandAuthoredStaticWebAppConfig(root);
  const { records } = validateContent({
    publicRoot: path.join(root, "public"),
    recipesRoot: path.join(root, "content/recipes")
  });
  const config = createStaticWebAppConfig(records, {
    handAuthoredConfig
  });

  if (!existsSync(outputRoot)) {
    mkdirSync(outputRoot, { recursive: true });
  }
  const outputStats = lstatSync(outputRoot);
  if (outputStats.isSymbolicLink() || !outputStats.isDirectory()) {
    throw new Error(`Static export output is not a directory: "${outputRoot}"`);
  }

  const outputPath = path.join(outputRoot, "staticwebapp.config.json");
  writeFileSync(outputPath, serializeStaticWebAppConfig(config), "utf8");
  return { outputPath, config };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    const { outputPath, config } = generateStaticWebAppConfig();
    const routes = Array.isArray(config.routes) ? config.routes.length : 0;
    console.log(`Generated ${outputPath} with ${routes} route rule(s).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
