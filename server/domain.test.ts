import assert from "node:assert/strict";
import test from "node:test";
import { normalizedKeyboardKey } from "../app/keyboard.js";
import { normalizeEmail, normalizePhone } from "./domain.js";

test("UAE phone normalization identifies common duplicate formats", () => {
  assert.equal(normalizePhone("050 123 4567"), "971501234567");
  assert.equal(normalizePhone("+971 50 123 4567"), "971501234567");
  assert.equal(normalizePhone("00971-50-123-4567"), "971501234567");
});

test("normalizers safely handle malformed values", () => {
  assert.equal(normalizePhone(undefined), "");
  assert.equal(normalizeEmail(null), "");
  assert.equal(normalizedKeyboardKey(undefined), "");
  assert.equal(normalizedKeyboardKey({}), "");
  assert.equal(normalizedKeyboardKey({ key: "K" }), "k");
  assert.equal(normalizedKeyboardKey({ key: 42 }), "");
});
