import type {
  CandidateUrl,
  InventoryIssue,
  SitemapSourceMetadata
} from "./types";

export function issue(
  code: InventoryIssue["code"],
  message: string,
  details: Pick<InventoryIssue, "source" | "url"> = {}
): InventoryIssue {
  return {
    code,
    message,
    ...details
  };
}

export function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareIssues(left: InventoryIssue, right: InventoryIssue) {
  return (
    compareStrings(left.code, right.code)
    || compareStrings(left.source ?? "", right.source ?? "")
    || compareStrings(left.url ?? "", right.url ?? "")
    || compareStrings(left.message, right.message)
  );
}

export function compareSourceMetadata(
  left: SitemapSourceMetadata,
  right: SitemapSourceMetadata
) {
  return (
    compareStrings(left.source, right.source)
    || compareStrings(left.fetchSource, right.fetchSource)
    || left.depth - right.depth
    || compareStrings(left.status, right.status)
  );
}

export function compareCandidates(left: CandidateUrl, right: CandidateUrl) {
  return (
    compareStrings(left.normalizedUrl, right.normalizedUrl)
    || compareStrings(left.sourceKey, right.sourceKey)
    || compareStrings(left.originalUrl, right.originalUrl)
  );
}

export function uniqueSorted(values: Iterable<string>) {
  return [...new Set(values)].sort(compareStrings);
}
