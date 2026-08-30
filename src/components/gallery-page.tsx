import Image from "next/image";
import { getEditorialGalleryMediaDimensions } from "@/content/editorial-media-manifest";
import type { GalleryRecord } from "@/content/gallery-schema";
import {
  getGalleryStructuredData,
  serializeEditorialStructuredData
} from "@/lib/editorial-structured-data";
import { resolveManagedMediaUrl } from "@/lib/recipe-media";
import { SiteHeader } from "./site-header";

type GalleryPageProps = {
  readonly gallery: GalleryRecord;
};

function getGalleryMedia(gallery: GalleryRecord, mediaId: string) {
  const media = gallery.media?.find((candidate) => candidate.id === mediaId);
  if (media === undefined) {
    throw new Error(`Validated gallery media is missing at render time: ${mediaId}`);
  }
  return media;
}

export function GalleryPage({ gallery }: GalleryPageProps) {
  const structuredData = getGalleryStructuredData(gallery);

  return (
    <>
      <SiteHeader locale="en" page="gallery" />
      <main className="gallery-page">
        <header className="gallery-page-header">
          {gallery.title ? <h1>{gallery.title}</h1> : null}
          {gallery.description ? <p className="intro">{gallery.description}</p> : null}
        </header>
        <section aria-label={gallery.title ?? "Gallery"} className="gallery-grid">
          <ul>
            {gallery.images.map((image) => {
              const original = getGalleryMedia(gallery, image.originalMediaId);
              const display = image.thumbnailMediaId === null
                ? original
                : getGalleryMedia(gallery, image.thumbnailMediaId);
              const dimensions = getEditorialGalleryMediaDimensions(display.path);
              return (
                <li key={image.sourceImageId}>
                  <figure>
                    <a
                      aria-label={image.alt ?? image.caption ?? "Open image"}
                      href={resolveManagedMediaUrl(original.path)}
                    >
                      <Image
                        alt={image.alt ?? ""}
                        height={dimensions.height}
                        sizes="(max-width: 700px) 100vw, 33vw"
                        src={resolveManagedMediaUrl(display.path)}
                        width={dimensions.width}
                      />
                    </a>
                    {image.caption ? <figcaption>{image.caption}</figcaption> : null}
                  </figure>
                </li>
              );
            })}
          </ul>
        </section>
      </main>
      <footer>Made with care, one recipe at a time.</footer>
      <script type="application/ld+json">
        {serializeEditorialStructuredData(structuredData)}
      </script>
    </>
  );
}
