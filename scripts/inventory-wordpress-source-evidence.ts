#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runWordPressSourceEvidenceProbe,
  SourceEvidenceError
} from "./wordpress/source-evidence";

export * from "./wordpress/source-evidence";
export * from "./wordpress/source-evidence-shape";
export * from "./wordpress/php-serialize";
export * from "./wordpress/sql-stream";

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  runWordPressSourceEvidenceProbe(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof SourceEvidenceError) {
      console.error(`Probe failed [${error.code}]`);
    } else {
      console.error("Probe failed [probe-failed]");
    }
    process.exitCode = 1;
  });
}
