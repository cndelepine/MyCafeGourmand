import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import {
  createServer,
  type RequestListener,
  type Server
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { verifyAzureRecipeMedia } from "../scripts/verify-azure-recipe-media";

const objectKey = "/recipes/media/wordpress/900.jpg";
const expectedBytes = Buffer.from("verified fixture media", "utf8");
const editorialObjectKey = "/editorial/media/wordpress/901.jpg";
const editorialBytes = Buffer.from("verified editorial fixture media", "utf8");

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error === undefined ? resolve() : reject(error))
  );
}

function createTestServer(handler: RequestListener) {
  return createServer(handler);
}

function createPrivateUploadManifest(directory: string) {
  const staging = path.join(directory, "migration-output", "stage");
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  chmodSync(path.join(directory, "migration-output"), 0o700);
  chmodSync(staging, 0o700);
  const manifest = path.join(staging, "upload-manifest.json");
  writeFileSync(
    manifest,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "recipe-media-upload-plan",
      entries: [{
        key: objectKey,
        bytes: expectedBytes.byteLength,
        sha256: sha256(expectedBytes),
        sourceAttachmentId: "900",
        contentType: "image/jpeg"
      }]
    })}\n`,
    { mode: 0o600 }
  );
  chmodSync(manifest, 0o600);
}

function createPrivateEditorialUploadManifest(directory: string) {
  const staging = path.join(directory, "migration-output", "editorial-stage");
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  chmodSync(path.join(directory, "migration-output"), 0o700);
  chmodSync(staging, 0o700);
  const manifest = path.join(staging, "upload-manifest.json");
  writeFileSync(
    manifest,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "editorial-gallery-media-upload-plan",
      entries: [{
        key: editorialObjectKey,
        bytes: editorialBytes.byteLength,
        sha256: sha256(editorialBytes),
        contentType: "image/jpeg"
      }]
    })}\n`,
    { mode: 0o600 }
  );
  chmodSync(manifest, 0o600);
}

function verify(directory: string, origin: string) {
  return verifyAzureRecipeMedia({
    accountName: "fixtureaccount",
    container: "media",
    repositoryRoot: directory,
    timeoutMs: 1_000,
    uploadDir: "migration-output/stage"
  }, {
    testBlobOrigin: origin
  });
}

async function withVerifierFixture(
  handler: RequestListener,
  callback: (values: { readonly directory: string; readonly origin: string }) => Promise<void>
) {
  const directory = mkdtempSync(path.join(process.cwd(), ".azure-media-verifier-test-"));
  createPrivateUploadManifest(directory);
  const server = createTestServer(handler);
  try {
    await callback({ directory, origin: await listen(server) });
  } finally {
    await close(server);
    rmSync(directory, { force: true, recursive: true });
  }
}

test("Azure media verification streams and hashes served bytes", async () => {
  await withVerifierFixture((request, response) => {
    assert.equal(request.url, "/media/recipes/media/wordpress/900.jpg");
    response.writeHead(200, {
      "content-length": String(expectedBytes.byteLength),
      "content-type": "image/jpeg"
    });
    response.end(expectedBytes);
  }, async ({ directory, origin }) => {
    const result = await verify(directory, origin);
    assert.deepEqual(result, {
      schemaVersion: 1,
      kind: "azure-recipe-media-verification",
      objects: 1,
      bytes: expectedBytes.byteLength,
      unavailable: 0,
      statusFailures: 0,
      streamFailures: 0,
      sizeMismatches: 0,
      sha256Mismatches: 0,
      contentTypeMismatches: 0
    });
  });
});

test("Azure media verification combines disjoint recipe and editorial plans", async () => {
  await withVerifierFixture((request, response) => {
    if (request.url === "/media/recipes/media/wordpress/900.jpg") {
      response.writeHead(200, {
        "content-length": String(expectedBytes.byteLength),
        "content-type": "image/jpeg"
      });
      response.end(expectedBytes);
      return;
    }
    assert.equal(request.url, "/media/editorial/media/wordpress/901.jpg");
    response.writeHead(200, {
      "content-length": String(editorialBytes.byteLength),
      "content-type": "image/jpeg"
    });
    response.end(editorialBytes);
  }, async ({ directory, origin }) => {
    createPrivateEditorialUploadManifest(directory);
    const result = await verifyAzureRecipeMedia({
      accountName: "fixtureaccount",
      container: "media",
      repositoryRoot: directory,
      timeoutMs: 1_000,
      uploadDirs: ["migration-output/stage", "migration-output/editorial-stage"]
    }, {
      testBlobOrigin: origin
    });
    assert.equal(result.objects, 2);
    assert.equal(result.bytes, expectedBytes.byteLength + editorialBytes.byteLength);
    assert.equal(result.unavailable, 0);
  });
});

test("Azure media verification rejects duplicate object keys across plans", async () => {
  await withVerifierFixture((_, response) => {
    response.writeHead(500);
    response.end();
  }, async ({ directory, origin }) => {
    const duplicate = path.join(directory, "migration-output", "duplicate-stage");
    mkdirSync(duplicate, { recursive: true, mode: 0o700 });
    chmodSync(duplicate, 0o700);
    writeFileSync(
      path.join(duplicate, "upload-manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "recipe-media-upload-plan",
        entries: [{
          key: objectKey,
          bytes: expectedBytes.byteLength,
          sha256: sha256(expectedBytes),
          sourceAttachmentId: "900",
          contentType: "image/jpeg"
        }]
      })}\n`,
      { mode: 0o600 }
    );
    chmodSync(path.join(duplicate, "upload-manifest.json"), 0o600);
    await assert.rejects(
      verifyAzureRecipeMedia({
        accountName: "fixtureaccount",
        container: "media",
        repositoryRoot: directory,
        timeoutMs: 1_000,
        uploadDirs: ["migration-output/stage", "migration-output/duplicate-stage"]
      }, { testBlobOrigin: origin }),
      (error: unknown) =>
        error instanceof Error
        && "code" in error
        && error.code === "duplicate-upload-object-key"
    );
  });
});

test("Azure media verification rejects wrong same-size served bytes", async () => {
  await withVerifierFixture((_, response) => {
    const wrong = Buffer.from(expectedBytes);
    wrong[0] = wrong[0]! ^ 0xff;
    response.writeHead(200, {
      "content-length": String(wrong.byteLength),
      "content-type": "image/jpeg"
    });
    response.end(wrong);
  }, async ({ directory, origin }) => {
    const result = await verify(directory, origin);
    assert.equal(result.sizeMismatches, 0);
    assert.equal(result.sha256Mismatches, 1);
    assert.equal(result.unavailable, 0);
  });
});

test("Azure media verification normalizes and validates served content types", async () => {
  await withVerifierFixture((_, response) => {
    response.writeHead(200, {
      "content-length": String(expectedBytes.byteLength),
      "content-type": "IMAGE/JPEG; charset=binary"
    });
    response.end(expectedBytes);
  }, async ({ directory, origin }) => {
    const result = await verify(directory, origin);
    assert.equal(result.contentTypeMismatches, 0);
  });

  await withVerifierFixture((_, response) => {
    response.writeHead(200, {
      "content-length": String(expectedBytes.byteLength),
      "content-type": "image/png"
    });
    response.end(expectedBytes);
  }, async ({ directory, origin }) => {
    const result = await verify(directory, origin);
    assert.equal(result.contentTypeMismatches, 1);
    assert.equal(result.unavailable, 0);
    assert.equal(result.sha256Mismatches, 0);
  });
});

test("Azure media verification rejects a redirect to a different host without following it", async () => {
  let redirectedRequests = 0;
  const target = createTestServer((_, response) => {
    redirectedRequests += 1;
    response.writeHead(200, {
      "content-length": String(expectedBytes.byteLength),
      "content-type": "image/jpeg"
    });
    response.end(expectedBytes);
  });
  const targetOrigin = await listen(target);
  try {
    await withVerifierFixture((_, response) => {
      response.writeHead(302, {
        location: `${targetOrigin}/media/recipes/media/wordpress/900.jpg`
      });
      response.end();
    }, async ({ directory, origin }) => {
      const result = await verify(directory, origin);
      assert.equal(result.unavailable, 1);
      assert.equal(result.statusFailures, 1);
      assert.equal(redirectedRequests, 0);
    });
  } finally {
    await close(target);
  }
});

test("Azure media verification rejects truncated and oversized streams", async () => {
  await withVerifierFixture((_, response) => {
    response.writeHead(200, {
      "content-type": "image/jpeg",
      "transfer-encoding": "chunked"
    });
    response.end(expectedBytes.subarray(0, expectedBytes.byteLength - 1));
  }, async ({ directory, origin }) => {
    const result = await verify(directory, origin);
    assert.equal(result.sizeMismatches, 1);
    assert.equal(result.sha256Mismatches, 1);
  });

  await withVerifierFixture((_, response) => {
    response.writeHead(200, {
      "content-type": "image/jpeg",
      "transfer-encoding": "chunked"
    });
    response.end(Buffer.concat([expectedBytes, Buffer.from("x", "utf8")]));
  }, async ({ directory, origin }) => {
    const result = await verify(directory, origin);
    assert.equal(result.sizeMismatches, 1);
    assert.equal(result.sha256Mismatches, 0);
  });
});

test("Azure media verification reports non-success response status without source details", async () => {
  await withVerifierFixture((_, response) => {
    response.writeHead(404, { "content-length": "0" });
    response.end();
  }, async ({ directory, origin }) => {
    const result = await verify(directory, origin);
    assert.deepEqual(
      {
        unavailable: result.unavailable,
        statusFailures: result.statusFailures,
        streamFailures: result.streamFailures,
        sizeMismatches: result.sizeMismatches,
        sha256Mismatches: result.sha256Mismatches
      },
      {
        unavailable: 1,
        statusFailures: 1,
        streamFailures: 0,
        sizeMismatches: 0,
        sha256Mismatches: 0
      }
    );
  });
});
