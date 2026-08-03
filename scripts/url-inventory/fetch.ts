import { lstat, readFile, stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { maxRedirects } from "./constants";
import { isHttpSource, validateRemoteSitemapSource } from "./sources";
import type { InventoryLimits, SitemapFetchResult } from "./types";

async function cancelResponseBody(response: Response) {
  if (!response.body) {
    return;
  }
  try {
    await response.body.cancel();
  } catch {
    // The body may already have been canceled by its reader.
  }
}

function responseContentLength(response: Response) {
  const value = response.headers.get("content-length");
  if (!value || !/^\d+$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readResponseBody(
  response: Response,
  source: string,
  maxBytes: number
): Promise<Buffer> {
  const contentLength = responseContentLength(response);
  if (contentLength !== undefined && contentLength > maxBytes) {
    await cancelResponseBody(response);
    throw new Error(
      `Sitemap response "${source}" exceeds the ${maxBytes}-byte compressed input document limit.`
    );
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new Error(
          `Sitemap response "${source}" exceeds the ${maxBytes}-byte compressed input document limit.`
        );
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Cancellation is best effort after a stream failure.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

function hasGzipMagic(bytes: Uint8Array) {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function looksLikeXml(bytes: Uint8Array) {
  const prefix = Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/u, "").trimStart();
  return prefix.startsWith("<");
}

function hasGzipCue(source: string, contentEncoding?: string, contentType?: string) {
  return (
    /\.gz(?:[?#]|$)/iu.test(source)
    || /\bgzip\b/iu.test(contentEncoding ?? "")
    || /(?:application|content)\/(?:x-)?gzip/iu.test(contentType ?? "")
  );
}

async function decompressGzip(
  compressed: Buffer,
  source: string,
  maxBytes: number
) {
  const gunzip = createGunzip();
  const chunks: Buffer[] = [];
  let bytes = 0;
  const collect = (async () => {
    for await (const chunk of gunzip) {
      const output = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += output.byteLength;
      if (bytes > maxBytes) {
        throw new Error(
          `Gzip sitemap "${source}" exceeds the ${maxBytes}-byte decompressed document limit.`
        );
      }
      chunks.push(output);
    }
  })();

  try {
    gunzip.end(compressed);
    await collect;
  } catch (error) {
    gunzip.destroy();
    if (
      error instanceof Error
      && error.message.includes("decompressed document limit")
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to decompress gzip sitemap "${source}": ${message}`, {
      cause: error
    });
  }

  return Buffer.concat(chunks, bytes);
}

export async function decodeSitemapBody(
  body: string | Uint8Array,
  source: string,
  maxBytes: number,
  metadata: Pick<SitemapFetchResult, "contentEncoding" | "contentType"> = {}
) {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  const gzipMagic = hasGzipMagic(bytes);
  const gzipCue = hasGzipCue(source, metadata.contentEncoding, metadata.contentType);
  if (gzipMagic || (gzipCue && !looksLikeXml(bytes))) {
    return (await decompressGzip(bytes, source, maxBytes)).toString("utf8");
  }
  if (bytes.byteLength > maxBytes) {
    throw new Error(
      `Sitemap document "${source}" exceeds the ${maxBytes}-byte decompressed document limit.`
    );
  }
  return bytes.toString("utf8");
}

export async function defaultFetchDocument(
  source: string,
  limits: InventoryLimits
): Promise<SitemapFetchResult> {
  if (!isHttpSource(source)) {
    let fileStats;
    try {
      const sourceStats = await lstat(source);
      if (sourceStats.isSymbolicLink()) {
        throw new Error(`Refusing symlinked local sitemap source: "${source}".`);
      }
      fileStats = await stat(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read sitemap file "${source}": ${message}`, { cause: error });
    }
    if (!fileStats.isFile()) {
      throw new Error(`Unable to read sitemap file "${source}": not a regular file.`);
    }
    if (fileStats.size > limits.maxDocumentBytes) {
      throw new Error(
        `Sitemap file "${source}" exceeds the ${limits.maxDocumentBytes}-byte compressed input document limit.`
      );
    }
    try {
      return { body: await readFile(source) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read sitemap file "${source}": ${message}`, { cause: error });
    }
  }

  let currentSource = validateRemoteSitemapSource(source);
  let redirects = 0;
  while (true) {
    const controller = new AbortController();
    let timedOut = false;
    let response: Response | undefined;
    let bodyCanceled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limits.requestTimeoutMs);
    const cancelBody = async () => {
      if (response && !bodyCanceled) {
        bodyCanceled = true;
        await cancelResponseBody(response);
      }
    };

    try {
      response = await fetch(currentSource, {
        headers: {
          accept: "application/xml,text/xml;q=0.9,*/*;q=0.1",
          "user-agent": "MyCafeGourmand URL inventory (read-only)"
        },
        redirect: "manual",
        signal: controller.signal
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await cancelBody();
        if (redirects >= maxRedirects) {
          throw new Error(`Sitemap redirect limit of ${maxRedirects} was exceeded.`);
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`Sitemap redirect from "${currentSource}" has no Location header.`);
        }
        let nextSource: string;
        try {
          nextSource = new URL(location, currentSource).toString();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Invalid sitemap redirect target "${location}": ${message}`, {
            cause: error
          });
        }
        currentSource = validateRemoteSitemapSource(nextSource);
        redirects += 1;
        continue;
      }

      if (!response.ok) {
        await cancelBody();
        throw new Error(`Unable to fetch sitemap "${source}": HTTP ${response.status}.`);
      }

      const body = await readResponseBody(response, source, limits.maxDocumentBytes);
      const contentEncoding = response.headers.get("content-encoding");
      const contentType = response.headers.get("content-type");
      return {
        body,
        status: response.status,
        finalSource: currentSource,
        ...(contentEncoding ? { contentEncoding } : {}),
        ...(contentType ? { contentType } : {})
      };
    } catch (error) {
      await cancelBody();
      if (timedOut) {
        throw new Error(
          `Unable to fetch sitemap "${source}": request timed out after ` +
          `${limits.requestTimeoutMs} ms.`,
          { cause: error }
        );
      }
      if (
        error instanceof Error
        && (
          error.message.includes("document limit")
          || error.message.includes("redirect")
          || error.message.includes("Location")
          || error.message.includes("allowed")
          || error.message.includes("private")
          || error.message.includes("credentials")
          || error.message.includes("port")
          || error.message.includes("HTTP ")
        )
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to fetch sitemap "${source}": ${message}`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}
