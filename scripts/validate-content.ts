import { validateContent } from "../src/content/validation";
import { redirects } from "../src/content/redirects";

const { records } = validateContent();

console.log(`Validated ${records.length} recipe(s) and ${redirects.length} redirect(s).`);
