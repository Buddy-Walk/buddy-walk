import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveBuildRevision,
  revisionMatchesExpected,
} from "../../server/utils/buildRevision";

test("resolveBuildRevision prefers RENDER_GIT_COMMIT", () => {
  assert.equal(
    resolveBuildRevision({
      RENDER_GIT_COMMIT: "abc123",
      SOURCE_VERSION: "other",
    }),
    "abc123",
  );
});

test("resolveBuildRevision returns null when unset", () => {
  assert.equal(resolveBuildRevision({}), null);
});

test("revisionMatchesExpected accepts full and prefix matches", () => {
  assert.equal(revisionMatchesExpected("abcdef", "abcdef"), true);
  assert.equal(revisionMatchesExpected("abcdef0123", "abcdef"), true);
  assert.equal(revisionMatchesExpected("abcdef", "abcdef0123"), true);
  assert.equal(revisionMatchesExpected("aaaa", "bbbb"), false);
  assert.equal(revisionMatchesExpected(null, "abcdef"), false);
});
