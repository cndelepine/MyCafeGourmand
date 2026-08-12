import type { RecipeCategory } from "@/content/categories";
import { absoluteUrl, canonicalUrl } from "./site";
import {
  getCategoryPagePath,
  getCategoryPath,
  getLocaleHomePath
} from "./recipe-routes";

export type CategoryBreadcrumbStructuredData = {
  "@context": "https://schema.org";
  "@type": "BreadcrumbList";
  itemListElement: Array<{
    "@type": "ListItem";
    item: string;
    name: string;
    position: number;
  }>;
};

type CategoryBreadcrumbLabels = {
  readonly home: string;
  readonly page: (page: number) => string;
};

export function getCategoryBreadcrumbStructuredData(
  category: RecipeCategory,
  page: number,
  labels: CategoryBreadcrumbLabels
): CategoryBreadcrumbStructuredData {
  const items: CategoryBreadcrumbStructuredData["itemListElement"] = [
    {
      "@type": "ListItem",
      item: absoluteUrl(getLocaleHomePath(category.locale)),
      name: labels.home,
      position: 1
    },
    {
      "@type": "ListItem",
      item: canonicalUrl(getCategoryPath(category)),
      name: category.name,
      position: 2
    }
  ];

  if (page > 1) {
    items.push({
      "@type": "ListItem",
      item: canonicalUrl(getCategoryPagePath(category, page)),
      name: labels.page(page),
      position: 3
    });
  }

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items
  };
}

export function serializeCategoryStructuredData(
  data: CategoryBreadcrumbStructuredData
) {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
