import type { EditorialPageRecord, Locale } from "@/content/editorial-schema";
import { galleryCanonicalPath, type GalleryRecord } from "@/content/gallery-schema";
import { localPathKey, validateSafeLocalPath } from "@/content/url-path";

export type EditorialRouteParams = {
  readonly segments: string[];
};

function canonicalPathFromSegments(segments: readonly string[]) {
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    return undefined;
  }
  const candidate = `/${segments.join("/")}/`;
  try {
    validateSafeLocalPath(candidate, "Editorial route");
    return candidate;
  } catch {
    return undefined;
  }
}

function canonicalPathSegments(canonicalPath: string) {
  validateSafeLocalPath(canonicalPath, "Editorial canonical route");
  const segments = canonicalPath.split("/").slice(1, -1);
  if (segments.length === 0) {
    throw new Error("Editorial canonical route cannot be the site root.");
  }
  return segments;
}

export function getEditorialSegments(record: EditorialPageRecord) {
  return canonicalPathSegments(record.canonicalPath);
}

export function getEditorialPath(record: EditorialPageRecord) {
  return `/${getEditorialSegments(record).map(encodeURIComponent).join("/")}/`;
}

export function getEditorialStaticParams(
  records: readonly EditorialPageRecord[]
): EditorialRouteParams[] {
  return records.map((record) => ({ segments: getEditorialSegments(record) }));
}

export function findEditorialBySegments(
  segments: readonly string[],
  records: readonly EditorialPageRecord[]
) {
  const candidate = canonicalPathFromSegments(segments);
  if (candidate === undefined) {
    return undefined;
  }
  const key = localPathKey(candidate);
  return records.find((record) =>
    localPathKey(record.canonicalPath) === key
  );
}

export function getEditorialTranslations(
  record: EditorialPageRecord,
  records: readonly EditorialPageRecord[]
) {
  if (record.translationGroupId === null) {
    return [record];
  }
  return records.filter(
    (candidate) => candidate.translationGroupId === record.translationGroupId
  );
}

export function getEditorialLanguageAlternates(
  record: EditorialPageRecord,
  records: readonly EditorialPageRecord[]
) {
  return getEditorialTranslations(record, records).map((translation) => ({
    locale: translation.locale,
    path: getEditorialPath(translation)
  }));
}

export function findEditorialContactPage(
  locale: Locale,
  records: readonly EditorialPageRecord[]
) {
  return records.find((record) =>
    record.locale === locale
    && record.content?.some((block) => block.type === "contactForm")
  );
}

export function findEditorialLandingPage(
  locale: Locale,
  records: readonly EditorialPageRecord[]
) {
  return records.find((record) =>
    record.locale === locale
    && record.content?.some((block) => block.type === "editorialPageCardGrid")
  );
}

export function getGalleryStaticParams(
  records: readonly GalleryRecord[]
): EditorialRouteParams[] {
  return records.map((record) => ({
    segments: canonicalPathSegments(record.canonicalPath)
  }));
}

export function findGalleryBySegments(
  segments: readonly string[],
  records: readonly GalleryRecord[]
) {
  const candidate = canonicalPathFromSegments(segments);
  if (candidate === undefined || localPathKey(candidate) !== localPathKey(galleryCanonicalPath)) {
    return undefined;
  }
  return records.find((record) =>
    localPathKey(record.canonicalPath) === localPathKey(candidate)
  );
}
