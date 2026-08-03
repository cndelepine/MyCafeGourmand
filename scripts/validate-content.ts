import { validateContent } from "../src/content/validation";
import { createStaticWebAppConfig } from "../src/content/staticwebapp";
import { loadHandAuthoredStaticWebAppConfig } from "./staticwebapp-config";

const { records } = validateContent();
const config = createStaticWebAppConfig(records, {
  handAuthoredConfig: loadHandAuthoredStaticWebAppConfig()
});
const redirectCount = records.reduce(
  (count, record) => count + record.redirectFrom.length,
  0
);

console.log(
  `Validated ${records.length} recipe(s), ${redirectCount} recipe redirect source(s), ` +
  `${config.routes.length} total Static Web Apps route rule(s).`
);
