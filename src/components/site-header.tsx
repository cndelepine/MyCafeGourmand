import Link from "next/link";
import type { Locale, RecipeRecord } from "@/content/schema";
import {
  getLocaleHomePath,
  getRecipePath,
  getRecipeTranslations,
  supportedLocales
} from "@/lib/recipe-routes";

type SiteHeaderProps = {
  catalog?: readonly RecipeRecord[];
  locale: Locale;
  page: "landing" | "recipe";
  recipe?: RecipeRecord;
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

export function SiteHeader({ catalog, locale, page, recipe }: SiteHeaderProps) {
  const labels = navigationLabels[locale];
  const translations = recipe && catalog
    ? new Map(
        getRecipeTranslations(recipe, catalog).map((translation) => [
          translation.locale,
          translation
        ])
      )
    : undefined;

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
          const translation = translations?.get(candidate);
          const href = recipe
            ? translation
              ? getRecipePath(translation)
              : undefined
            : getLocaleHomePath(candidate);

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
