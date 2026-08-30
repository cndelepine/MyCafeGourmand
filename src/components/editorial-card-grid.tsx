import Image from "next/image";
import Link from "next/link";
import { getEditorialGalleryMediaDimensions } from "@/content/editorial-media-manifest";
import type { EditorialPageRecord } from "@/content/editorial-schema";
import { resolveManagedMediaUrl } from "@/lib/recipe-media";
import { getEditorialPath } from "@/lib/editorial-routes";
import { ContentHeading } from "./content-heading";

type EditorialCardGridProps = {
  readonly headingLevel?: number;
  readonly pages: readonly EditorialPageRecord[];
  readonly viewPage: string;
};

export function EditorialCardGrid({
  headingLevel = 3,
  pages,
  viewPage
}: EditorialCardGridProps) {
  return (
    <div className="editorial-card-grid">
      {pages.map((page) => {
        const featured = page.featuredMediaId === null
          ? undefined
          : page.media?.find((media) => media.id === page.featuredMediaId);
        const dimensions = featured === undefined
          ? undefined
          : getEditorialGalleryMediaDimensions(featured.path);

        return (
          <article className="editorial-card" key={page.id}>
            {featured && dimensions ? (
              <Image
                alt={page.featuredMediaAlt ?? ""}
                className="editorial-card-image"
                height={dimensions.height}
                sizes="(max-width: 700px) 100vw, 50vw"
                src={resolveManagedMediaUrl(featured.path)}
                width={dimensions.width}
              />
            ) : null}
            <div className="editorial-card-copy">
              {page.title ? <ContentHeading level={headingLevel}>{page.title}</ContentHeading> : null}
              {page.excerpt ? <p>{page.excerpt}</p> : null}
              <Link className="jump-link" href={getEditorialPath(page)}>
                {viewPage} <span aria-hidden="true">→</span>
              </Link>
            </div>
          </article>
        );
      })}
    </div>
  );
}
