import { localPathKey, validateSafeLocalPath } from "./url-path";

export const wordpressRecipeMediaPrefix = "/recipes/media/wordpress/";
const wordpressRecipeMediaNamespace = wordpressRecipeMediaPrefix.slice(0, -1);

const numericAttachmentId = /^(?:0|[1-9]\d*)$/u;
const wordpressRecipeMediaKey = new RegExp(
  `^${wordpressRecipeMediaPrefix}(?<attachmentId>(?:0|[1-9]\\d*))` +
    "\\.(?<extension>avif|gif|jpe?g|png|webp)$",
  "u"
);

export type WordPressRecipeMediaObjectKey = {
  readonly attachmentId: string;
  readonly extension: "avif" | "gif" | "jpeg" | "jpg" | "png" | "webp";
  readonly key: string;
};

export function validateRecipeMediaPath(
  value: string,
  label = "Recipe media path"
) {
  const effectivePath = recipeMediaPathKey(value, label);
  if (isWordPressRecipeMediaNamespaceKey(effectivePath)) {
    if (value !== effectivePath) {
      throw new Error(
        `${label} must not encode or alias the managed media namespace: ${value}`
      );
    }
    parseWordPressRecipeMediaObjectKey(value, label);
  }
  return value;
}

export function recipeMediaPathKey(
  value: string,
  label = "Recipe media path"
) {
  validateSafeLocalPath(value, label);
  return localPathKey(value);
}

function isWordPressRecipeMediaNamespaceKey(value: string) {
  return value === wordpressRecipeMediaNamespace
    || value.startsWith(wordpressRecipeMediaPrefix);
}

export function isWordPressRecipeMediaNamespacePath(value: string) {
  return isWordPressRecipeMediaNamespaceKey(recipeMediaPathKey(value));
}

export function parseWordPressRecipeMediaObjectKey(
  value: string,
  label = "WordPress recipe media object key"
): WordPressRecipeMediaObjectKey {
  validateSafeLocalPath(value, label);
  const match = wordpressRecipeMediaKey.exec(value);
  const attachmentId = match?.groups?.attachmentId;
  const extension = match?.groups?.extension;
  if (
    attachmentId === undefined
    || extension === undefined
    || !numericAttachmentId.test(attachmentId)
  ) {
    throw new Error(`${label} is not a canonical WordPress recipe media key: ${value}`);
  }
  return {
    attachmentId,
    extension: extension as WordPressRecipeMediaObjectKey["extension"],
    key: value
  };
}

export function isWordPressRecipeMediaObjectKey(value: string) {
  try {
    parseWordPressRecipeMediaObjectKey(value);
    return true;
  } catch {
    return false;
  }
}
