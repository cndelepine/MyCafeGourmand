import { globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const config = [
  globalIgnores(["drive-download-*/**"]),
  ...nextVitals,
  ...nextTypeScript
];

export default config;
