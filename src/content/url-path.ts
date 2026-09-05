const maxPercentDecodingLayers = 8;
const percentEscapePattern = /%[0-9a-f]{2}/iu;

type LayerInspector = (value: string, label: string) => void;

function assertWellFormedUnicode(value: string, label: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new Error(`${label} must contain well-formed Unicode.`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${label} must contain well-formed Unicode.`);
    }
  }
}

function decodePercentLayers(
  value: string,
  label: string,
  inspectLayer: LayerInspector
) {
  let current = value;

  for (let layer = 0; layer <= maxPercentDecodingLayers; layer += 1) {
    inspectLayer(current, label);
    if (!current.includes("%")) {
      return current;
    }
    if (layer > 0 && !percentEscapePattern.test(current)) {
      return current;
    }
    if (layer === maxPercentDecodingLayers) {
      throw new Error(`${label} uses excessive URL encoding: ${value}`);
    }

    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) {
        return current;
      }
      current = decoded;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} is not valid URL encoding: ${value}: ${message}`, {
        cause: error
      });
    }
  }

  throw new Error(`${label} uses excessive URL encoding: ${value}`);
}

function inspectPathLayer(value: string, label: string, allowWildcard: boolean) {
  assertWellFormedUnicode(value, label);
  if (/%2f/iu.test(value)) {
    throw new Error(`${label} contains an unsafe separator: ${value}`);
  }
  if (/[?#\u0000-\u001f\u007f\\]/u.test(value)) {
    throw new Error(
      `${label} cannot contain a query, fragment, or unsafe character: ${value}`
    );
  }
  if (!allowWildcard && value.includes("*")) {
    throw new Error(`${label} cannot contain a wildcard: ${value}`);
  }
  if (
    value.startsWith("//")
    || value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`${label} contains traversal or an unsafe character: ${value}`);
  }
}

function inspectRecipeSlugLayer(value: string, label: string) {
  assertWellFormedUnicode(value, label);
  if (value.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  if (value.includes("%")) {
    throw new Error(
      `${label} must use raw Unicode; percent-encoded input is not allowed: ${value}`
    );
  }
  if (/\s/u.test(value)) {
    throw new Error(`${label} must not contain whitespace: ${value}`);
  }
  if (value !== value.normalize("NFC")) {
    throw new Error(`${label} must use NFC-normalized Unicode: ${value}`);
  }
  if (
    /[\/\\?#*\u0000-\u001f\u007f]/u.test(value)
    || value === "."
    || value === ".."
  ) {
    throw new Error(`${label} contains an unsafe path segment: ${value}`);
  }
}

function inspectEncodedRecipeSlugLayer(value: string, label: string) {
  assertWellFormedUnicode(value, label);
  if (value.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  if (/[\/\\?#*\u0000-\u001f\u007f]/u.test(value) || /\s/u.test(value)) {
    throw new Error(`${label} contains an unsafe path character: ${value}`);
  }
  if (value === "." || value === "..") {
    throw new Error(`${label} contains an unsafe path segment: ${value}`);
  }
  if (/%(?:2f|5c)/iu.test(value)) {
    throw new Error(`${label} contains an unsafe separator: ${value}`);
  }
  if (value.includes("%") && /%(?![0-9a-f]{2})/iu.test(value)) {
    throw new Error(
      `${label} contains an ambiguous literal percent or malformed URL encoding: ${value}`
    );
  }
}

export function validateSafeLocalPath(value: string, label: string) {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new Error(`${label} must be a single root-relative path: ${value}`);
  }
  decodePercentLayers(
    value,
    label,
    (layer, layerLabel) => inspectPathLayer(layer, layerLabel, false)
  );
}

export function validateRecipeSlug(value: string, label = "Recipe slug") {
  decodePercentLayers(value, label, inspectRecipeSlugLayer);
}

export function validateRecipeFileSlug(value: string, label = "Recipe slug") {
  validateRecipeSlug(value, label);
  if (/[<>:"|]/u.test(value) || /[. ]$/u.test(value)) {
    throw new Error(
      `${label} cannot be represented by a portable recipe filename: ${value}`
    );
  }
  validatePortablePathComponent(`${value}.json`, label);
}

function validatePortablePathComponent(value: string, label: string) {
  if (/[<>:"|]/u.test(value) || /[. ]$/u.test(value)) {
    throw new Error(
      `${label} cannot be represented by a portable path component: ${value}`
    );
  }
  if (
    /^(?:conin\$|conout\$|con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(value)
  ) {
    throw new Error(
      `${label} uses a Windows-reserved path component: ${value}`
    );
  }
  if (
    value.length > 255
    || new TextEncoder().encode(value).byteLength > 255
  ) {
    throw new Error(
      `${label} exceeds the portable 255-unit path component limit: ${value}`
    );
  }
}

export function recipeFileNameKey(value: string) {
  validateRecipeFileSlug(value);
  return portablePathComponentKey(`${value}.json`, "Recipe filename");
}

export function validateCategorySlug(value: string, label = "Category slug") {
  validateRecipeSlug(value, label);
  validatePortablePathComponent(value, label);
}

export function portablePathComponentKey(value: string, label: string) {
  validatePortablePathComponent(value, label);
  return value
    .normalize("NFC")
    .toUpperCase()
    .normalize("NFC");
}

export function decodeRecipeSlug(value: string, label = "Recipe slug") {
  const decoded = decodePercentLayers(
    value,
    label,
    inspectEncodedRecipeSlugLayer
  );
  validateRecipeSlug(decoded, label);
  return decoded;
}

export function decodeLocalPath(value: string) {
  return decodePercentLayers(
    value,
    "Local path",
    (layer, label) => assertWellFormedUnicode(layer, label)
  );
}

export function localPathKey(value: string) {
  const decoded = decodePercentLayers(
    value,
    "Local path",
    (layer, label) => inspectPathLayer(layer, label, true)
  );
  return decoded === "/" ? "/" : decoded.replace(/\/+$/u, "");
}
