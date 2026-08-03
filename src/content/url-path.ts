const maxPercentDecodingLayers = 8;
const percentEscapePattern = /%[0-9a-f]{2}/iu;

type LayerInspector = (value: string, label: string) => void;

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
  if (
    /[\/\\?#*\u0000-\u001f\u007f]/u.test(value)
    || value === "."
    || value === ".."
  ) {
    throw new Error(`${label} contains an unsafe path segment: ${value}`);
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

export function decodeLocalPath(value: string) {
  return decodePercentLayers(value, "Local path", () => undefined);
}

export function localPathKey(value: string) {
  const decoded = decodePercentLayers(
    value,
    "Local path",
    (layer, label) => inspectPathLayer(layer, label, true)
  );
  return decoded === "/" ? "/" : decoded.replace(/\/+$/u, "");
}
