import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFunction, assertPrivateLoopbackUrl } from "./lifecycle-controls.mjs";
test("fixture extraction preserves the exact named production function", () => {
  const source =
    'function before() {}\nfunction target(a: string) { return a + "{}"; }\nfunction after() {}';
  assert.equal(
    extractFunction(source, "target"),
    'function target(a: string) { return a + "{}"; }',
  );
  assert.throws(() => extractFunction(source, "missing"), /Missing production function/);
});
test("browser runner can only use its owned loopback transport", () => {
  assert.equal(assertPrivateLoopbackUrl("http://127.0.0.1:8427").port, "8427");
  for (const url of ["https://127.0.0.1:8427", "http://localhost:8319", "http://example.com"])
    assert.throws(() => assertPrivateLoopbackUrl(url));
});
