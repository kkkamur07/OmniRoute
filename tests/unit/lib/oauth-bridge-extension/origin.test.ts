import test from "node:test";
import assert from "node:assert/strict";

import { tabOrigin } from "../../../../packages/oauth-bridge-extension/src/origin.js";

test("http(s) tab URLs yield their origin", () => {
  assert.equal(
    tabOrigin({ url: "https://omni.example.com/dashboard/providers" }),
    "https://omni.example.com"
  );
  assert.equal(
    tabOrigin({ url: "http://192.168.0.15:20128/dashboard?x=1#y" }),
    "http://192.168.0.15:20128"
  );
});

test("a tab without url (no activeTab / host permission) yields null", () => {
  assert.equal(tabOrigin({}), null);
  assert.equal(tabOrigin({ url: "" }), null);
  assert.equal(tabOrigin(null), null);
  assert.equal(tabOrigin(undefined), null);
});

test("non-web pages and malformed URLs yield null", () => {
  for (const url of ["chrome://extensions/", "file:///tmp/a.html", "about:blank", "not a url"]) {
    assert.equal(tabOrigin({ url }), null, url);
  }
  assert.equal(tabOrigin({ url: 42 as unknown as string }), null);
});
