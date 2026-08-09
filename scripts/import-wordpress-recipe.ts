#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  runWprmImportCli
} from "./import-wordpress-wprm";
export {
  runWprmBulkImport,
  serializeWprmManifest
} from "./wordpress/wprm-import-runner";
export {
  mapWprmRecipe,
  mapWprmRecipeCandidate,
  mapWprmToRecipeRecord,
  parseWprmQuantity,
  WprmMappingError
} from "./wordpress/wprm-import-map";
export {
  extractWprmSource,
  resolveWprmUploadArchives
} from "./wordpress/wprm-import-source";
export {
  fingerprintCandidate,
  readFingerprintKey,
  stageWprmCandidates
} from "./wordpress/wprm-import-stage";
export * from "./wordpress/wprm-import-contracts";

export async function runImporter(argv: readonly string[]) {
  for (const option of ["--recipe-id", "--slug", "--locale"]) {
    if (argv.includes(option) || argv.some((value) => value.startsWith(`${option}=`))) {
      throw new Error(`Legacy ${option} is not supported; use the WPRM bulk importer.`);
    }
  }
  return runWprmImportCli(argv);
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  runImporter(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "import-failed");
    process.exitCode = 1;
  });
}
