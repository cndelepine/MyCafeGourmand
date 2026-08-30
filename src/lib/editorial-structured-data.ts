import type { EditorialPageRecord, Locale } from "@/content/editorial-schema";
import type { GalleryRecord } from "@/content/gallery-schema";
import { resolveManagedMediaUrl } from "./recipe-media";
import { getEditorialPath, getEditorialSegments } from "./editorial-routes";
import { absoluteUrl, canonicalUrl } from "./site";
import { getLocaleHomePath } from "./recipe-routes";

type BreadcrumbItem = {
  "@type": "ListItem";
  item: string;
  name: string;
  position: number;
};

type BreadcrumbStructuredData = {
  "@type": "BreadcrumbList";
  itemListElement: BreadcrumbItem[];
};

type EditorialPageStructuredData = {
  "@type": "WebPage";
  "@id": string;
  description?: string;
  image?: string;
  inLanguage: Locale;
  name?: string;
  url: string;
  dateModified?: string;
  datePublished?: string;
};

type GalleryPageStructuredData = {
  "@type": "WebPage";
  "@id": string;
  description?: string;
  image?: string[];
  name?: string;
  url: string;
};

export type EditorialStructuredData = {
  "@context": "https://schema.org";
  "@graph": [EditorialPageStructuredData, BreadcrumbStructuredData];
};

export type GalleryStructuredData = {
  "@context": "https://schema.org";
  "@graph": [GalleryPageStructuredData, BreadcrumbStructuredData];
};

const homeLabels: Record<Locale, string> = {
  en: "Home",
  fr: "Accueil",
  ru: "Главная"
};

function pageName(record: EditorialPageRecord) {
  return record.title ?? undefined;
}

function editorialBreadcrumb(
  record: EditorialPageRecord,
  catalog: readonly EditorialPageRecord[]
) {
  const items: BreadcrumbItem[] = [{
    "@type": "ListItem",
    item: canonicalUrl(getLocaleHomePath(record.locale)),
    name: homeLabels[record.locale],
    position: 1
  }];
  const segments = getEditorialSegments(record);
  const localeSegments = record.locale === "en" ? [] : [record.locale];

  for (let index = 1; index < segments.length; index += 1) {
    const parentPath = `/${[...localeSegments, ...segments.slice(
      record.locale === "en" ? 0 : 1,
      index
    )].map(encodeURIComponent).join("/")}/`;
    const parent = catalog.find((candidate) =>
      getEditorialPath(candidate) === parentPath
    );
    if (parent?.title) {
      items.push({
        "@type": "ListItem",
        item: canonicalUrl(getEditorialPath(parent)),
        name: parent.title,
        position: items.length + 1
      });
    }
  }

  const name = pageName(record);
  if (name !== undefined) {
    items.push({
      "@type": "ListItem",
      item: canonicalUrl(getEditorialPath(record)),
      name,
      position: items.length + 1
    });
  }
  return {
    "@type": "BreadcrumbList",
    itemListElement: items
  } satisfies BreadcrumbStructuredData;
}

export function getEditorialStructuredData(
  record: EditorialPageRecord,
  catalog: readonly EditorialPageRecord[]
): EditorialStructuredData {
  const canonical = canonicalUrl(getEditorialPath(record));
  const featured = record.featuredMediaId === null
    ? undefined
    : record.media?.find((media) => media.id === record.featuredMediaId);
  return {
    "@context": "https://schema.org",
    "@graph": [{
      "@type": "WebPage",
      "@id": canonical,
      ...(record.excerpt === null ? {} : { description: record.excerpt }),
      ...(record.title === null ? {} : { name: record.title }),
      ...(featured === undefined
        ? {}
        : { image: absoluteUrl(resolveManagedMediaUrl(featured.path)) }),
      inLanguage: record.locale,
      url: canonical,
      ...(record.publishedAt === null ? {} : { datePublished: record.publishedAt }),
      ...(record.modifiedAt === null ? {} : { dateModified: record.modifiedAt })
    }, editorialBreadcrumb(record, catalog)]
  };
}

export function getGalleryStructuredData(record: GalleryRecord): GalleryStructuredData {
  const canonical = canonicalUrl(record.canonicalPath);
  return {
    "@context": "https://schema.org",
    "@graph": [{
      "@type": "WebPage",
      "@id": canonical,
      ...(record.description === null ? {} : { description: record.description }),
      ...(record.title === null ? {} : { name: record.title }),
      ...(record.images.length === 0
        ? {}
        : {
          image: record.images.map((image) => {
            const media = record.media?.find(
              (candidate) => candidate.id === image.originalMediaId
            );
            if (media === undefined) {
              throw new Error(`Gallery image media is missing: ${image.originalMediaId}`);
            }
            return absoluteUrl(resolveManagedMediaUrl(media.path));
          })
        }),
      url: canonical
    }, {
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          item: canonicalUrl("/"),
          name: homeLabels.en,
          position: 1
        },
        ...(record.title === null
          ? []
          : [{
            "@type": "ListItem" as const,
            item: canonical,
            name: record.title,
            position: 2
          }])
      ]
    }]
  };
}

export function serializeEditorialStructuredData(
  data: EditorialStructuredData | GalleryStructuredData
) {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
