import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContactFormBoundary } from "../src/components/contact-form-boundary";
import { ContactSuccessPage } from "../src/components/contact-success-page";
import { recipeCatalog } from "../src/content/catalog";
import { editorialCatalog } from "../src/content/editorial-catalog";
import { editorialPageRecordSchema } from "../src/content/editorial-schema";
import { galleryCatalog } from "../src/content/gallery-catalog";
import { createStaticWebAppConfig } from "../src/content/staticwebapp";
import { validatePublicContentBehavior } from "../src/content/validation";
import {
  assertContactFormBuildEnvironment,
  contactFormEndpointEnvironmentVariable,
  contactFormFieldLimits,
  getContactFormBoundaryData,
  getContactFormConfiguration,
  parseContactFormEndpoint
} from "../src/lib/contact-form";
import {
  findContactSuccessLocale,
  getContactSuccessPath,
  getContactSuccessStaticParams
} from "../src/lib/contact-routes";
import {
  getPublicStaticPageParams,
  getStaticPathFromSegments
} from "../src/lib/public-routes";
import { getEditorialPath } from "../src/lib/editorial-routes";
import { getContactSuccessMetadata } from "../src/lib/site";
import { getSitemapEntries } from "../src/lib/site-map";

const siteUrl = "https://mycafegourmand.com";
const endpoint = "https://forms.example.com/contact/submit";

function environment(value?: string) {
  const result = { ...process.env };
  if (value === undefined) {
    delete result[contactFormEndpointEnvironmentVariable];
  } else {
    result[contactFormEndpointEnvironmentVariable] = value;
  }
  return result;
}

test("contact endpoint parsing accepts only public external HTTPS targets", () => {
  assert.equal(
    parseContactFormEndpoint(`${endpoint}?form=public`, siteUrl).href,
    `${endpoint}?form=public`
  );

  for (const unsafe of [
    "http://forms.example.com/contact",
    "https://user@forms.example.com/contact",
    "https://forms.example.com/contact#fragment",
    "https://forms.example.com/contact#",
    "https://forms.example.com/contact?#",
    "https://forms.example.com/contact with-space",
    "https://forms.example.com\\contact",
    "https://intranet/contact",
    "https://printer.lan/contact",
    "https://router.home.arpa/contact",
    "https://forms.example.test/contact",
    "https://localhost/contact",
    "https://mail.localhost/contact",
    "https://127.1/contact",
    "https://192.168.1.1/contact",
    "https://172.20.0.1/contact",
    "https://[::1]/contact",
    "https://[::ffff:127.0.0.1]/contact",
    "https://[fc00::1]/contact",
    "https://[fec0::1]/contact",
    "https://localtest.me/contact",
    "https://forms.mycafegourmand.com/contact",
    "https://mycafegourmand.com/contact"
  ]) {
    assert.throws(
      () => parseContactFormEndpoint(unsafe, siteUrl),
      /Contact form endpoint/u,
      unsafe
    );
  }
});

test("contact configuration is unavailable outside release until a valid endpoint is supplied", () => {
  assert.deepEqual(getContactFormConfiguration(undefined, siteUrl), {
    available: false,
    issue: "missing"
  });
  assert.deepEqual(getContactFormConfiguration("https://localhost/contact", siteUrl), {
    available: false,
    issue: "invalid"
  });
  assert.deepEqual(
    assertContactFormBuildEnvironment("non-release", environment()),
    { available: false, issue: "missing" }
  );
  assert.throws(
    () => assertContactFormBuildEnvironment("release", environment()),
    /NEXT_PUBLIC_CONTACT_FORM_ENDPOINT is required/u
  );
  assert.throws(
    () => assertContactFormBuildEnvironment(
      "release",
      environment("https://localhost/contact")
    ),
    /Contact form endpoint/u
  );
  assert.equal(
    assertContactFormBuildEnvironment("release", environment(endpoint)).href,
    endpoint
  );
});

test("localized form data and markup use the bounded provider contract without scripts", () => {
  for (const locale of ["en", "fr", "ru"] as const) {
    const data = getContactFormBoundaryData(locale, endpoint, siteUrl);
    assert.deepEqual(data, {
      available: true,
      endpoint,
      locale,
      returnUrl: `${siteUrl}${getContactSuccessPath(locale)}`
    });

    const markup = renderToStaticMarkup(createElement(ContactFormBoundary, {
      endpoint,
      locale
    }));
    assert.match(markup, new RegExp(`<form[^>]*action="${endpoint}"[^>]*method="post"`, "u"));
    assert.match(markup, /accept-charset="UTF-8"/u);
    assert.match(markup, new RegExp(`name="locale"[^>]*value="${locale}"`, "u"));
    assert.match(
      markup,
      new RegExp(`name="returnUrl"[^>]*value="${siteUrl}${getContactSuccessPath(locale)}"`, "u")
    );
    for (const [name, maximum] of Object.entries(contactFormFieldLimits)) {
      assert.match(
        markup,
        new RegExp(
          `(?:name="${name}"[^>]*maxLength="${maximum}"|maxLength="${maximum}"[^>]*name="${name}")`,
          "u"
        )
      );
    }
    assert.match(
      markup,
      /<input(?=[^>]*name="website")(?=[^>]*autoComplete="off")(?=[^>]*tabindex="-1")[^>]*>/u
    );
    assert.match(markup, /autoComplete="name"/u);
    assert.match(markup, /autoComplete="email"/u);
    assert.match(markup, /data-contact-form-boundary="available"/u);
    assert.doesNotMatch(markup, /<script|captcha|analytics/iu);
  }

  const unavailable = renderToStaticMarkup(createElement(ContactFormBoundary, {
    endpoint: "https://localhost/contact",
    locale: "en"
  }));
  assert.match(unavailable, /data-contact-form-boundary="unavailable"/u);
  assert.doesNotMatch(unavailable, /<form/u);
});

test("contact success routes are static, canonical noindex pages excluded from the sitemap", () => {
  assert.deepEqual(getContactSuccessStaticParams(), [
    { segments: ["contact", "success"] },
    { segments: ["fr", "contact", "success"] },
    { segments: ["ru", "contact", "success"] }
  ]);
  for (const locale of ["en", "fr", "ru"] as const) {
    const path = getContactSuccessPath(locale);
    const segments = path.slice(1, -1).split("/");
    assert.equal(findContactSuccessLocale(segments), locale);
    assert.equal(getContactSuccessMetadata(locale).alternates?.canonical, `${siteUrl}${path}`);
    assert.deepEqual(getContactSuccessMetadata(locale).robots, {
      follow: true,
      index: false
    });
    const contact = editorialCatalog.find((record) =>
      record.locale === locale
      && record.content?.some((block) => block.type === "contactForm")
    );
    assert.ok(contact);
    assert.match(
      renderToStaticMarkup(createElement(ContactSuccessPage, { locale })),
      new RegExp(`href="${getEditorialPath(contact).replace(/\/$/u, "")}`, "u")
    );
  }

  const staticPaths = getPublicStaticPageParams(recipeCatalog, editorialCatalog, galleryCatalog)
    .map(({ segments }) => getStaticPathFromSegments(segments));
  const sitemapPaths = getSitemapEntries(recipeCatalog, editorialCatalog, galleryCatalog)
    .map((entry) => new URL(entry.url).pathname);
  for (const path of ["/contact/success", "/fr/contact/success", "/ru/contact/success"]) {
    assert.equal(staticPaths.includes(path), true);
    assert.equal(sitemapPaths.includes(`${path}/`), false);
  }

  const contact = editorialCatalog.find((record) => record.locale === "en" && record.canonicalPath === "/contact/");
  assert.ok(contact);
  const collidingContact = editorialPageRecordSchema.parse({
    ...contact,
    canonicalPath: "/contact/success/",
    id: "test:contact-success-collision",
    source: {
      ...contact.source,
      postId: 999_100,
      sourcePath: "/contact/success/"
    },
    translationGroupId: null
  });
  assert.throws(
    () => validatePublicContentBehavior(recipeCatalog, [collidingContact], []),
    /Public static routes are not unique/u
  );
  assert.throws(
    () => createStaticWebAppConfig([], {
      handAuthoredConfig: {
        routes: [{
          route: "/contact/success/",
          redirect: "/elsewhere/",
          statusCode: 301
        }]
      }
    }),
    /conflicts with a canonical route/u
  );
});
