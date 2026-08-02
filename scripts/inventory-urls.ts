#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runUrlInventory } from "./url-inventory/cli";

export * from "./url-inventory/types";
export { defaultInventoryLimits } from "./url-inventory/constants";
export { compareDiscoveredPaths, compareInventoryPaths, compareInventoryToCatalog } from "./url-inventory/comparison";
export { parseSitemapDocument } from "./url-inventory/xml";
export {
  normalizeRecordUrl,
  rewriteWaybackChildSource
} from "./url-inventory/sources";
export { inventorySitemaps, inventoryUrls } from "./url-inventory/traverse";
export { installInventoryTempFile } from "./url-inventory/output";
export { runUrlInventory };

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  runUrlInventory(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
