import type { Metadata } from "next";
import { recipeCatalog } from "@/content/catalog";
import type { Locale, RecipeRecord } from "@/content/schema";
import {
  getLocaleHomePath,
  getRecipeLanguageAlternates,
  getRecipePath,
  supportedLocales
} from "./recipe-routes";

export const siteName = "My Café Gourmand";
export const siteDescription =
  "A thoughtful collection of recipes from the family kitchen.";
export const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://mycafegourmand.com";

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

function getRecipeImage(record: RecipeRecord) {
  const hero = record.recipe.heroMediaId
    ? record.media.find((media) => media.id === record.recipe.heroMediaId)
    : undefined;

  if (!hero) {
    return undefined;
  }

  return {
    url: absoluteUrl(hero.path),
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

const landingCopy: Record<
  Locale,
  {
    title: string;
    description: string;
    eyebrow: string;
    catalogEyebrow: string;
    catalogTitle: string;
    emptyCatalog: string;
    viewRecipe: string;
    footer: string;
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
    viewRecipe: "View recipe",
    footer: "Made with care, one recipe at a time."
  },
  fr: {
    title: "Les recettes de notre cuisine familiale",
    description:
      "Des recettes simples et généreuses à partager autour de la table.",
    eyebrow: "Bienvenue chez My Café Gourmand",
    catalogEyebrow: "Le catalogue",
    catalogTitle: "Cuisinez quelque chose de généreux.",
    emptyCatalog: "Aucune recette n’est encore disponible dans cette langue.",
    viewRecipe: "Voir la recette",
    footer: "Préparé avec soin, une recette à la fois."
  },
  ru: {
    title: "Рецепты нашей семейной кухни",
    description:
      "Простые и щедрые рецепты для общего стола.",
    eyebrow: "Добро пожаловать в My Café Gourmand",
    catalogEyebrow: "Каталог",
    catalogTitle: "Приготовьте что-нибудь щедрое.",
    emptyCatalog: "На этом языке пока нет доступных рецептов.",
    viewRecipe: "Посмотреть рецепт",
    footer: "С заботой, по одному рецепту за раз."
  }
};

export function getLandingCopy(locale: Locale) {
  return landingCopy[locale];
}

export function getLandingMetadata(locale: Locale): Metadata {
  const copy = getLandingCopy(locale);
  const canonical = canonicalUrl(getLocaleHomePath(locale));

  return {
    title: copy.title,
    description: copy.description,
    alternates: {
      canonical,
      languages: getLandingLanguageLinks()
    },
    openGraph: {
      title: copy.title,
      description: copy.description,
      url: canonical,
      siteName,
      locale: getOpenGraphLocale(locale)
    }
  };
}
