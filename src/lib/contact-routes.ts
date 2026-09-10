import { localeValues, type Locale } from "@/content/locales";

export type ContactSuccessRouteParams = {
  readonly segments: string[];
};

// Keep previously generated URLs reserved, but never render a submission receipt.
const successRouteSegments: Record<Locale, readonly string[]> = {
  en: ["contact", "success"],
  fr: ["fr", "contact", "success"],
  ru: ["ru", "contact", "success"]
};

const unavailableCopy: Record<Locale, {
  readonly backToRecipes: string;
  readonly footer: string;
  readonly message: string;
  readonly title: string;
}> = {
  en: {
    backToRecipes: "Browse recipes",
    footer: "Made with care, one recipe at a time.",
    message: "Contact messaging is not available on this site.",
    title: "Contact unavailable"
  },
  fr: {
    backToRecipes: "Voir les recettes",
    footer: "Préparé avec soin, une recette à la fois.",
    message: "L’envoi de messages n’est pas disponible sur ce site.",
    title: "Contact indisponible"
  },
  ru: {
    backToRecipes: "Посмотреть рецепты",
    footer: "С заботой, по одному рецепту за раз.",
    message: "Отправка сообщений на этом сайте недоступна.",
    title: "Обратная связь недоступна"
  }
};

export function getContactSuccessSegments(locale: Locale) {
  return successRouteSegments[locale];
}

export function getContactSuccessPath(locale: Locale) {
  return `/${getContactSuccessSegments(locale).join("/")}/`;
}

export function getContactUnavailableCopy(locale: Locale) {
  return unavailableCopy[locale];
}

export function getContactSuccessStaticParams(): ContactSuccessRouteParams[] {
  return localeValues.map((locale) => ({
    segments: [...getContactSuccessSegments(locale)]
  }));
}

export function findContactSuccessLocale(segments: readonly string[]) {
  return localeValues.find((locale) => {
    const candidate = getContactSuccessSegments(locale);
    return candidate.length === segments.length
      && candidate.every((segment, index) => segment === segments[index]);
  });
}
