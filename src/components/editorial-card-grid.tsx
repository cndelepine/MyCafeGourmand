import Image from "next/image";
import Link from "next/link";
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

        return (
          <article className="editorial-card" key={page.id}>
            {featured ? (
              <Image
                alt={page.featuredMediaAlt ?? ""}
                className="editorial-card-image"
                height={featured.height ?? 800}
                sizes="(max-width: 700px) 100vw, 50vw"
                src={resolveManagedMediaUrl(featured.path)}
                width={featured.width ?? 1200}
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
