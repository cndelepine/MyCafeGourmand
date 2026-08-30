import Image from "next/image";
import { Fragment, type ReactNode } from "react";
import type {
  EditorialPageRecord,
  RichTextBlock,
  RichTextInline
} from "@/content/editorial-schema";
import { getEditorialGalleryMediaDimensions } from "@/content/editorial-media-manifest";
import type { GalleryRecord } from "@/content/gallery-schema";
import type { RecipeRecord } from "@/content/schema";
import { createRecipeCatalogEntries } from "@/lib/recipe-catalog-data";
import { resolveManagedMediaUrl } from "@/lib/recipe-media";
import { EditorialCardGrid } from "./editorial-card-grid";
import { ContactFormBoundary } from "./contact-form-boundary";
import { ContentHeading } from "./content-heading";
import { RecipeCardGrid } from "./recipe-card-grid";

type EditorialContentLabels = {
  readonly emptyCardGrid: string;
  readonly gallery: string;
  readonly viewPage: string;
  readonly viewRecipe: string;
};

type EditorialContentProps = {
  readonly editorialCatalog: readonly EditorialPageRecord[];
  readonly galleries: readonly GalleryRecord[];
  readonly labels: EditorialContentLabels;
  readonly page: EditorialPageRecord;
  readonly recipeCatalog: readonly RecipeRecord[];
};

type EditorialRenderContext = {
  readonly cardHeadingLevel: number;
  readonly sourceHeadingLevel: number;
};

type MediaMap = ReadonlyMap<string, EditorialPageRecord["media"] extends readonly (infer T)[] | null
  ? T
  : never>;

function renderInline(children: readonly RichTextInline[]): ReactNode {
  return children.map((child, index) => {
    const key = `${child.type}-${index}`;
    switch (child.type) {
      case "text":
        return <Fragment key={key}>{child.value}</Fragment>;
      case "code":
        return <code key={key}>{child.value}</code>;
      case "break":
        return <br key={key} />;
      case "emphasis":
        return <em key={key}>{renderInline(child.children)}</em>;
      case "strong":
        return <strong key={key}>{renderInline(child.children)}</strong>;
      case "link":
        return <a href={child.href} key={key}>{renderInline(child.children)}</a>;
    }
  });
}

function renderHeading(level: number, children: readonly RichTextInline[], key: string) {
  return (
    <ContentHeading key={key} level={level}>
      {renderInline(children)}
    </ContentHeading>
  );
}

function getMedia(media: MediaMap, mediaId: string) {
  const asset = media.get(mediaId);
  if (asset === undefined) {
    throw new Error(`Validated editorial media is missing at render time: ${mediaId}`);
  }
  return asset;
}

function EditorialImage({
  alt,
  caption,
  media,
  mediaId
}: {
  readonly alt: string | null;
  readonly caption: string | null;
  readonly media: MediaMap;
  readonly mediaId: string;
}) {
  const asset = getMedia(media, mediaId);
  const dimensions = getEditorialGalleryMediaDimensions(asset.path);
  return (
    <figure className="editorial-figure">
      <Image
        alt={alt ?? ""}
        className="editorial-image"
        height={dimensions.height}
        sizes="(max-width: 700px) 100vw, 900px"
        src={resolveManagedMediaUrl(asset.path)}
        width={dimensions.width}
      />
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

function renderBlockquoteChild(
  child: Extract<RichTextBlock, { type: "paragraph" | "list" }>,
  key: string
) {
  if (child.type === "paragraph") {
    return <p key={key}>{renderInline(child.children)}</p>;
  }
  const List = child.ordered ? "ol" : "ul";
  return (
    <List key={key}>
      {child.items.map((item, index) => (
        <li key={index}>{renderInline(item.children)}</li>
      ))}
    </List>
  );
}

function orderedReferences<T extends { id: string }>(
  ids: readonly string[],
  records: readonly T[]
) {
  const byId = new Map(records.map((record) => [record.id, record] as const));
  return ids.map((id) => {
    const record = byId.get(id);
    if (record === undefined) {
      throw new Error(`Validated editorial reference is missing at render time: ${id}`);
    }
    return record;
  });
}

function renderBlock(
  block: RichTextBlock,
  index: number,
  props: EditorialContentProps,
  media: MediaMap,
  context: EditorialRenderContext
): ReactNode {
  const key = `${block.type}-${index}`;
  switch (block.type) {
    case "paragraph":
      return <p key={key}>{renderInline(block.children)}</p>;
    case "heading":
      return renderHeading(context.sourceHeadingLevel, block.children, key);
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List key={key}>
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item.children)}</li>
          ))}
        </List>
      );
    }
    case "blockquote":
      return (
        <blockquote key={key}>
          {block.children.map((child, childIndex) =>
            renderBlockquoteChild(child, `${key}-${childIndex}`)
          )}
        </blockquote>
      );
    case "image":
      return (
        <EditorialImage
          alt={block.alt}
          caption={block.caption}
          key={key}
          media={media}
          mediaId={block.mediaId}
        />
      );
    case "imageGrid":
      return (
        <ul className="editorial-image-grid" key={key}>
          {block.images.map((image, imageIndex) => (
            <li key={`${image.mediaId}-${imageIndex}`}>
              <EditorialImage
                alt={image.alt}
                caption={image.caption}
                media={media}
                mediaId={image.mediaId}
              />
            </li>
          ))}
        </ul>
      );
    case "emptyCardGrid":
      return (
        <section
          aria-label={props.labels.emptyCardGrid}
          className="editorial-card-grid editorial-card-grid-empty"
          key={key}
        >
          <p>{props.labels.emptyCardGrid}</p>
        </section>
      );
    case "recipeCardGrid":
      return (
        <RecipeCardGrid
          headingLevel={context.cardHeadingLevel}
          key={key}
          recipes={createRecipeCatalogEntries(
            orderedReferences(block.recipeIds, props.recipeCatalog)
          )}
          viewRecipe={props.labels.viewRecipe}
        />
      );
    case "editorialPageCardGrid":
      return (
        <EditorialCardGrid
          headingLevel={context.cardHeadingLevel}
          key={key}
          pages={orderedReferences(block.pageIds, props.editorialCatalog)}
          viewPage={props.labels.viewPage}
        />
      );
    case "galleryCallout": {
      const gallery = orderedReferences([block.galleryId], props.galleries)[0];
      if (gallery === undefined) {
        throw new Error(`Validated gallery reference is missing at render time: ${block.galleryId}`);
      }
      return (
        <aside className="gallery-callout" key={key}>
          {gallery.title ? (
            <ContentHeading level={context.cardHeadingLevel}>
              {gallery.title}
            </ContentHeading>
          ) : null}
          {gallery.description ? <p>{gallery.description}</p> : null}
          <a className="jump-link" href={gallery.canonicalPath}>
            {props.labels.gallery} <span aria-hidden="true">→</span>
          </a>
        </aside>
      );
    }
    case "contactForm":
      return <ContactFormBoundary key={key} locale={props.page.locale} />;
  }
}

function sourceHeadingLevel(level: number, previousLevel: number) {
  const minimum = previousLevel === 0 ? 1 : 2;
  const maximum = previousLevel === 0 ? 1 : Math.min(previousLevel + 1, 6);
  return Math.max(minimum, Math.min(level, maximum));
}

function cardHeadingLevel(previousLevel: number) {
  return Math.min(Math.max(previousLevel, 1) + 1, 6);
}

function contextualBlocks(page: EditorialPageRecord) {
  let previousHeadingLevel = page.title === null ? 0 : 1;
  return (page.content ?? []).map((block, index) => {
    const normalizedSourceHeadingLevel = block.type === "heading"
      ? sourceHeadingLevel(block.level, previousHeadingLevel)
      : previousHeadingLevel;
    const normalizedCardHeadingLevel = cardHeadingLevel(previousHeadingLevel);
    if (block.type === "heading") {
      previousHeadingLevel = normalizedSourceHeadingLevel;
    }
    return {
      block,
      index,
      context: {
        cardHeadingLevel: normalizedCardHeadingLevel,
        sourceHeadingLevel: normalizedSourceHeadingLevel
      }
    };
  });
}

export function EditorialContent(props: EditorialContentProps) {
  const media = new Map((props.page.media ?? []).map((asset) => [asset.id, asset] as const));
  const blocks = contextualBlocks(props.page);
  return (
    <div className="editorial-prose">
      {blocks.map(({ block, context, index }) => renderBlock(block, index, props, media, context))}
    </div>
  );
}
