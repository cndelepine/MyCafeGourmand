import Link from "next/link";
import { editorialCatalog } from "@/content/editorial-catalog";
import type { Locale } from "@/content/schema";
import {
  findEditorialContactPage,
  findEditorialLandingPage,
  getEditorialPath
} from "@/lib/editorial-routes";
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
  page: "editorial" | "gallery" | "landing" | "recipe";
  translations?: readonly SiteHeaderTranslation[];
};

const localeLabels: Record<Locale, string> = {
  en: "EN",
  fr: "FR",
  ru: "RU"
};

const navigationLabels: Record<Locale, {
  navigation: string;
  mobileNavigation: string;
  menu: string;
  languages: string;
  recipe: string;
  ingredients: string;
  method: string;
  recipes: string;
  gallery: string;
  contact: string;
}> = {
  en: {
    navigation: "Primary navigation",
    mobileNavigation: "Mobile navigation",
    menu: "Menu",
    languages: "Available languages",
    recipe: "Recipe",
    ingredients: "Ingredients",
    method: "Method",
    recipes: "Recipes",
    gallery: "Gallery",
    contact: "Contact"
  },
  fr: {
    navigation: "Navigation principale",
    mobileNavigation: "Navigation mobile",
    menu: "Menu",
    languages: "Langues disponibles",
    recipe: "Recette",
    ingredients: "Ingrédients",
    method: "Préparation",
    recipes: "Recettes",
    gallery: "Galerie",
    contact: "Contact"
  },
  ru: {
    navigation: "Основная навигация",
    mobileNavigation: "Мобильная навигация",
    menu: "Меню",
    languages: "Доступные языки",
    recipe: "Рецепт",
    ingredients: "Ингредиенты",
    method: "Приготовление",
    recipes: "Рецепты",
    gallery: "Галерея",
    contact: "Контакт"
  }
};

export function SiteHeader({ locale, page, translations }: SiteHeaderProps) {
  const labels = navigationLabels[locale];
  const contactPage = findEditorialContactPage(locale, editorialCatalog);
  const editorialLandingPage = findEditorialLandingPage(locale, editorialCatalog);
  const recipePath = page === "landing" ? "#recipes" : getLocaleHomePath(locale);
  const translationsByLocale = translations === undefined
    ? undefined
    : new Map(translations.map((translation) => [translation.locale, translation.path]));
  const siteLinks = (
    <>
      <Link href={recipePath}>{labels.recipes}</Link>
      {editorialLandingPage ? (
        <Link href={getEditorialPath(editorialLandingPage)}>
          {editorialLandingPage.title ?? labels.recipes}
        </Link>
      ) : null}
      <Link href="/gallery/">{labels.gallery}</Link>
      {contactPage ? (
        <Link href={getEditorialPath(contactPage)}>{contactPage.title ?? labels.contact}</Link>
      ) : null}
    </>
  );

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
        ) : null}
        {siteLinks}
      </nav>
      <details className="mobile-site-navigation">
        <summary>{labels.menu}</summary>
        <nav aria-label={labels.mobileNavigation}>
          {siteLinks}
        </nav>
      </details>
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
