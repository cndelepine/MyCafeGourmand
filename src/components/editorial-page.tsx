import Image from "next/image";
import type { EditorialPageRecord } from "@/content/editorial-schema";
import type { GalleryRecord } from "@/content/gallery-schema";
import type { RecipeRecord } from "@/content/schema";
import { getEditorialGalleryMediaDimensions } from "@/content/editorial-media-manifest";
import {
  getEditorialStructuredData,
  serializeEditorialStructuredData
} from "@/lib/editorial-structured-data";
import { getEditorialTranslations, getEditorialPath } from "@/lib/editorial-routes";
import { resolveManagedMediaUrl } from "@/lib/recipe-media";
import { EditorialContent } from "./editorial-content";
import { SiteHeader } from "./site-header";

type EditorialPageProps = {
  readonly editorialCatalog: readonly EditorialPageRecord[];
  readonly galleries: readonly GalleryRecord[];
  readonly page: EditorialPageRecord;
  readonly recipeCatalog: readonly RecipeRecord[];
};

const copy = {
  en: {
    emptyCardGrid: "No published cards are available for this source category.",
    footer: "Made with care, one recipe at a time.",
    gallery: "View gallery",
    viewPage: "View page",
    viewRecipe: "View recipe"
  },
  fr: {
    emptyCardGrid: "Aucune carte publiée n’est disponible pour cette catégorie source.",
    footer: "Préparé avec soin, une recette à la fois.",
    gallery: "Voir la galerie",
    viewPage: "Voir la page",
    viewRecipe: "Voir la recette"
  },
  ru: {
    emptyCardGrid: "Для этой исходной категории пока нет опубликованных карточек.",
    footer: "С заботой, по одному рецепту за раз.",
    gallery: "Посмотреть галерею",
    viewPage: "Посмотреть страницу",
    viewRecipe: "Посмотреть рецепт"
  }
} as const;

export function EditorialPage({
  editorialCatalog,
  galleries,
  page,
  recipeCatalog
}: EditorialPageProps) {
  const labels = copy[page.locale];
  const structuredData = getEditorialStructuredData(page, editorialCatalog);
  const featured = page.featuredMediaId === null
    ? undefined
    : page.media?.find((media) => media.id === page.featuredMediaId);
  if (page.featuredMediaId !== null && featured === undefined) {
    throw new Error(`Validated editorial featured media is missing at render time: ${page.featuredMediaId}`);
  }
  const featuredWithDimensions = featured === undefined
    ? undefined
    : {
        media: featured,
        dimensions: getEditorialGalleryMediaDimensions(featured.path)
      };

  return (
    <>
      <SiteHeader
        locale={page.locale}
        page="editorial"
        translations={getEditorialTranslations(page, editorialCatalog).map((translation) => ({
          locale: translation.locale,
          path: getEditorialPath(translation)
        }))}
      />
      <main className="editorial-page" lang={page.locale}>
        <article>
          <header className="editorial-page-header">
            {page.title ? <h1>{page.title}</h1> : null}
            {page.excerpt ? <p className="intro">{page.excerpt}</p> : null}
            {featuredWithDimensions ? (
              <figure className="editorial-featured-figure">
                <Image
                  alt={page.featuredMediaAlt ?? ""}
                  className="editorial-featured-image"
                  height={featuredWithDimensions.dimensions.height}
                  priority
                  sizes="(max-width: 700px) 100vw, 820px"
                  src={resolveManagedMediaUrl(featuredWithDimensions.media.path)}
                  width={featuredWithDimensions.dimensions.width}
                />
              </figure>
            ) : null}
          </header>
          <EditorialContent
            editorialCatalog={editorialCatalog}
            galleries={galleries}
            labels={labels}
            page={page}
            recipeCatalog={recipeCatalog}
          />
        </article>
      </main>
      <footer lang={page.locale}>{labels.footer}</footer>
      <script type="application/ld+json">
        {serializeEditorialStructuredData(structuredData)}
      </script>
    </>
  );
}
