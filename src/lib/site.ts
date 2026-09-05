import type { Metadata } from "next";
import { siteUrl } from "./site-origin";
import { recipeCatalog } from "@/content/catalog";
import type { RecipeCategory } from "@/content/categories";
import type { EditorialPageRecord } from "@/content/editorial-schema";
import type { GalleryRecord } from "@/content/gallery-schema";
import type { Locale, RecipeRecord } from "@/content/schema";
import { resolveManagedMediaUrl, resolveRecipeMediaUrl } from "./recipe-media";
import {
  getContactSuccessCopy,
  getContactSuccessPath
} from "./contact-routes";
import {
  getEditorialLanguageAlternates,
  getEditorialPath
} from "./editorial-routes";
import {
  getCategoryPagePath,
  getLandingPagePath,
  getLocaleHomePath,
  getRecipeLanguageAlternates,
  getRecipePath,
  supportedLocales
} from "./recipe-routes";

export { siteUrl } from "./site-origin";

export const siteName = "My Café Gourmand";
export const siteDescription =
  "A thoughtful collection of recipes from the family kitchen.";

export type OpenGraphLocale = "en_US" | "fr_FR" | "ru_RU";

const openGraphLocales: Record<Locale, OpenGraphLocale> = {
  en: "en_US",
  fr: "fr_FR",
  ru: "ru_RU"
};

export function getOpenGraphLocale(locale: Locale) {
  return openGraphLocales[locale];
}

export function absoluteUrl(path: string) {
  return new URL(path, siteUrl).toString();
}

export function canonicalUrl(path: string) {
  const url = new URL(path, siteUrl);
  if (path !== "/" && !path.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url.toString();
}

type LocaleLanguageLinks = Partial<Record<Locale, string>>;

function getLandingLanguageLinks(): LocaleLanguageLinks {
  const links: LocaleLanguageLinks = {};
  for (const locale of supportedLocales) {
    links[locale] = canonicalUrl(getLocaleHomePath(locale));
  }
  return links;
}

function getRecipeLanguageLinks(
  record: RecipeRecord,
  catalog: readonly RecipeRecord[]
): LocaleLanguageLinks {
  const links: LocaleLanguageLinks = {};
  for (const { locale, path } of getRecipeLanguageAlternates(record, catalog)) {
    links[locale] = canonicalUrl(path);
  }
  return links;
}

function getEditorialLanguageLinks(
  record: EditorialPageRecord,
  catalog: readonly EditorialPageRecord[]
): LocaleLanguageLinks {
  const links: LocaleLanguageLinks = {};
  for (const { locale, path } of getEditorialLanguageAlternates(record, catalog)) {
    links[locale] = canonicalUrl(path);
  }
  return links;
}

function getRecipeImage(record: RecipeRecord) {
  const hero = record.recipe.heroMediaId
    ? record.media.find((media) => media.id === record.recipe.heroMediaId)
    : undefined;

  if (!hero) {
    return undefined;
  }

  return {
    url: absoluteUrl(resolveRecipeMediaUrl(hero.path)),
    ...(hero.width === null ? {} : { width: hero.width }),
    ...(hero.height === null ? {} : { height: hero.height }),
    alt: hero.alt ?? undefined
  };
}

export function getRecipeMetadata(
  record: RecipeRecord,
  catalog: readonly RecipeRecord[] = recipeCatalog
): Metadata {
  const title = record.seo?.title ?? record.title;
  const description = record.seo?.description ?? record.description ?? undefined;
  const canonical = canonicalUrl(getRecipePath(record));
  const image = getRecipeImage(record);

  return {
    title,
    description,
    alternates: {
      canonical,
      languages: getRecipeLanguageLinks(record, catalog)
    },
    openGraph: {
      type: "article",
      title,
      description,
      url: canonical,
      siteName,
      locale: getOpenGraphLocale(record.locale),
      ...(image ? { images: [image] } : {})
    }
  };
}

export function getEditorialMetadata(
  record: EditorialPageRecord,
  catalog: readonly EditorialPageRecord[]
): Metadata {
  const title = record.title ?? undefined;
  const description = record.excerpt ?? undefined;
  const canonical = canonicalUrl(getEditorialPath(record));
  const featured = record.featuredMediaId === null
    ? undefined
    : record.media?.find((media) => media.id === record.featuredMediaId);
  const image = featured === undefined
    ? undefined
    : {
      url: absoluteUrl(resolveManagedMediaUrl(featured.path)),
      ...(featured.width === null ? {} : { width: featured.width }),
      ...(featured.height === null ? {} : { height: featured.height }),
      alt: record.featuredMediaAlt ?? undefined
    };

  return {
    title,
    description,
    alternates: {
      canonical,
      languages: getEditorialLanguageLinks(record, catalog)
    },
    openGraph: {
      type: "website",
      title,
      description,
      url: canonical,
      siteName,
      locale: getOpenGraphLocale(record.locale),
      ...(image ? { images: [image] } : {})
    }
  };
}

export function getGalleryMetadata(record: GalleryRecord): Metadata {
  const title = record.title ?? undefined;
  const description = record.description ?? undefined;
  const canonical = canonicalUrl(record.canonicalPath);
  const featured = record.featuredMediaId === null
    ? undefined
    : record.media?.find((media) => media.id === record.featuredMediaId);
  const image = featured === undefined
    ? undefined
    : {
      url: absoluteUrl(resolveManagedMediaUrl(featured.path)),
      ...(featured.width === null ? {} : { width: featured.width }),
      ...(featured.height === null ? {} : { height: featured.height })
    };

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      type: "website",
      title,
      description,
      url: canonical,
      siteName,
      locale: getOpenGraphLocale("en"),
      ...(image ? { images: [image] } : {})
    }
  };
}

export function getContactSuccessMetadata(locale: Locale): Metadata {
  const copy = getContactSuccessCopy(locale);
  const canonical = canonicalUrl(getContactSuccessPath(locale));

  return {
    title: copy.title,
    description: copy.message,
    alternates: { canonical },
    robots: {
      follow: true,
      index: false
    },
    openGraph: {
      title: copy.title,
      description: copy.message,
      url: canonical,
      siteName,
      locale: getOpenGraphLocale(locale)
    }
  };
}

const landingCopy: Record<
  Locale,
  {
    title: string;
    description: string;
    eyebrow: string;
    catalogEyebrow: string;
    catalogTitle: string;
    emptyCatalog: string;
    clearSearch: string;
    noSearchResults: string;
    searchLabel: string;
    searchPlaceholder: string;
    searchResults: string;
    loadingSearch: string;
    searchUnavailable: string;
    viewRecipe: string;
    footer: string;
    categoryDirectoryEyebrow: string;
    categoryDirectoryTitle: string;
    categoryArchiveEyebrow: string;
    categoryArchiveTitle: string;
    categoryDescription: (name: string, count: number) => string;
    categoryRecipeCount: (count: number) => string;
    backToCatalog: string;
    paginationNavigation: string;
    previousPage: string;
    nextPage: string;
    currentPage: (currentPage: number, totalPages: number) => string;
    landingPageTitle: (page: number) => string;
    categoryPageTitle: (name: string, page: number) => string;
  }
> = {
  en: {
    title: "Recipes from our family kitchen",
    description:
      "Simple, generous recipes made for sharing around the table.",
    eyebrow: "Welcome to My Café Gourmand",
    catalogEyebrow: "The catalog",
    catalogTitle: "Cook something generous.",
    emptyCatalog: "Recipes will appear here as they are approved.",
    clearSearch: "Clear",
    noSearchResults: "No recipes match your search.",
    searchLabel: "Search recipes",
    searchPlaceholder: "Search by title, ingredient, or method",
    searchResults: "recipes found",
    loadingSearch: "Loading all recipes…",
    searchUnavailable: "Search is temporarily unavailable. Browse with the page links below.",
    viewRecipe: "View recipe",
    footer: "Made with care, one recipe at a time.",
    categoryDirectoryEyebrow: "Browse by category",
    categoryDirectoryTitle: "Find a recipe for the table.",
    categoryArchiveEyebrow: "Category",
    categoryArchiveTitle: "Recipes in this category",
    categoryDescription: (name, count) =>
      `Browse ${count} ${count === 1 ? "recipe" : "recipes"} in ${name}.`,
    categoryRecipeCount: (count) => `${count} ${count === 1 ? "recipe" : "recipes"}`,
    backToCatalog: "All recipes",
    paginationNavigation: "Recipe pages",
    previousPage: "Previous",
    nextPage: "Next",
    currentPage: (currentPage, totalPages) => `Page ${currentPage} of ${totalPages}`,
    landingPageTitle: (page) => `Recipes from our family kitchen — Page ${page}`,
    categoryPageTitle: (name, page) => `${name} recipes — Page ${page}`
  },
  fr: {
    title: "Les recettes de notre cuisine familiale",
    description:
      "Des recettes simples et généreuses à partager autour de la table.",
    eyebrow: "Bienvenue chez My Café Gourmand",
    catalogEyebrow: "Le catalogue",
    catalogTitle: "Cuisinez quelque chose de généreux.",
    emptyCatalog: "Aucune recette n’est encore disponible dans cette langue.",
    clearSearch: "Effacer",
    noSearchResults: "Aucune recette ne correspond à votre recherche.",
    searchLabel: "Rechercher des recettes",
    searchPlaceholder: "Rechercher par titre, ingrédient ou préparation",
    searchResults: "recettes trouvées",
    loadingSearch: "Chargement de toutes les recettes…",
    searchUnavailable:
      "La recherche est temporairement indisponible. Parcourez les recettes avec les liens de page ci-dessous.",
    viewRecipe: "Voir la recette",
    footer: "Préparé avec soin, une recette à la fois.",
    categoryDirectoryEyebrow: "Parcourir par catégorie",
    categoryDirectoryTitle: "Trouvez une recette pour la table.",
    categoryArchiveEyebrow: "Catégorie",
    categoryArchiveTitle: "Recettes de cette catégorie",
    categoryDescription: (name, count) =>
      `Parcourez ${count} ${count === 1 ? "recette" : "recettes"} dans ${name}.`,
    categoryRecipeCount: (count) => `${count} ${count === 1 ? "recette" : "recettes"}`,
    backToCatalog: "Toutes les recettes",
    paginationNavigation: "Pages de recettes",
    previousPage: "Précédent",
    nextPage: "Suivant",
    currentPage: (currentPage, totalPages) => `Page ${currentPage} sur ${totalPages}`,
    landingPageTitle: (page) => `Les recettes de notre cuisine familiale — Page ${page}`,
    categoryPageTitle: (name, page) => `${name} — Page ${page}`
  },
  ru: {
    title: "Рецепты нашей семейной кухни",
    description:
      "Простые и щедрые рецепты для общего стола.",
    eyebrow: "Добро пожаловать в My Café Gourmand",
    catalogEyebrow: "Каталог",
    catalogTitle: "Приготовьте что-нибудь щедрое.",
    emptyCatalog: "На этом языке пока нет доступных рецептов.",
    clearSearch: "Очистить",
    noSearchResults: "Рецепты по вашему запросу не найдены.",
    searchLabel: "Поиск рецептов",
    searchPlaceholder: "Искать по названию, ингредиенту или способу",
    searchResults: "рецептов найдено",
    loadingSearch: "Загружаются все рецепты…",
    searchUnavailable:
      "Поиск временно недоступен. Просматривайте рецепты с помощью ссылок на страницы ниже.",
    viewRecipe: "Посмотреть рецепт",
    footer: "С заботой, по одному рецепту за раз.",
    categoryDirectoryEyebrow: "Поиск по категориям",
    categoryDirectoryTitle: "Найдите рецепт для общего стола.",
    categoryArchiveEyebrow: "Категория",
    categoryArchiveTitle: "Рецепты этой категории",
    categoryDescription: (name, count) =>
      `Просмотрите ${count} ${count === 1 ? "рецепт" : "рецептов"} в категории «${name}».`,
    categoryRecipeCount: (count) => `${count} ${count === 1 ? "рецепт" : "рецептов"}`,
    backToCatalog: "Все рецепты",
    paginationNavigation: "Страницы рецептов",
    previousPage: "Назад",
    nextPage: "Далее",
    currentPage: (currentPage, totalPages) => `Страница ${currentPage} из ${totalPages}`,
    landingPageTitle: (page) => `Рецепты нашей семейной кухни — Страница ${page}`,
    categoryPageTitle: (name, page) => `${name} — Страница ${page}`
  }
};

export function getLandingCopy(locale: Locale) {
  return landingCopy[locale];
}

export function getLandingMetadata(locale: Locale, page = 1): Metadata {
  const copy = getLandingCopy(locale);
  const canonical = canonicalUrl(getLandingPagePath(locale, page));
  const title = page === 1 ? copy.title : copy.landingPageTitle(page);

  return {
    title,
    description: copy.description,
    alternates: {
      canonical,
      ...(page === 1 ? { languages: getLandingLanguageLinks() } : {})
    },
    openGraph: {
      title,
      description: copy.description,
      url: canonical,
      siteName,
      locale: getOpenGraphLocale(locale)
    }
  };
}

export function getCategoryMetadata(
  category: RecipeCategory,
  page = 1
): Metadata {
  const copy = getLandingCopy(category.locale);
  const title = page === 1
    ? category.name
    : copy.categoryPageTitle(category.name, page);
  const description = copy.categoryDescription(category.name, category.recipes.length);
  const canonical = canonicalUrl(getCategoryPagePath(category, page));

  return {
    title,
    description,
    alternates: {
      canonical
    },
    openGraph: {
      title,
      description,
      url: canonical,
      siteName,
      locale: getOpenGraphLocale(category.locale)
    }
  };
}
