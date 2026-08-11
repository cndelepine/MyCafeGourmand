#!/usr/bin/env node

import {
  recipeMediaBaseUrlEnvironmentVariable,
  requireRecipeMediaBaseUrl
} from "../src/lib/recipe-media";
import { validateContent } from "../src/content/validation";

try {
  requireRecipeMediaBaseUrl();
  const { records, mediaManifest } = validateContent();
  console.log(
    `Validated release media configuration for ${records.length} recipe(s) and ` +
    `${mediaManifest.entries.length} manifest object(s) using ` +
    `${recipeMediaBaseUrlEnvironmentVariable}.`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`release-media-validation-failed: ${message}`);
  process.exitCode = 1;
}
