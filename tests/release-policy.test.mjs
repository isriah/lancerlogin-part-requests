import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, nightlyBase, nightlyTag, parseVersion, releaseKind } from "../scripts/release-policy.mjs";

test("stable, beta and nightly versions follow LancerLogin Core's ordering", () => {
  for (const value of ["v01.2.3", "1.2", "v1.0.0-beta.01", "v1.0.0-rc.1", "v1.0.0+build", "v1.0.0-nightly.20261301", "vv1.0.0"]) assert.equal(releaseKind(value), undefined, value);
  assert.equal(releaseKind("1.0.0"), undefined, "tags are v-prefixed");
  assert.equal(parseVersion("1.0.1-nightly.20261026"), undefined, "nightly versions parse only on request");
  assert.equal(releaseKind("v1.0.0"), "stable"); assert.equal(releaseKind("v1.1.0-beta.2"), "beta"); assert.equal(releaseKind("v1.0.1-nightly.20261026"), "nightly");
  for (const [a, b] of [["1.0.0-beta.10", "1.0.0-beta.9"], ["1.0.0", "1.0.0-beta.99"], ["1.0.1-beta.0", "1.0.1-nightly.20991231"], ["1.0.1-nightly.20261027", "1.0.1-nightly.20261026"], ["1.0.1-nightly.20261026", "1.0.0"]]) {
    assert.equal(compareVersions(a, b), 1, `${a} > ${b}`); assert.equal(compareVersions(b, a), -1);
  }
});

test("each nightly sits above every stable and beta release so the Nightly track offers it", () => {
  assert.equal(nightlyBase("1.0.0", []), "1.0.0");
  assert.equal(nightlyBase("1.0.0", ["v1.0.0"]), "1.0.1");
  assert.equal(nightlyBase("1.1.0", ["v1.0.0", "v1.0.1-nightly.20261026"]), "1.1.0");
  assert.equal(nightlyBase("1.1.0-beta.1", ["v1.0.0", "v1.1.0-beta.1"]), "1.1.1");
  assert.equal(nightlyBase("1.0.0", ["v1.2.0"]), "1.2.1");
  assert.equal(nightlyTag("1.0.1", new Date(Date.UTC(2026, 9, 26, 23, 59))), "v1.0.1-nightly.20261026");
  assert.throws(() => nightlyBase("next", []), /not a stable or beta version/);
});
