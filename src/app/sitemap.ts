import type { MetadataRoute } from "next";
import { recipeCatalog } from "@/content/catalog";
import {
  getLocaleHomePath,
  getRecipeLanguageAlternates,
  getRecipePath,
  supportedLocales
} from "@/lib/recipe-routes";
import { absoluteUrl, canonicalUrl } from "@/lib/site";
import { resolveRecipeMediaUrl } from "@/lib/recipe-media";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const landingEntries = supportedLocales.map((locale) => ({
    url: canonicalUrl(getLocaleHomePath(locale)),
    alternates: {
      languages: Object.fromEntries(
        supportedLocales.map((alternateLocale) => [
          alternateLocale,
          canonicalUrl(getLocaleHomePath(alternateLocale))
        ])
      )
    }
  }));
  const recipeEntries = recipeCatalog.map((recipe) => {
    const hero = recipe.recipe.heroMediaId
      ? recipe.media.find((media) => media.id === recipe.recipe.heroMediaId)
      : undefined;
    const modified = recipe.source.modifiedAt ?? recipe.source.createdAt;

    return {
      url: canonicalUrl(getRecipePath(recipe)),
      ...(modified ? { lastModified: modified } : {}),
      alternates: {
        languages: Object.fromEntries(
          getRecipeLanguageAlternates(recipe, recipeCatalog).map(({ locale, path }) => [
            locale,
            canonicalUrl(path)
          ])
        )
      },
      ...(hero ? { images: [absoluteUrl(resolveRecipeMediaUrl(hero.path))] } : {})
    };
  });

  return [...landingEntries, ...recipeEntries];
}
