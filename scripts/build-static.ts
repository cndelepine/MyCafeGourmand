#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRecipeMediaBuildEnvironment,
  familyTestBuildModeEnvironmentVariable,
  recipeMediaReleaseBuildModeEnvironmentVariable,
  type RecipeMediaBuildMode
} from "../src/lib/recipe-media";
import { cleanDeploymentMetadata } from "./deployment-metadata";
import { assertReleaseDeploymentIntegration } from "../src/lib/release-deployment";
import { productionSiteOrigin } from "./legacy-navigation";
import { writeReleaseArtifactMetadata } from "./release-artifact";
import { writeFamilyTestArtifact } from "./family-test-artifact";
import { validateSiteOrigin } from "./verify-deployed-site";

function command(name: string) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  workingDirectory: string
) {
  const result = spawnSync(executable, arguments_, {
    cwd: workingDirectory,
    env: environment,
    shell: process.platform === "win32",
    stdio: "inherit"
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Static build command failed: ${executable}.`);
  }
}

function nextExecutable(projectRoot: string) {
  return path.join(
    projectRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "next.cmd" : "next"
  );
}

export function createReleaseBuildEnvironment(environment: NodeJS.ProcessEnv) {
  if (Object.hasOwn(environment, recipeMediaReleaseBuildModeEnvironmentVariable)
    || Object.hasOwn(environment, familyTestBuildModeEnvironmentVariable)
    || Object.hasOwn(environment, "FAMILY_TEST_SITE_ORIGIN")) {
    throw new Error("Release build mode is reserved for the guarded release command.");
  }

  if (
    environment.NEXT_PUBLIC_SITE_URL !== undefined
    && environment.NEXT_PUBLIC_SITE_URL !== productionSiteOrigin
  ) {
    throw new Error(`Release canonical origin must be ${productionSiteOrigin}.`);
  }
  return {
    ...environment,
    NEXT_PUBLIC_SITE_URL: productionSiteOrigin,
    [recipeMediaReleaseBuildModeEnvironmentVariable]: "1"
  };
}

export function createFamilyTestBuildEnvironment(environment: NodeJS.ProcessEnv) {
  if (environment.npm_lifecycle_event !== "build:family-test"
    || Object.hasOwn(environment, familyTestBuildModeEnvironmentVariable)
    || Object.hasOwn(environment, recipeMediaReleaseBuildModeEnvironmentVariable)) {
    throw new Error("Family test build requires its guarded command without reserved build flags.");
  }
  validateSiteOrigin(environment.FAMILY_TEST_SITE_ORIGIN ?? "", "staging");
  if (environment.NEXT_PUBLIC_SITE_URL !== undefined && environment.NEXT_PUBLIC_SITE_URL !== productionSiteOrigin) {
    throw new Error("Family test canonical metadata must retain the production origin.");
  }
  return {
    ...environment,
    NEXT_PUBLIC_SITE_URL: productionSiteOrigin,
    [familyTestBuildModeEnvironmentVariable]: "1"
  };
}

export function runWithDeploymentMetadataInvalidation<T>(
  operation: () => T,
  projectRoot: string = process.cwd()
) {
  const root = path.resolve(projectRoot);
  cleanDeploymentMetadata(root);
  try {
    return operation();
  } catch (error) {
    try {
      cleanDeploymentMetadata(root);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Static build failed and deployment metadata could not be invalidated."
      );
    }
    throw error;
  }
}

export function runStaticBuild(
  mode: RecipeMediaBuildMode,
  environment: NodeJS.ProcessEnv = process.env,
  projectRoot: string = process.cwd()
) {
  const root = path.resolve(projectRoot);
  return runWithDeploymentMetadataInvalidation(() => {
    if (mode === "non-release") {
      assertRecipeMediaBuildEnvironment(mode, environment);
      const buildEnvironment = { ...environment };
      delete buildEnvironment[recipeMediaReleaseBuildModeEnvironmentVariable];
      run(command("npm"), ["run", "content:validate"], buildEnvironment, root);
      run(command("npm"), ["run", "search:generate"], buildEnvironment, root);
      run(nextExecutable(root), ["build"], buildEnvironment, root);
      run(command("npm"), ["run", "deployment:generate"], buildEnvironment, root);
      return;
    }

    const buildEnvironment: NodeJS.ProcessEnv = mode === "family-test"
      ? createFamilyTestBuildEnvironment(environment) : createReleaseBuildEnvironment(environment);
    assertRecipeMediaBuildEnvironment(mode, buildEnvironment);
    run(command("npm"), ["run", "release:validate"], buildEnvironment, root);
    run(command("npm"), ["run", "content:validate"], buildEnvironment, root);
    run(command("npm"), ["run", "search:generate"], buildEnvironment, root);
    run(nextExecutable(root), ["build"], buildEnvironment, root);
    run(command("npm"), ["run", "deployment:generate"], buildEnvironment, root);
    assertRecipeMediaBuildEnvironment(mode, buildEnvironment);
    run(command("npm"), ["run", "release:validate-output"], buildEnvironment, root);
    assertRecipeMediaBuildEnvironment(mode, buildEnvironment);
    assertReleaseDeploymentIntegration(root);
    if (mode === "family-test") {
      writeFamilyTestArtifact(root, buildEnvironment.FAMILY_TEST_SITE_ORIGIN ?? "",
        buildEnvironment.NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL ?? "");
    } else {
      writeReleaseArtifactMetadata(root);
    }
  }, root);
}

export function runNonReleaseBuild(
  arguments_: readonly string[] = process.argv,
  environment: NodeJS.ProcessEnv = process.env,
  projectRoot: string = process.cwd()
) {
  const root = path.resolve(projectRoot);
  cleanDeploymentMetadata(root);
  if (arguments_.length !== 2) {
    throw new Error("Static build does not accept arguments.");
  }
  runStaticBuild("non-release", environment, root);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    runNonReleaseBuild();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Static build failed.";
    console.error(`static-build-failed: ${message}`);
    process.exitCode = 1;
  }
}
