import {
  validateCatalogBehavior,
  validateContent
} from "../src/content/validation";
import { createStaticWebAppConfig } from "../src/content/staticwebapp";
import { loadHandAuthoredStaticWebAppConfig } from "./staticwebapp-config";

const { records } = validateContent();
const summary = validateCatalogBehavior(records);
const config = createStaticWebAppConfig(records, {
  handAuthoredConfig: loadHandAuthoredStaticWebAppConfig()
});
const redirectCount = records.reduce(
  (count, record) => count + record.redirectFrom.length,
  0
);

console.log(
  `Validated ${records.length} recipe(s) ` +
  `(en: ${summary.byLocale.en}, fr: ${summary.byLocale.fr}, ru: ${summary.byLocale.ru}), ` +
  `${summary.ids} ID(s), ${summary.localizedSlugs} localized slug(s), ` +
  `${summary.translationLinks} translation link(s), ${summary.staticPaths} static path(s), ` +
  `${redirectCount} recipe redirect source(s), and ${config.routes.length} ` +
  `total Static Web Apps route rule(s).`
);
