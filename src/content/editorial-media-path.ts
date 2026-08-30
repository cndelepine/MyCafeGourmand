import { validateSafeLocalPath } from "./url-path";

export const editorialManagedMediaPrefix = "/editorial/media/wordpress/";
export const galleryManagedMediaPrefix = "/gallery/media/wordpress-bwg/";

export function validatePublicManagedMediaPath(value: string, label: string) {
  validateSafeLocalPath(value, label);
  if (value.includes("%")) {
    throw new Error(`${label} must be a canonical raw path: ${value}`);
  }
  if (
    !value.startsWith(editorialManagedMediaPrefix)
    && !value.startsWith(galleryManagedMediaPrefix)
  ) {
    throw new Error(
      `${label} must use an approved editorial or gallery managed prefix: ${value}`
    );
  }
  if (value.endsWith("/")) {
    throw new Error(`${label} must identify a managed object, not a directory: ${value}`);
  }
}
