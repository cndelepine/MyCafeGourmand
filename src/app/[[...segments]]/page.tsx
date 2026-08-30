import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CategoryPage } from "@/components/category-page";
import { EditorialPage } from "@/components/editorial-page";
import { GalleryPage } from "@/components/gallery-page";
import { LandingPage } from "@/components/landing-page";
import { RecipeView } from "@/components/recipe-view";
import { ContactSuccessPage } from "@/components/contact-success-page";
import { recipeCatalog } from "@/content/catalog";
import { editorialCatalog } from "@/content/editorial-catalog";
import { galleryCatalog } from "@/content/gallery-catalog";
import {
  findContactSuccessLocale
} from "@/lib/contact-routes";
import {
  findEditorialBySegments,
  findGalleryBySegments
} from "@/lib/editorial-routes";
import {
  findCategoryBySegments,
  findLandingPageBySegments,
  findRecipeBySegments
} from "@/lib/recipe-routes";
import {
  getCategoryMetadata,
  getContactSuccessMetadata,
  getEditorialMetadata,
  getGalleryMetadata,
  getLandingMetadata,
  getRecipeMetadata
} from "@/lib/site";
import { getPublicStaticPageParams } from "@/lib/public-routes";

type StaticPathPageProps = {
  params: Promise<{ segments?: string[] }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
  return getPublicStaticPageParams(recipeCatalog, editorialCatalog, galleryCatalog);
}

export async function generateMetadata({
  params
}: StaticPathPageProps): Promise<Metadata> {
  const { segments: routeSegments } = await params;
  const segments = routeSegments ?? [];
  const successLocale = findContactSuccessLocale(segments);
  if (successLocale !== undefined) {
    return getContactSuccessMetadata(successLocale);
  }
  const editorial = findEditorialBySegments(segments, editorialCatalog);
  if (editorial) {
    return getEditorialMetadata(editorial, editorialCatalog);
  }
  const gallery = findGalleryBySegments(segments, galleryCatalog);
  if (gallery) {
    return getGalleryMetadata(gallery);
  }
  const landing = findLandingPageBySegments(segments, recipeCatalog);
  if (landing) {
    return getLandingMetadata(landing.locale, landing.page);
  }
  const category = findCategoryBySegments(segments, recipeCatalog);
  if (category) {
    return getCategoryMetadata(category.category, category.page);
  }

  const recipe = findRecipeBySegments(segments, recipeCatalog);
  if (recipe) {
    return getRecipeMetadata(recipe, recipeCatalog);
  }
  return {
    robots: {
      follow: false,
      index: false
    }
  };
}

export default async function StaticPathPage({
  params
}: StaticPathPageProps) {
  const { segments: routeSegments } = await params;
  const segments = routeSegments ?? [];
  const successLocale = findContactSuccessLocale(segments);
  if (successLocale !== undefined) {
    return <ContactSuccessPage locale={successLocale} />;
  }
  const editorial = findEditorialBySegments(segments, editorialCatalog);
  if (editorial) {
    return (
      <EditorialPage
        editorialCatalog={editorialCatalog}
        galleries={galleryCatalog}
        page={editorial}
        recipeCatalog={recipeCatalog}
      />
    );
  }
  const gallery = findGalleryBySegments(segments, galleryCatalog);
  if (gallery) {
    return <GalleryPage gallery={gallery} />;
  }
  const landing = findLandingPageBySegments(segments, recipeCatalog);
  if (landing) {
    return (
      <LandingPage
        catalog={recipeCatalog}
        locale={landing.locale}
        page={landing.page}
      />
    );
  }

  const category = findCategoryBySegments(segments, recipeCatalog);
  if (category) {
    return (
      <CategoryPage
        catalog={recipeCatalog}
        category={category.category}
        page={category.page}
      />
    );
  }

  const recipe = findRecipeBySegments(segments, recipeCatalog);
  if (recipe) {
    return <RecipeView catalog={recipeCatalog} recipe={recipe} />;
  }

  notFound();
}
