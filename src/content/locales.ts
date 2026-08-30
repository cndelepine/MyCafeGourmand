export const localeValues = ["en", "fr", "ru"] as const;

export type Locale = (typeof localeValues)[number];
