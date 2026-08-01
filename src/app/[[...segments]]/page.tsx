import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LandingPage } from "@/components/landing-page";
import { RecipeView } from "@/components/recipe-view";
import {
  findLandingLocaleBySegments,
  findRecipeBySegments,
  getPageLocale,
  getRecipesByLocale,
  getStaticPageParams
} from "@/lib/recipe-routes";
import { getLandingMetadata, getRecipeMetadata } from "@/lib/site";

type StaticPathPageProps = {
  params: Promise<{ segments?: string[] }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
  return getStaticPageParams();
}

export async function generateMetadata({
  params
}: StaticPathPageProps): Promise<Metadata> {
  const { segments: routeSegments } = await params;
  const segments = routeSegments ?? [];
  const locale = getPageLocale(segments);
  const landingLocale = findLandingLocaleBySegments(segments);

  if (segments.length === 0) {
    return getLandingMetadata("en");
  }
  if (landingLocale) {
    return getLandingMetadata(landingLocale);
  }

  const recipe = findRecipeBySegments(segments);
  return recipe ? getRecipeMetadata(recipe) : getLandingMetadata(locale);
}

export default async function StaticPathPage({
  params
}: StaticPathPageProps) {
  const { segments: routeSegments } = await params;
  const segments = routeSegments ?? [];

  if (segments.length === 0) {
    return (
      <LandingPage
        locale="en"
        recipes={getRecipesByLocale("en")}
      />
    );
  }

  const landingLocale = findLandingLocaleBySegments(segments);
  if (landingLocale) {
    return (
      <LandingPage
        locale={landingLocale}
        recipes={getRecipesByLocale(landingLocale)}
      />
    );
  }

  const recipe = findRecipeBySegments(segments);
  if (recipe) {
    return <RecipeView recipe={recipe} />;
  }

  notFound();
}
