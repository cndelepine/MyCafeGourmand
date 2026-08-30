#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseDeploymentIntegration } from "../src/lib/release-deployment";
import { cleanDeploymentMetadata } from "./generate-deployment-artifacts";
import { runStaticBuild } from "./build-static";

export function runReleaseBuild(
  arguments_: readonly string[] = process.argv,
  environment: NodeJS.ProcessEnv = process.env,
  projectRoot: string = process.cwd()
) {
  const root = path.resolve(projectRoot);
  cleanDeploymentMetadata(root);
  if (arguments_.length !== 2) {
    throw new Error("Release build does not accept arguments.");
  }
  if (environment.npm_lifecycle_event !== "build:release") {
    throw new Error("Release media configuration requires npm run build:release.");
  }
  assertReleaseDeploymentIntegration();
  runStaticBuild("release", environment, root);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    runReleaseBuild();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Release build failed.";
    console.error(`release-build-failed: ${message}`);
    process.exitCode = 1;
  }
}
