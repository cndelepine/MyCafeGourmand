import { localeValues, type Locale } from "@/content/schema";

export type ContactSuccessRouteParams = {
  readonly segments: string[];
};

const successRouteSegments: Record<Locale, readonly string[]> = {
  en: ["contact", "success"],
  fr: ["fr", "contact", "success"],
  ru: ["ru", "contact", "success"]
};

const successCopy: Record<Locale, {
  readonly backToContact: string;
  readonly footer: string;
  readonly message: string;
  readonly title: string;
}> = {
  en: {
    backToContact: "Return to contact",
    footer: "Made with care, one recipe at a time.",
    message: "Thank you. Your message has been received.",
    title: "Message received"
  },
  fr: {
    backToContact: "Retour au contact",
    footer: "Préparé avec soin, une recette à la fois.",
    message: "Merci. Votre message a bien été reçu.",
    title: "Message reçu"
  },
  ru: {
    backToContact: "Вернуться к контактам",
    footer: "С заботой, по одному рецепту за раз.",
    message: "Спасибо. Ваше сообщение получено.",
    title: "Сообщение получено"
  }
};

export function getContactSuccessSegments(locale: Locale) {
  return successRouteSegments[locale];
}

export function getContactSuccessPath(locale: Locale) {
  return `/${getContactSuccessSegments(locale).join("/")}/`;
}

export function getContactSuccessCopy(locale: Locale) {
  return successCopy[locale];
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
