import Link from "next/link";
import { editorialCatalog } from "@/content/editorial-catalog";
import type { Locale } from "@/content/schema";
import {
  findEditorialContactPage,
  getEditorialPath
} from "@/lib/editorial-routes";
import { getContactSuccessCopy } from "@/lib/contact-routes";
import { getLocaleHomePath } from "@/lib/recipe-routes";
import { SiteHeader } from "./site-header";

export function ContactSuccessPage({ locale }: { readonly locale: Locale }) {
  const labels = getContactSuccessCopy(locale);
  const contactPage = findEditorialContactPage(locale, editorialCatalog);
  const returnPath = contactPage === undefined
    ? getLocaleHomePath(locale)
    : getEditorialPath(contactPage);

  return (
    <>
      <SiteHeader locale={locale} page="editorial" />
      <main className="contact-success-page" lang={locale}>
        <article>
          <h1>{labels.title}</h1>
          <p>{labels.message}</p>
          <Link className="jump-link" href={returnPath}>
            {labels.backToContact} <span aria-hidden="true">→</span>
          </Link>
        </article>
      </main>
      <footer lang={locale}>{labels.footer}</footer>
    </>
  );
}
