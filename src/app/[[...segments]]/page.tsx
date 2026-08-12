import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CategoryPage } from "@/components/category-page";
import { LandingPage } from "@/components/landing-page";
import { RecipeView } from "@/components/recipe-view";
import { recipeCatalog } from "@/content/catalog";
import {
  findCategoryBySegments,
  findLandingPageBySegments,
  findRecipeBySegments,
  getStaticPageParams
} from "@/lib/recipe-routes";
import {
  getCategoryMetadata,
  getLandingMetadata,
  getRecipeMetadata
} from "@/lib/site";

type StaticPathPageProps = {
  params: Promise<{ segments?: string[] }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
  return getStaticPageParams(recipeCatalog);
}

export async function generateMetadata({
  params
}: StaticPathPageProps): Promise<Metadata> {
  const { segments: routeSegments } = await params;
  const segments = routeSegments ?? [];
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
