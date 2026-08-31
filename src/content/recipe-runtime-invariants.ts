export const recipeRuntimeOnlyInvariants = Object.freeze([
  {
    code: "recipe-slug-path-and-filename-safety",
    versions: [1, 2],
    paths: ["slug"],
    description:
      "Recipe slugs require well-formed NFC raw Unicode plus URL and cross-platform filename safety."
  },
  {
    code: "category-slug-path-safety",
    versions: [1, 2],
    paths: ["taxonomies[].slug", "categories[].slug"],
    description:
      "Category route slugs require well-formed canonical Unicode, safe URL-segment semantics, and portable static-output component safety."
  },
  {
    code: "quantity-range-order",
    versions: [1, 2],
    paths: ["recipe.servings", "recipe.ingredientGroups[].items[].quantity"],
    description: "A parsed quantity range requires min to be less than or equal to max."
  },
  {
    code: "redirect-route-closure",
    versions: [1, 2],
    paths: ["slug", "redirectFrom[]"],
    description:
      "Redirects require safe non-root local paths, must be unique, and cannot equal or collide with a canonical public route."
  },
  {
    code: "recipe-media-path-safety",
    versions: [1],
    paths: ["media[].path"],
    description:
      "Media paths require canonical safe local object keys and an approved managed or local namespace."
  },
  {
    code: "wordpress-managed-media-identity",
    versions: [1],
    paths: ["media[].id", "media[].sourceId", "media[].path"],
    description:
      "Managed WordPress media IDs and source IDs must match the attachment ID encoded in the path."
  },
  {
    code: "recipe-media-reference-closure",
    versions: [1],
    paths: [
      "recipe.heroMediaId",
      "recipe.instructionGroups[].steps[].mediaId",
      "media[].id"
    ],
    description: "Recipe media references and assets must form an exact, unique closed set."
  },
  {
    code: "authored-id-source-match",
    versions: [2],
    paths: ["id", "source.recordId"],
    description: "The authored content ID suffix must exactly equal source.recordId."
  },
  {
    code: "authored-timestamp-order",
    versions: [2],
    paths: ["publishedAt", "modifiedAt"],
    description: "When both timestamps exist, modifiedAt cannot precede publishedAt."
  },
  {
    code: "catalog-record-and-file-closure",
    versions: [1, 2],
    paths: ["id", "locale", "slug", "translationGroupId"],
    description:
      "Catalog IDs, localized routes, portable filename keys, and translation-group locales must be unique and files must match locale/slug placement."
  },
  {
    code: "wordpress-source-identity-and-route",
    versions: [1],
    paths: ["id", "source.*", "redirectFrom[]"],
    description:
      "WordPress content IDs must match plugin/recipe identity and uniquely sourced editorial permalinks must remain redirected."
  },
  {
    code: "normalized-display-text",
    versions: [1, 2],
    paths: ["title", "description", "recipe.*", "taxonomies[].name", "categories[].name"],
    description: "Normalized rendered recipe fields cannot contain HTML markup."
  }
]);
