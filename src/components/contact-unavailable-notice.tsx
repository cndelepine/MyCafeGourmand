import Link from "next/link";
import type { Locale } from "@/content/schema";
import { getContactUnavailableCopy } from "@/lib/contact-routes";
import { getLocaleHomePath } from "@/lib/recipe-routes";

export function ContactUnavailableNotice({ locale }: { readonly locale: Locale }) {
  const labels = getContactUnavailableCopy(locale);
  return (
    <section
      aria-label={labels.title}
      className="contact-unavailable-notice"
      data-contact-status="deferred"
    >
      <p>{labels.message}</p>
      <Link className="jump-link" href={getLocaleHomePath(locale)}>
        {labels.backToRecipes} <span aria-hidden="true">→</span>
      </Link>
    </section>
  );
}
