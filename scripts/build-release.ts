#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStaticBuild } from "./build-static";

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    if (process.argv.length !== 2) {
      throw new Error("Release build does not accept arguments.");
    }
    if (process.env.npm_lifecycle_event !== "build:release") {
      throw new Error("Release media configuration requires npm run build:release.");
    }
    runStaticBuild("release");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Release build failed.";
    console.error(`release-build-failed: ${message}`);
    process.exitCode = 1;
  }
}
