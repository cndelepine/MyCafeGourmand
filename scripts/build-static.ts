#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRecipeMediaBuildEnvironment,
  recipeMediaReleaseBuildModeEnvironmentVariable,
  type RecipeMediaBuildMode
} from "../src/lib/recipe-media";

function command(name: string) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv
) {
  const result = spawnSync(executable, arguments_, {
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit"
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Static build command failed: ${executable}.`);
  }
}

function nextExecutable() {
  return path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "next.cmd" : "next"
  );
}

export function runStaticBuild(
  mode: RecipeMediaBuildMode,
  environment: NodeJS.ProcessEnv = process.env
) {
  if (mode === "non-release") {
    assertRecipeMediaBuildEnvironment(mode, environment);
    const buildEnvironment = { ...environment };
    delete buildEnvironment[recipeMediaReleaseBuildModeEnvironmentVariable];
    run(command("npm"), ["run", "content:validate"], buildEnvironment);
    run(command("npm"), ["run", "search:generate"], buildEnvironment);
    run(nextExecutable(), ["build"], buildEnvironment);
    run(command("npm"), ["run", "staticwebapp:generate"], buildEnvironment);
    return;
  }

  if (Object.hasOwn(environment, recipeMediaReleaseBuildModeEnvironmentVariable)) {
    throw new Error("Release build mode is reserved for the guarded release command.");
  }
  const buildEnvironment = {
    ...environment,
    [recipeMediaReleaseBuildModeEnvironmentVariable]: "1"
  };
  assertRecipeMediaBuildEnvironment(mode, buildEnvironment);
  run(command("npm"), ["run", "release:validate"], buildEnvironment);
  run(command("npm"), ["run", "content:validate"], buildEnvironment);
  run(command("npm"), ["run", "search:generate"], buildEnvironment);
  run(nextExecutable(), ["build"], buildEnvironment);
  run(command("npm"), ["run", "staticwebapp:generate"], buildEnvironment);
  assertRecipeMediaBuildEnvironment(mode, buildEnvironment);
  run(command("npm"), ["run", "release:validate-output"], buildEnvironment);
  assertRecipeMediaBuildEnvironment(mode, buildEnvironment);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    if (process.argv.length !== 2) {
      throw new Error("Static build does not accept arguments.");
    }
    runStaticBuild("non-release");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Static build failed.";
    console.error(`static-build-failed: ${message}`);
    process.exitCode = 1;
  }
}
