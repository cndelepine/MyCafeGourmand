import assert from "node:assert/strict";
import test from "node:test";
import { scaleQuantity } from "../src/lib/scale-quantity";

test("scales parsed values while preserving the source text", () => {
  const scaled = scaleQuantity({
    raw: "1 1/2 cups",
    value: 1.5,
    unit: "cups",
    scalable: true
  }, 2);

  assert.equal(scaled.raw, "1 1/2 cups");
  assert.equal(scaled.value, 3);
});

test("does not alter quantities that were not safely parsed", () => {
  const quantity = {
    raw: "salt to taste",
    unit: null,
    scalable: false
  } as const;

  assert.equal(scaleQuantity(quantity, 3), quantity);
});

test("rejects invalid scale factors", () => {
  assert.throws(
    () => scaleQuantity({ raw: "1 cup", value: 1, unit: "cup", scalable: true }, 0),
    /positive finite/
  );
});
