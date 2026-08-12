import type { MetadataRoute } from "next";
import { recipeCatalog } from "@/content/catalog";
import { getSitemapEntries } from "@/lib/site-map";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return getSitemapEntries(recipeCatalog);
}
