import { assert, describe, it } from "@effect/vitest";

import {
  isArchivedRepositoryRefusal,
  pushCommandText,
  pushFailureFields,
  pushRejection,
} from "./gitPushFailure.ts";

const FORBIDDEN =
  "fatal: unable to access 'https://github.com/owner/repo.git/': The requested URL returned error: 403";

describe("pushRejection", () => {
  it("gives git's own rejections their fix", () => {
    assert.equal(
      pushRejection(
        "To github.com:owner/repo.git\n ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs to 'github.com:owner/repo.git'\n",
      ),
      "rejected: fetch first; pull or rebase first",
    );
    assert.equal(
      pushRejection(" ! [rejected]        HEAD -> main (non-fast-forward)\n"),
      "rejected: non-fast-forward; pull or rebase first",
    );
  });

  it("keeps only plain words of a reason the remote wrote", () => {
    assert.equal(
      pushRejection(" ! [remote rejected] HEAD -> main (protected branch hook declined)\n"),
      "rejected by the remote: protected branch hook declined",
    );
    const hostile = pushRejection(
      ` ! [remote rejected] HEAD -> main (see https://user:t0ken@evil.invalid/x?y=1 ${"a".repeat(200)})\n`,
    );
    assert.notInclude(hostile ?? "", "://");
    assert.notInclude(hostile ?? "", "@");
    assert.isAtMost((hostile ?? "").length, "rejected by the remote: ".length + 120);
  });

  it("ignores output without a rejected ref", () => {
    assert.isNull(pushRejection(`${FORBIDDEN}\n`));
    // A remote hook's prose is not a ref line.
    assert.isNull(pushRejection("remote: ! [rejected] nothing -> here (made up)\n"));
  });
});

describe("isArchivedRepositoryRefusal", () => {
  it("needs both GitHub's notice and the 403", () => {
    const notice = "remote: This repository was archived so it is read-only.";
    assert.isTrue(isArchivedRepositoryRefusal(`${notice}\n${FORBIDDEN}\n`));
    assert.isFalse(isArchivedRepositoryRefusal(`${FORBIDDEN}\n`));
    assert.isFalse(isArchivedRepositoryRefusal(`${notice}\n`));
    assert.isFalse(
      isArchivedRepositoryRefusal(`remote: note: This repository was archived\n${FORBIDDEN}\n`),
    );
  });
});

describe("pushFailureFields", () => {
  const args = ["push", "origin", "HEAD:refs/heads/feature"];

  it("keeps the credential reason and the fatal line for a refused login", () => {
    assert.deepEqual(
      pushFailureFields({
        args,
        stderr: `remote: Permission to owner/repo.git denied to someone.\n${FORBIDDEN}\n`,
        classified: "authentication_failed",
        fatal: FORBIDDEN,
      }),
      {
        command: "git push origin HEAD:refs/heads/feature",
        detail: `Git command exited with a non-zero status: ${FORBIDDEN}`,
        reason: "authentication_failed",
      },
    );
  });

  it("drops the credential reason for an archived repository", () => {
    const fields = pushFailureFields({
      args,
      stderr: `remote: This repository was archived so it is read-only.\n${FORBIDDEN}\n`,
      classified: "authentication_failed",
      fatal: FORBIDDEN,
    });
    assert.notProperty(fields, "reason");
    assert.include(fields.detail, "archived (read-only)");
  });
});

describe("push command text", () => {
  it("shows the plain remote name the app used", () => {
    assert.equal(
      pushCommandText(["push", "fork", "HEAD:refs/heads/x"]),
      "git push fork HEAD:refs/heads/x",
    );
    assert.equal(pushCommandText(["push"]), "git push");
  });

  it("hides a URL or path used as the push destination", () => {
    const text = pushCommandText([
      "push",
      "https://user:tok3n@example.invalid/r.git",
      "HEAD:refs/heads/x",
    ]);
    assert.equal(text, "git push <remote> HEAD:refs/heads/x");
    assert.notInclude(text, "tok3n");
    assert.equal(
      pushCommandText(["push", "/srv/r.git", "HEAD:refs/heads/x"]),
      "git push <remote> HEAD:refs/heads/x",
    );
    assert.equal(
      pushCommandText(["push", "git@github.com:acme/r.git", "HEAD:refs/heads/x"]),
      "git push <remote> HEAD:refs/heads/x",
    );
    // A slashed value is hidden too: its shape cannot be told from a path.
    assert.equal(
      pushCommandText(["push", "secrets/token123/repo.git", "HEAD:refs/heads/x"]),
      "git push <remote> HEAD:refs/heads/x",
    );
    assert.equal(
      pushCommandText(["push", "foo/bar", "HEAD:refs/heads/x"]),
      "git push <remote> HEAD:refs/heads/x",
    );
  });
});
