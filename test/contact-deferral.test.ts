import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StaticPathPage, { generateMetadata } from "../src/app/[[...segments]]/page";
import { SiteHeader } from "../src/components/site-header";
import { recipeCatalog } from "../src/content/catalog";
import { editorialCatalog } from "../src/content/editorial-catalog";
import { editorialPageRecordSchema } from "../src/content/editorial-schema";
import { galleryCatalog } from "../src/content/gallery-catalog";
import { createStaticWebAppConfig } from "../src/content/staticwebapp";
import { validatePublicContentBehavior } from "../src/content/validation";
import {
  findContactSuccessLocale,
  getContactSuccessPath,
  getContactSuccessStaticParams,
  getContactUnavailableCopy
} from "../src/lib/contact-routes";
import {
  getEditorialPath,
  getEditorialSegments,
  isEditorialContactPage
} from "../src/lib/editorial-routes";
import {
  getPublicStaticPageParams,
  getStaticPathFromSegments
} from "../src/lib/public-routes";
import { getLocaleHomePath } from "../src/lib/recipe-routes";
import { getSitemapEntries } from "../src/lib/site-map";

const siteUrl = "https://mycafegourmand.com";
const historicalPaths = {
  en: "/contact/",
  fr: "/fr/contact-2/",
  ru: "/ru/kontact/"
} as const;

for (const locale of ["en", "fr", "ru"] as const) {
  test(`${locale} historical contact and former success routes show no-service notices`, async (context) => {
    const previousEndpoint = process.env.NEXT_PUBLIC_CONTACT_FORM_ENDPOINT;
    process.env.NEXT_PUBLIC_CONTACT_FORM_ENDPOINT = "https://forms.example.com/obsolete";
    context.after(() => {
      if (previousEndpoint === undefined) {
        delete process.env.NEXT_PUBLIC_CONTACT_FORM_ENDPOINT;
      } else {
        process.env.NEXT_PUBLIC_CONTACT_FORM_ENDPOINT = previousEndpoint;
      }
    });
    const contact = editorialCatalog.find((record) =>
      record.locale === locale && isEditorialContactPage(record)
    );
    assert.ok(contact);
    const sourceBefore = JSON.stringify(contact);
    assert.equal(getEditorialPath(contact), historicalPaths[locale]);
    const labels = getContactUnavailableCopy(locale);
    for (const segments of [
      getEditorialSegments(contact),
      getContactSuccessPath(locale).slice(1, -1).split("/")
    ]) {
      const props = { params: Promise.resolve({ segments }) };
      const markup = renderToStaticMarkup(await StaticPathPage(props));
      const metadata = await generateMetadata(props);
      assert.match(markup, /data-contact-status="deferred"/u);
      assert.ok(markup.includes(labels.message));
      assert.match(markup, new RegExp(`href="${getLocaleHomePath(locale).replace(/\/$/u, "") || "/"}`, "u"));
      assert.doesNotMatch(markup, /<form\b|<input\b|<textarea\b|mailto:|returnUrl|forms\.example\.com|Thank you|message has been received|Message received|Message reçu|Сообщение получено/iu);
      assert.equal(metadata.description, labels.message);
      assert.equal(metadata.alternates?.canonical, `${siteUrl}/${segments.join("/")}/`);
      for (const block of contact.content ?? []) {
        if (block.type === "paragraph" || block.type === "heading") {
          for (const inline of block.children) {
            if (inline.type === "text" && inline.value.trim().length > 0) {
              assert.equal(markup.includes(inline.value.trim()), false);
            }
          }
        }
      }
    }
    assert.equal(JSON.stringify(contact), sourceBefore);
    const header = renderToStaticMarkup(createElement(SiteHeader, { locale, page: "landing" }));
    for (const path of Object.values(historicalPaths)) {
      assert.equal(header.includes(`href="${path.replace(/\/$/u, "")}`), false);
    }
  });
}

test("compatibility routes stay reserved, canonical and noindex without success claims", async () => {
  assert.deepEqual(getContactSuccessStaticParams(), [
    { segments: ["contact", "success"] },
    { segments: ["fr", "contact", "success"] },
    { segments: ["ru", "contact", "success"] }
  ]);
  const staticPaths = getPublicStaticPageParams(recipeCatalog, editorialCatalog, galleryCatalog)
    .map(({ segments }) => getStaticPathFromSegments(segments));
  const sitemapPaths = getSitemapEntries(recipeCatalog, editorialCatalog, galleryCatalog)
    .map((entry) => new URL(entry.url).pathname);
  for (const locale of ["en", "fr", "ru"] as const) {
    const path = getContactSuccessPath(locale);
    const segments = path.slice(1, -1).split("/");
    assert.equal(findContactSuccessLocale(segments), locale);
    assert.equal(staticPaths.includes(path.slice(0, -1)), true);
    assert.equal(sitemapPaths.includes(path), false);
    assert.equal(sitemapPaths.includes(historicalPaths[locale]), true);
    const metadata = await generateMetadata({ params: Promise.resolve({ segments }) });
    assert.deepEqual(metadata.robots, { follow: true, index: false });
    assert.equal(metadata.title, getContactUnavailableCopy(locale).title);
  }

  const contact = editorialCatalog.find((record) => record.canonicalPath === "/contact/");
  assert.ok(contact);
  const collision = editorialPageRecordSchema.parse({
    ...contact,
    canonicalPath: "/contact/success/",
    id: "test:contact-success-collision",
    source: { ...contact.source, postId: 999_100, sourcePath: "/contact/success/" },
    translationGroupId: null
  });
  assert.throws(
    () => validatePublicContentBehavior(recipeCatalog, [collision], []),
    /Public static routes are not unique/u
  );
  assert.throws(
    () => createStaticWebAppConfig([], {
      handAuthoredConfig: {
        routes: [{ route: "/contact/success/", redirect: "/elsewhere/", statusCode: 301 }]
      }
    }),
    /conflicts with a canonical route/u
  );
});

test("release preflight needs media but no contact endpoint", () => {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL: "https://media.example.test/container"
  };
  delete environment.NEXT_PUBLIC_CONTACT_FORM_ENDPOINT;
  const validate = (env: NodeJS.ProcessEnv) => spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "release:validate"],
    { env, encoding: "utf8", timeout: 60_000, shell: process.platform === "win32" }
  );
  const valid = validate(environment);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Validated release media configuration/u);
  const invalid = validate({ ...environment, NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL: "http://unsafe.example.com" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /release-media-validation-failed/u);
});
