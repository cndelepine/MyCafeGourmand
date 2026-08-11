import Link from "next/link";
import type { Locale } from "@/content/schema";
import {
  getLocaleHomePath,
  supportedLocales
} from "@/lib/recipe-routes";

export type SiteHeaderTranslation = {
  readonly locale: Locale;
  readonly path: string;
};

type SiteHeaderProps = {
  locale: Locale;
  page: "landing" | "recipe";
  translations?: readonly SiteHeaderTranslation[];
};

const localeLabels: Record<Locale, string> = {
  en: "EN",
  fr: "FR",
  ru: "RU"
};

const navigationLabels: Record<Locale, {
  navigation: string;
  languages: string;
  recipe: string;
  ingredients: string;
  method: string;
  recipes: string;
}> = {
  en: {
    navigation: "Primary navigation",
    languages: "Available languages",
    recipe: "Recipe",
    ingredients: "Ingredients",
    method: "Method",
    recipes: "Recipes"
  },
  fr: {
    navigation: "Navigation principale",
    languages: "Langues disponibles",
    recipe: "Recette",
    ingredients: "Ingrédients",
    method: "Préparation",
    recipes: "Recettes"
  },
  ru: {
    navigation: "Основная навигация",
    languages: "Доступные языки",
    recipe: "Рецепт",
    ingredients: "Ингредиенты",
    method: "Приготовление",
    recipes: "Рецепты"
  }
};

export function SiteHeader({ locale, page, translations }: SiteHeaderProps) {
  const labels = navigationLabels[locale];
  const translationsByLocale = translations === undefined
    ? undefined
    : new Map(translations.map((translation) => [translation.locale, translation.path]));

  return (
    <header className="site-header" lang={locale}>
      <Link className="wordmark" href={getLocaleHomePath(locale)}>
        My Café Gourmand
      </Link>
      <nav aria-label={labels.navigation}>
        {page === "recipe" ? (
          <>
            <Link href="#recipe">{labels.recipe}</Link>
            <Link href="#ingredients">{labels.ingredients}</Link>
            <Link href="#method">{labels.method}</Link>
          </>
        ) : (
          <Link href="#recipes">{labels.recipes}</Link>
        )}
      </nav>
      <div className="languages" aria-label={labels.languages}>
        {supportedLocales.map((candidate) => {
          const translation = translationsByLocale?.get(candidate);
          const href = translations === undefined
            ? getLocaleHomePath(candidate)
            : translation;

          return href ? (
            <Link
              className={candidate === locale ? "active" : undefined}
              href={href}
              key={candidate}
            >
              {localeLabels[candidate]}
            </Link>
          ) : (
            <span
              aria-disabled="true"
              className={candidate === locale ? "active" : undefined}
              key={candidate}
            >
              {localeLabels[candidate]}
            </span>
          );
        })}
      </div>
    </header>
  );
}
