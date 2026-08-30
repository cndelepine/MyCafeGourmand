import type { MetadataRoute } from "next";
import { recipeCatalog } from "@/content/catalog";
import { editorialCatalog } from "@/content/editorial-catalog";
import { galleryCatalog } from "@/content/gallery-catalog";
import { getSitemapEntries } from "@/lib/site-map";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return getSitemapEntries(recipeCatalog, editorialCatalog, galleryCatalog);
}
