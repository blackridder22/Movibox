/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { policyLink } from "../src/moviebox/policy-links.ts";

test("bundled policy links stay inside the app instead of navigating its document", () => {
  assert.deepEqual(policyLink("LICENSE"), { document: "license" });
  assert.deepEqual(policyLink("./PRIVACY.md"), { document: "privacy" });
  assert.deepEqual(policyLink("USE_NOTICE.md"), { document: "use" });
  assert.deepEqual(policyLink("THIRD_PARTY_NOTICES.md"), { document: "third-party" });
  for (const href of ["/PRIVACY.md", "../LICENSE", "toString", "__proto__"])
    assert.equal(policyLink(href), null);
});

test("policy links cannot launch arbitrary schemes or forward embedded credentials", () => {
  assert.deepEqual(policyLink("https://www.torbox.app/terms"), {
    url: "https://www.torbox.app/terms",
  });
  assert.deepEqual(policyLink("mailto:br22.dev@gmail.com"), { url: "mailto:br22.dev@gmail.com" });
  for (const href of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://example.com",
    "https://user:secret@example.com",
    "movibox://open",
    "mailto:someone@example.com",
    "mailto:br22.dev@gmail.com?body=private",
    "//example.com",
  ])
    assert.equal(policyLink(href), null);
});
