import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { readBoundedDeploymentFile, writeNewDeploymentFile } from "../scripts/deployment-files";

function temporary(operation: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".deployment-files-test-"));
  try {
    operation(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("deployment reads bind bytes to a bounded stable descriptor", (context) => {
  temporary((root) => {
    const file = path.join(root, "file.txt");
    fs.writeFileSync(file, "original");
    assert.equal(readBoundedDeploymentFile(root, "file.txt", 8).toString(), "original");
    assert.throws(() => readBoundedDeploymentFile(root, "file.txt", 7), /bounded/u);
    const read = fs.readSync;
    let changed = false;
    const mocked = context.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
      if (!changed) {
        changed = true;
        fs.writeFileSync(file, "modified and larger");
      }
      return read(...args);
    });
    try {
      assert.throws(() => readBoundedDeploymentFile(root, "file.txt", 8), /identity changed/u);
    } finally {
      mocked.mock.restore();
    }
  });
});

test("deployment metadata creation is exclusive and preserves existing bytes", () => {
  temporary((root) => {
    const file = path.join(root, "metadata.json");
    writeNewDeploymentFile(file, "{}\n");
    assert.throws(() => writeNewDeploymentFile(file, "replaced"), /already exists/u);
    assert.equal(fs.readFileSync(file, "utf8"), "{}\n");
  });
});
