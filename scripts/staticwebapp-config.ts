import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

function existingFile(filePath: string) {
  try {
    const stats = lstatSync(filePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to read a symbolic link as Static Web Apps config: "${filePath}".`);
    }
    if (!stats.isFile()) {
      throw new Error(`Static Web Apps config path is not a regular file: "${filePath}".`);
    }
    return true;
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function readJson(filePath: string) {
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read Static Web Apps config "${filePath}": ${message}`, {
      cause: error
    });
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed Static Web Apps config "${filePath}": ${message}`, {
      cause: error
    });
  }
}

export function loadHandAuthoredStaticWebAppConfig(
  projectRoot: string = process.cwd()
) {
  const root = path.resolve(projectRoot);
  const publicPath = path.join(root, "public/staticwebapp.config.json");
  if (existingFile(publicPath)) {
    throw new Error(
      `Hand-authored Static Web Apps config must not be placed in public/: "${publicPath}". ` +
      "Move it to config/staticwebapp.config.json so generated redirects are preserved."
    );
  }

  const candidates = [
    path.join(root, "config/staticwebapp.config.json"),
    path.join(root, "staticwebapp.config.json")
  ];
  const existing = candidates.filter(existingFile);
  if (existing.length > 1) {
    throw new Error(
      `Found multiple hand-authored Static Web Apps configs: ${existing.join(", ")}. ` +
      "Keep only config/staticwebapp.config.json."
    );
  }
  return existing[0] ? readJson(existing[0]) : undefined;
}
