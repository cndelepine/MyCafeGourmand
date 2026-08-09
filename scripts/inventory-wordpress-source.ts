#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultSourceInventoryLimits,
  inventoryWordPressSource,
  runWordPressSourceInventory
} from "./wordpress/source-inventory";

export * from "./wordpress/source-inventory";
export * from "./wordpress/sql-stream";
export * from "./wordpress/uploads-inventory";
export { defaultSourceInventoryLimits };
export { inventoryWordPressSource, runWordPressSourceInventory };

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  runWordPressSourceInventory(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
