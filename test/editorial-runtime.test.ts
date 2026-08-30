import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sitemap from "../src/app/sitemap";
import { EditorialPage } from "../src/components/editorial-page";
import { GalleryPage } from "../src/components/gallery-page";
import { LandingPage } from "../src/components/landing-page";
import { SiteHeader } from "../src/components/site-header";
import { recipeCatalog } from "../src/content/catalog";
import { editorialCatalog } from "../src/content/editorial-catalog";
import { getEditorialGalleryMediaDimensions } from "../src/content/editorial-media-manifest";
import { editorialPageRecordSchema } from "../src/content/editorial-schema";
import { galleryCatalog } from "../src/content/gallery-catalog";
import { createExactRedirectManifest } from "../src/content/redirect-manifest";
import { validatePublicContentBehavior } from "../src/content/validation";
import {
  getEditorialStructuredData,
  getGalleryStructuredData,
  serializeEditorialStructuredData
} from "../src/lib/editorial-structured-data";
import {
  findEditorialBySegments,
  findGalleryBySegments,
  getEditorialLanguageAlternates,
  getEditorialPath,
  getEditorialSegments,
  getEditorialStaticParams
} from "../src/lib/editorial-routes";
import {
  getPublicStaticPageParams,
  getReservedPublicPaths,
  getStaticPathFromSegments
} from "../src/lib/public-routes";
import { getEditorialMetadata, getGalleryMetadata } from "../src/lib/site";

function page(id: string) {
  const record = editorialCatalog.find((candidate) => candidate.id === id);
  assert.ok(record, `Missing editorial fixture ${id}`);
  return record;
}

test("editorial routes preserve nested Unicode canonical paths and translation relationships", () => {
  const english = page("wordpress:page:500");
  const french = page("wordpress:page:498");
  const russian = page("wordpress:page:493");
  const gallery = galleryCatalog[0];

  assert.equal(getEditorialPath(english), "/table-setting/");
  assert.equal(getEditorialPath(french), "/fr/decorations-de-table/");
  assert.equal(
    getEditorialPath(russian),
    "/ru/%D0%B4%D0%B5%D0%BA%D0%BE%D1%80-%D1%81%D1%82%D0%BE%D0%BB%D0%B0-%D0%B8-%D0%B4%D0%BE%D0%BC%D0%B0/"
  );
  assert.deepEqual(
    getEditorialSegments(russian),
    ["ru", "декор-стола-и-дома"]
  );
  assert.equal(
    findEditorialBySegments(
      ["ru", encodeURIComponent("декор-стола-и-дома")],
      editorialCatalog
    ),
    russian
  );
  assert.equal(findGalleryBySegments(["gallery"], galleryCatalog), gallery);
  assert.deepEqual(
    getEditorialLanguageAlternates(english, editorialCatalog).map(({ locale, path }) => ({
      locale,
      path
    })),
    [
      { locale: "en", path: "/table-setting/" },
      { locale: "fr", path: "/fr/decorations-de-table/" },
      {
        locale: "ru",
        path: "/ru/%D0%B4%D0%B5%D0%BA%D0%BE%D1%80-%D1%81%D1%82%D0%BE%D0%BB%D0%B0-%D0%B8-%D0%B4%D0%BE%D0%BC%D0%B0/"
      }
    ]
  );
  assert.equal(getEditorialStaticParams(editorialCatalog).length, 27);
  assert.equal(
    getPublicStaticPageParams(recipeCatalog, editorialCatalog, galleryCatalog).length,
    624
  );
  assert.equal(getStaticPathFromSegments(["ru", "о-сайте"]), "/ru/%D0%BE-%D1%81%D0%B0%D0%B9%D1%82%D0%B5");
  assert.equal(
    getReservedPublicPaths(recipeCatalog).includes("/staticwebapp.config.json"),
    true
  );
  assert.equal(
    getReservedPublicPaths(recipeCatalog).includes("/redirect-manifest.json"),
    true
  );
});

test("editorial metadata and JSON-LD use canonical paths, available hreflang links, and breadcrumbs", () => {
  const english = page("wordpress:page:500");
  const russian = page("wordpress:page:493");
  const contact = page("wordpress:page:5");
  const gallery = galleryCatalog[0]!;
  const metadata = getEditorialMetadata(russian, editorialCatalog);
  const contactMetadata = getEditorialMetadata(contact, editorialCatalog);
  const structured = getEditorialStructuredData(english, editorialCatalog);
  const galleryStructured = getGalleryStructuredData(gallery);

  assert.equal(
    metadata.alternates?.canonical,
    "https://mycafegourmand.com/ru/%D0%B4%D0%B5%D0%BA%D0%BE%D1%80-%D1%81%D1%82%D0%BE%D0%BB%D0%B0-%D0%B8-%D0%B4%D0%BE%D0%BC%D0%B0/"
  );
  assert.deepEqual(metadata.alternates?.languages, {
    en: "https://mycafegourmand.com/table-setting/",
    fr: "https://mycafegourmand.com/fr/decorations-de-table/",
    ru: "https://mycafegourmand.com/ru/%D0%B4%D0%B5%D0%BA%D0%BE%D1%80-%D1%81%D1%82%D0%BE%D0%BB%D0%B0-%D0%B8-%D0%B4%D0%BE%D0%BC%D0%B0/"
  });
  assert.notEqual(english.publishedAt, null);
  assert.equal(structured["@graph"][0]["@type"], "WebPage");
  assert.equal(
    metadata.openGraph && "type" in metadata.openGraph
      ? metadata.openGraph.type
      : undefined,
    "website"
  );
  assert.equal(
    contactMetadata.openGraph && "type" in contactMetadata.openGraph
      ? contactMetadata.openGraph.type
      : undefined,
    "website"
  );
  assert.equal(structured["@graph"][1]["@type"], "BreadcrumbList");
  assert.equal(structured["@graph"][1].itemListElement.length, 2);
  assert.equal(galleryStructured["@graph"][0]["@type"], "WebPage");
  assert.equal(getGalleryMetadata(gallery).alternates?.canonical, "https://mycafegourmand.com/gallery/");
  assert.equal(
    serializeEditorialStructuredData({
      ...structured,
      "@graph": [{
        ...structured["@graph"][0],
        name: "</script>"
      }, structured["@graph"][1]]
    }).includes("</script>"),
    false
  );
});

test("mobile navigation is server-rendered with native keyboard-operable disclosure", () => {
  const markup = renderToStaticMarkup(createElement(SiteHeader, {
    locale: "en",
    page: "recipe"
  }));

  assert.match(
    markup,
    /<details class="mobile-site-navigation"><summary>Menu<\/summary><nav aria-label="Mobile navigation">/u
  );
  for (const href of ["/", "/table-setting", "/gallery", "/contact"]) {
    assert.match(markup, new RegExp(`class="mobile-site-navigation"[\\s\\S]*?href="${href}`));
  }
});

test("editorial rendering maps every bounded AST block to safe semantic HTML", () => {
  const source = page("wordpress:page:4");
  const mediaId = source.media?.[0]?.id;
  const mediaPath = source.media?.[0]?.path;
  assert.ok(mediaId);
  assert.ok(mediaPath);
  const dimensions = getEditorialGalleryMediaDimensions(mediaPath);
  assert.notDeepEqual(dimensions, { width: 1200, height: 800 });
  const cardPage = editorialCatalog.find((candidate) => candidate.featuredMediaId !== null);
  assert.ok(cardPage);
  const cardMedia = cardPage.media?.find((media) => media.id === cardPage.featuredMediaId);
  assert.ok(cardMedia);
  const cardDimensions = getEditorialGalleryMediaDimensions(cardMedia.path);
  const gallery = galleryCatalog[0]!;
  const rendered = editorialPageRecordSchema.parse({
    ...source,
    id: "test:editorial:all-blocks",
    canonicalPath: "/editorial-runtime-test/",
    translationGroupId: null,
    source: {
      ...source.source,
      postId: 999_001,
      sourcePath: "/editorial-runtime-test/"
    },
    title: "Editorial rendering test",
    content: [
      {
        type: "heading",
        level: 2,
        children: [{ type: "text", value: "Heading" }]
      },
      {
        type: "paragraph",
        children: [
          { type: "text", value: "Plain " },
          { type: "emphasis", children: [{ type: "text", value: "emphasis" }] },
          { type: "strong", children: [{ type: "text", value: "strong" }] },
          { type: "code", value: "code" },
          { type: "break" },
          {
            type: "link",
            href: "/contact/",
            children: [{ type: "text", value: "contact" }]
          }
        ]
      },
      {
        type: "list",
        ordered: true,
        items: [{ children: [{ type: "text", value: "Listed" }] }]
      },
      {
        type: "blockquote",
        children: [{
          type: "paragraph",
          children: [{ type: "text", value: "Quoted" }]
        }]
      },
      { type: "image", mediaId, alt: null, caption: "Caption" },
      {
        type: "imageGrid",
        images: [{ mediaId, alt: "Reviewed image", caption: null }]
      },
      { type: "recipeCardGrid", recipeIds: [recipeCatalog[0]!.id] },
      { type: "editorialPageCardGrid", pageIds: [cardPage.id] },
      { type: "emptyCardGrid", reason: "source-category-missing" },
      { type: "galleryCallout", galleryId: gallery.id },
      { type: "contactForm" }
    ],
    featuredMediaId: mediaId
  });
  const markup = renderToStaticMarkup(createElement(EditorialPage, {
    editorialCatalog: [...editorialCatalog, rendered],
    galleries: galleryCatalog,
    page: rendered,
    recipeCatalog
  }));

  assert.match(markup, /<h2>Heading<\/h2>/u);
  assert.match(markup, /<em>emphasis<\/em>/u);
  assert.match(markup, /<strong>strong<\/strong>/u);
  assert.match(markup, /<code>code<\/code>/u);
  assert.match(markup, /<ol><li>Listed<\/li><\/ol>/u);
  assert.match(markup, /<blockquote><p>Quoted<\/p><\/blockquote>/u);
  assert.match(markup, /class="editorial-image-grid"/u);
  assert.match(markup, /class="recipe-grid"/u);
  assert.match(markup, /class="editorial-card-grid"/u);
  assert.match(markup, /class="editorial-card-grid editorial-card-grid-empty"/u);
  assert.match(markup, /class="gallery-callout"/u);
  assert.match(markup, /data-contact-form-boundary="unavailable"/u);
  assert.match(markup, /class="editorial-featured-image"/u);
  assert.match(markup, new RegExp(`width="${dimensions.width}"`));
  assert.match(markup, new RegExp(`height="${dimensions.height}"`));
  assert.match(
    markup,
    new RegExp(
      `<img(?=[^>]*class="editorial-card-image")(?=[^>]*width="${cardDimensions.width}")`
      + `(?=[^>]*height="${cardDimensions.height}")[^>]*>`
    )
  );
  assert.match(markup, /href="\/table-setting\/?"/u);
  assert.match(markup, /href="\/gallery\/?"/u);
  assert.doesNotMatch(markup, /<form/u);
  assert.doesNotMatch(markup, /dangerouslySetInnerHTML/u);
});

test("editorial headings and content-card headings are contextual without changing source text", () => {
  const source = page("wordpress:page:4");
  const recipe = recipeCatalog.find((candidate) => candidate.locale === "en");
  assert.ok(recipe);
  assert.ok(source.title);
  const gridOnly = editorialPageRecordSchema.parse({
    ...source,
    id: "test:editorial:grid-only",
    canonicalPath: "/editorial-grid-only/",
    translationGroupId: null,
    source: {
      ...source.source,
      postId: 999_010,
      sourcePath: "/editorial-grid-only/"
    },
    title: "Grid-only page",
    excerpt: null,
    content: [{ type: "recipeCardGrid", recipeIds: [recipe.id] }],
    featuredMediaId: null,
    featuredMediaAlt: null,
    media: null,
    redirectFrom: []
  });
  const nested = editorialPageRecordSchema.parse({
    ...gridOnly,
    id: "test:editorial:nested-headings",
    canonicalPath: "/editorial-nested-headings/",
    source: {
      ...gridOnly.source,
      postId: 999_011,
      sourcePath: "/editorial-nested-headings/"
    },
    title: "Nested heading page",
    content: [
      {
        type: "heading",
        level: 1,
        children: [{ type: "text", value: "Source H1 wording" }]
      },
      { type: "recipeCardGrid", recipeIds: [recipe.id] },
      { type: "editorialPageCardGrid", pageIds: [source.id] },
      {
        type: "heading",
        level: 5,
        children: [{ type: "text", value: "Deep source wording" }]
      }
    ]
  });

  const gridMarkup = renderToStaticMarkup(createElement(EditorialPage, {
    editorialCatalog: [gridOnly],
    galleries: [],
    page: gridOnly,
    recipeCatalog
  }));
  const nestedMarkup = renderToStaticMarkup(createElement(EditorialPage, {
    editorialCatalog: [source, nested],
    galleries: [],
    page: nested,
    recipeCatalog
  }));
  const landingMarkup = renderToStaticMarkup(createElement(LandingPage, {
    catalog: recipeCatalog,
    locale: "en",
    page: 1
  }));

  assert.equal((gridMarkup.match(/<h1>/gu) ?? []).length, 1);
  assert.equal(gridMarkup.includes(`<h2>${recipe.title}</h2>`), true);
  assert.equal((nestedMarkup.match(/<h1>/gu) ?? []).length, 1);
  assert.match(nestedMarkup, /<h2>Source H1 wording<\/h2>/u);
  assert.equal(nestedMarkup.includes(`<h3>${recipe.title}</h3>`), true);
  assert.equal(nestedMarkup.includes(`<h3>${source.title}</h3>`), true);
  assert.match(nestedMarkup, /<h3>Deep source wording<\/h3>/u);
  assert.match(landingMarkup, /<h2 id="catalog-title">/u);
  assert.equal(landingMarkup.includes(`<h3>${recipe.title}</h3>`), true);
});

test("gallery rendering, sitemap, and static redirects close the public route set", () => {
  const gallery = galleryCatalog[0]!;
  const markup = renderToStaticMarkup(createElement(GalleryPage, { gallery }));
  const firstImage = gallery.images[0];
  assert.ok(firstImage);
  assert.ok(firstImage.thumbnailMediaId);
  const firstThumbnail = gallery.media?.find(
    (media) => media.id === firstImage.thumbnailMediaId
  );
  assert.ok(firstThumbnail);
  const dimensions = getEditorialGalleryMediaDimensions(firstThumbnail.path);
  assert.notDeepEqual(dimensions, { width: 1200, height: 800 });
  const summary = validatePublicContentBehavior(recipeCatalog, editorialCatalog, galleryCatalog);
  const paths = sitemap().map((entry) => new URL(entry.url).pathname);
  const editorial = page("wordpress:page:4");
  const redirectingEditorial = editorialPageRecordSchema.parse({
    ...editorial,
    id: "test:editorial:redirect",
    canonicalPath: "/editorial-redirect/",
    source: {
      ...editorial.source,
      postId: 999_002,
      sourcePath: "/editorial-redirect/"
    },
    redirectFrom: ["/old-editorial/"]
  });

  assert.match(markup, /class="gallery-grid"/u);
  assert.match(markup, /<img/u);
  assert.equal(markup.includes(encodeURIComponent(firstThumbnail.path)), true);
  assert.match(markup, new RegExp(`width="${dimensions.width}"`));
  assert.match(markup, new RegExp(`height="${dimensions.height}"`));
  assert.equal(summary.staticPaths, 624);
  assert.equal(summary.sitemapPaths, 621);
  for (const path of [
    "/about-2/",
    "/fr/contact-2/",
    "/ru/kontact/",
    "/gallery/"
  ]) {
    assert.equal(paths.includes(path), true);
  }
  assert.deepEqual(
    createExactRedirectManifest([], [redirectingEditorial]).redirects,
    [{
      source: "/old-editorial/",
      destination: "/editorial-redirect/",
      status: 301
    }]
  );
  assert.throws(
    () => validatePublicContentBehavior(
      [recipeCatalog[0]!],
      [editorialPageRecordSchema.parse({
        ...editorial,
        id: "test:editorial:recipe-collision",
        canonicalPath: `/recipes/${recipeCatalog[0]!.slug}/`,
        source: {
          ...editorial.source,
          postId: 999_003,
          sourcePath: `/recipes/${recipeCatalog[0]!.slug}/`
        }
      })],
      []
    ),
    /Public static routes are not unique/
  );
});
