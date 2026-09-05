import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonAtBoundary } from "../src/content/json-boundary";

const options = { maxDepth: 8 };

test("strict JSON parsing preserves grammar-valid values", () => {
  const values = [
    "null",
    "true",
    "false",
    "\"escaped\\ntext\\t\\u00e9\\\\\\/\\\"\"",
    "0",
    "-0",
    "12",
    "-12.5",
    "6.022e23",
    "1E-9",
    "[]",
    "{}",
    "{\"array\":[null,true,false,0,-1.25e+2],\"nested\":{\"value\":\"ok\"}}"
  ];

  for (const value of values) {
    assert.deepEqual(parseJsonAtBoundary(value, options), JSON.parse(value));
  }
});

test("strict JSON parsing rejects malformed strings, numbers, and separators", () => {
  const values = [
    "",
    "undefined",
    "NaN",
    "Infinity",
    "+1",
    ".1",
    "01",
    "-01",
    "1.",
    "1e",
    "1e+",
    "\"unterminated",
    "\"bad\\xescape\"",
    "\"bad\\u123x\"",
    "\"raw\nnewline\"",
    "[1,]",
    "[,1]",
    "{\"key\":}",
    "{\"key\" 1}",
    "{\"key\":1,}",
    "{\"key\":1} trailing"
  ];

  for (const value of values) {
    assert.throws(
      () => parseJsonAtBoundary(value, options),
      Error,
      `Expected malformed JSON to fail: ${JSON.stringify(value)}`
    );
  }
});

test("strict JSON parsing rejects duplicate keys at every object depth", () => {
  assert.throws(
    () => parseJsonAtBoundary("{\"slug\":\"first\",\"slug\":\"second\"}", options),
    /Duplicate JSON object key "slug" in \$/
  );
  assert.throws(
    () => parseJsonAtBoundary(
      "{\"recipe\":{\"times\":{\"total\":1,\"total\":2}}}",
      options
    ),
    /Duplicate JSON object key "total" in \$\["recipe"\]\["times"\]/
  );
  assert.throws(
    () => parseJsonAtBoundary(
      "{\"groups\":[{\"name\":\"first\",\"name\":\"second\"}]}",
      options
    ),
    /Duplicate JSON object key "name" in \$\["groups"\]\[0\]/
  );
});

test("strict JSON parsing compares decoded keys rather than source spelling", () => {
  assert.throws(
    () => parseJsonAtBoundary(
      "{\"slug\":\"first\",\"sl\\u0075g\":\"second\"}",
      options
    ),
    /Duplicate JSON object key "slug"/
  );
  assert.throws(
    () => parseJsonAtBoundary(
      "{\"a/b\":1,\"a\\/b\":2}",
      options
    ),
    /Duplicate JSON object key "a\/b"/
  );
  assert.doesNotThrow(() =>
    parseJsonAtBoundary(
      "{\"first\":{\"id\":1},\"second\":{\"id\":2}}",
      options
    )
  );
});

test("strict JSON parsing enforces a positive bounded nesting depth", () => {
  assert.deepEqual(
    parseJsonAtBoundary("{\"one\":[{\"two\":true}]}", { maxDepth: 3 }),
    { one: [{ two: true }] }
  );
  assert.throws(
    () => parseJsonAtBoundary("{\"one\":[{\"two\":true}]}", { maxDepth: 2 }),
    /maximum depth of 2/
  );
  assert.throws(
    () => parseJsonAtBoundary("{}", { maxDepth: 0 }),
    /positive safe integer/
  );
  assert.throws(
    () => parseJsonAtBoundary("{}", { maxDepth: Number.MAX_SAFE_INTEGER + 1 }),
    /positive safe integer/
  );
});
