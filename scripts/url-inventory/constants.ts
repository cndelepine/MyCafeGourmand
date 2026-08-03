import type { InventoryLimits } from "./types";

export const allowedRecordHosts = new Set([
  "mycafegourmand.com",
  "www.mycafegourmand.com"
]);

export const allowedLiveSitemapHosts = allowedRecordHosts;
export const waybackHost = "web.archive.org";
export const maxRedirects = 3;

export const defaultInventoryLimits = {
  maxDepth: 5,
  maxDocuments: 100,
  maxUrls: 10_000,
  maxDocumentBytes: 5_000_000,
  requestTimeoutMs: 30_000
} as const satisfies InventoryLimits;
