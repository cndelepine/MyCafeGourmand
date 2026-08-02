import { validateContent } from "../src/content/validation";
import { redirects } from "../src/content/redirects";
import { createStaticWebAppConfig } from "../src/content/staticwebapp";
import { loadHandAuthoredStaticWebAppConfig } from "./staticwebapp-config";

const { records } = validateContent();
const config = createStaticWebAppConfig(records, {
  explicitRedirects: redirects,
  handAuthoredConfig: loadHandAuthoredStaticWebAppConfig()
});

console.log(
  `Validated ${records.length} recipe(s), ${redirects.length} explicit redirect(s), ` +
  `${config.routes.length} total Static Web Apps route rule(s).`
);
