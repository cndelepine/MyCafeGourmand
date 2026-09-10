import type { Locale } from "@/content/schema";
import { getContactUnavailableCopy } from "@/lib/contact-routes";
import { ContactUnavailableNotice } from "./contact-unavailable-notice";
import { SiteHeader } from "./site-header";

export function ContactUnavailablePage({ locale }: { readonly locale: Locale }) {
  const labels = getContactUnavailableCopy(locale);

  return (
    <>
      <SiteHeader locale={locale} page="editorial" />
      <main className="contact-unavailable-page" lang={locale}>
        <article>
          <h1>{labels.title}</h1>
          <ContactUnavailableNotice locale={locale} />
        </article>
      </main>
      <footer lang={locale}>{labels.footer}</footer>
    </>
  );
}
