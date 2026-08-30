import {
  validateCatalogBehavior,
  validateContent
} from "../src/content/validation";
import { createStaticWebAppConfig } from "../src/content/staticwebapp";
import { loadHandAuthoredStaticWebAppConfig } from "./staticwebapp-config";

const {
  editorialGalleryMediaManifest,
  editorialRecords,
  galleryRecords,
  publicBehavior,
  records
} = validateContent();
const summary = validateCatalogBehavior(records);
const config = createStaticWebAppConfig(records, {
  editorialRecords,
  galleryRecords,
  handAuthoredConfig: loadHandAuthoredStaticWebAppConfig()
});
const redirectCount = records.reduce(
  (count, record) => count + record.redirectFrom.length,
  0
) + editorialRecords.reduce(
  (count, record) => count + (record.redirectFrom?.length ?? 0),
  0
);

console.log(
  `Validated ${records.length} recipe(s) ` +
  `(en: ${summary.byLocale.en}, fr: ${summary.byLocale.fr}, ru: ${summary.byLocale.ru}), ` +
  `${summary.categoriesByLocale.en}/${summary.categoriesByLocale.fr}/${summary.categoriesByLocale.ru} ` +
  `editorial category archive(s), ` +
  `${summary.categoryMembershipsByLocale.en}/${summary.categoryMembershipsByLocale.fr}/` +
  `${summary.categoryMembershipsByLocale.ru} category membership(s), ` +
  `${summary.landingPagesByLocale.en}/${summary.landingPagesByLocale.fr}/` +
  `${summary.landingPagesByLocale.ru} landing page(s), ` +
  `${summary.categoryPagesByLocale.en}/${summary.categoryPagesByLocale.fr}/` +
  `${summary.categoryPagesByLocale.ru} category page(s), ` +
  `${summary.ids} ID(s), ${summary.localizedSlugs} localized slug(s), ` +
  `${summary.translationLinks} recipe translation link(s), ${editorialRecords.length} editorial ` +
  `page(s), ${galleryRecords.length} gallery, ${editorialGalleryMediaManifest.entries.length} ` +
  `editorial/gallery media object(s), ${publicBehavior.staticPaths} public static path(s), ` +
  `${publicBehavior.sitemapPaths} sitemap path(s), ${redirectCount} content redirect source(s), and ` +
  `${config.routes.length} ` +
  `total Static Web Apps route rule(s).`
);
