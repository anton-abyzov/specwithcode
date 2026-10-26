import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
  ThreadErrorBanner,
} from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  const contextError = JSON.stringify({
    error: {
      message: JSON.stringify({
        error: {
          code: 400,
          message: "The input token count exceeds the maximum number of tokens allowed 1048576.",
        },
      }),
    },
  });

  it("cleans persisted JSON even when the error class is unknown", () => {
    const markup = renderToStaticMarkup(<ThreadErrorBanner error={contextError} />);
    expect(markup).toContain("Context limit reached");
    expect(markup).toContain("The input token count exceeds");
    expect(markup).not.toContain("&quot;message&quot;");
    expect(markup).toContain('data-variant="warning"');
  });

  it("offers only supported recovery and explains disabled compaction", () => {
    const onNewThread = () => {};
    const unsupported = renderToStaticMarkup(
      <ThreadErrorBanner error={contextError} contextLimitRecovery={{ onNewThread }} />,
    );
    expect(unsupported).toContain("New thread");
    expect(unsupported).not.toContain("Compact context");
    const disabled = renderToStaticMarkup(
      <ThreadErrorBanner
        error={contextError}
        contextLimitRecovery={{
          onNewThread,
          onCompactContext: () => {},
          compactDisabledReason: "Wait for the pending approval.",
        }}
      />,
    );
    expect(disabled).toContain("Compact context");
    expect(disabled).toContain('disabled=""');
    expect(disabled).toContain("Wait for the pending approval.");
  });

  it("keeps quota errors out of context recovery", () => {
    const quotaFailure = {
      // oxlint-disable-next-line shadcn/no-unknown-classes -- This is a provider failure enum, not a CSS class.
      class: "usage_limit",
      message: "Tokens per minute rate limit reached.",
    } as const;
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error={JSON.stringify({ error: { message: quotaFailure.message } })}
        errorClass={quotaFailure.class}
        contextLimitRecovery={{ onNewThread: () => {}, onCompactContext: () => {} }}
      />,
    );
    expect(markup).toContain("Usage limit reached");
    expect(markup).toContain("Tokens per minute rate limit reached.");
    expect(markup).not.toContain("New thread");
    expect(markup).not.toContain("Compact context");
  });

  it("gives ordinary nested provider errors a readable title and message", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error={JSON.stringify({
          error: { message: "Requests ending with a model turn are not supported." },
        })}
      />,
    );
    expect(markup).toContain("Provider error");
    expect(markup).toContain("Requests ending with a model turn are not supported.");
    expect(markup).not.toContain("&quot;error&quot;");
    expect(markup).not.toContain("data-context-limit-recovery");
  });

  it("formats the persisted reset timestamp in the banner", () => {
    const error = "Next observed reset: 2026-10-18T03:58:37.000Z. Select an eligible profile.";
    const markup = renderToStaticMarkup(<ThreadErrorBanner error={error} />);
    expect(markup).not.toContain("2026-10-18T03:58:37.000Z");
    expect(markup).toContain("2026");
    expect(markup).toContain("Select an eligible profile.");
    expect(markup).not.toContain("line-clamp-3");
    expect(getThreadErrorBannerKey("thread", error)).toContain("2026-10-18T03:58:37.000Z");
  });

  it("stays hidden after its current error is dismissed", () => {
    const bannerKey = getThreadErrorBannerKey("env:thread-a", "Aborted");
    dismissThreadErrorBannerForSession(bannerKey);

    expect(
      shouldShowThreadErrorBanner(
        "env:thread-a",
        "Aborted",
        isThreadErrorBannerDismissedForSession(bannerKey),
      ),
    ).toBe(false);
  });

  it("reappears when a new error arrives on the same thread", () => {
    dismissThreadErrorBannerForSession(getThreadErrorBannerKey("env:thread-b", "Turn failed"));
    const newErrorKey = getThreadErrorBannerKey("env:thread-b", "Provider crashed");

    expect(isThreadErrorBannerDismissedForSession(newErrorKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-b",
        "Provider crashed",
        isThreadErrorBannerDismissedForSession(newErrorKey),
      ),
    ).toBe(true);
  });

  it("scopes dismissals to the thread that dismissed them", () => {
    dismissThreadErrorBannerForSession(getThreadErrorBannerKey("env:thread-c", "Aborted"));
    const otherThreadKey = getThreadErrorBannerKey("env:other-thread", "Aborted");

    expect(isThreadErrorBannerDismissedForSession(otherThreadKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:other-thread",
        "Aborted",
        isThreadErrorBannerDismissedForSession(otherThreadKey),
      ),
    ).toBe(true);
  });

  it("keeps a dismissal across visiting threads with no error", () => {
    const bannerKey = getThreadErrorBannerKey("env:thread-d", "Aborted");
    dismissThreadErrorBannerForSession(bannerKey);

    expect(shouldShowThreadErrorBanner("env:thread-d", null, false)).toBe(false);
    expect(isThreadErrorBannerDismissedForSession(bannerKey)).toBe(true);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-d",
        "Aborted",
        isThreadErrorBannerDismissedForSession(bannerKey),
      ),
    ).toBe(false);
  });

  it("never shows a null error", () => {
    expect(shouldShowThreadErrorBanner("env:thread-e", null, false)).toBe(false);
  });
  it("aligns the warning and dismiss icons with the first line of a multi-line error", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error={"The first error line\ncontinues on a second line"}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Dismiss error"');
    expect(markup).not.toContain("controlAlignment");
    expect(markup).toContain("flex gap-2 items-start");
    expect(markup).toContain("min-h-7 pt-1 sm:min-h-6 sm:pt-0.5");
    expect(markup).toContain("h-lh w-4");
    expect(markup).toContain("h-lh self-start");
  });

  it("offers Continue for a failed turn the server can continue, beside dismiss", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error="The provider could not start this turn. Retry the turn; if it keeps failing, check the provider setup and server logs."
        errorClass="provider_error"
        onContinue={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(markup).toContain(">Continue</button>");
    expect(markup).toContain('aria-label="Dismiss error"');
    const busy = renderToStaticMarkup(
      <ThreadErrorBanner
        error="SpecWithCode could not save this turn because the disk is full or the database could not be opened. Free disk space, then press Continue."
        errorClass="unknown"
        onContinue={() => {}}
        continueBusy
      />,
    );
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*>Continue<\/button>/u);
  });

  it("offers no Continue without a resumable run or for limits", () => {
    expect(
      renderToStaticMarkup(
        <ThreadErrorBanner error="Provider failed." errorClass="provider_error" />,
      ),
    ).not.toContain(">Continue</button>");
    expect(
      renderToStaticMarkup(
        <ThreadErrorBanner error="Limit reached." errorClass="usage_limit" onContinue={() => {}} />,
      ),
    ).not.toContain(">Continue</button>");
  });

  it("offers Switch model for a sign-in failure but not for a usage limit", () => {
    const signIn = renderToStaticMarkup(
      <ThreadErrorBanner
        error="Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again."
        errorClass="permission_error"
        onSwitchModel={() => {}}
      />,
    );
    expect(signIn).toContain(">Switch model</button>");
    expect(signIn).not.toContain(">Continue</button>");
    expect(
      renderToStaticMarkup(
        <ThreadErrorBanner
          error="Limit reached."
          errorClass="usage_limit"
          onSwitchModel={() => {}}
        />,
      ),
    ).not.toContain("Switch model");
  });

  describe("a missing thread folder", () => {
    const error =
      "This thread's workspace folder no longer exists or is not a directory: /w/studio/fix-design. Restore the folder at this path before retrying; switching models will fail the same way.";
    const outcome = async () => ({ ok: true, message: null });
    const recovery = (code: string) => ({
      threadId: "thread-1041",
      failureItemId: "item:1",
      code,
      branch: "fix/design",
      projectFolder: "/repos/specweave",
      onRecreate: outcome,
      onUseProjectFolder: outcome,
      onResolve: outcome,
    });

    it("offers recreate, the project folder and resolve, never another model", () => {
      const markup = renderToStaticMarkup(
        <ThreadErrorBanner
          error={error}
          errorClass="validation_error"
          onContinue={() => {}}
          onSwitchModel={() => {}}
          workspaceMissingRecovery={recovery("workspace_missing")}
        />,
      );
      expect(markup).toContain("Thread folder is missing");
      expect(markup).not.toContain("Provider error");
      expect(markup).toContain(">Recreate folder from fix/design</button>");
      expect(markup).toContain(">Use the project folder</button>");
      expect(markup).toContain("specweave (/repos/specweave)");
      expect(markup).toContain(">Resolve thread</button>");
      expect(markup).not.toContain("Switch model");
      expect(markup).not.toContain(">Continue</button>");
    });

    it("offers no recreate once the branch is gone too", () => {
      const markup = renderToStaticMarkup(
        <ThreadErrorBanner
          error={error}
          errorClass="validation_error"
          onSwitchModel={() => {}}
          workspaceMissingRecovery={recovery("workspace_branch_missing")}
        />,
      );
      expect(markup).toContain("Thread folder is missing");
      expect(markup).not.toContain("Recreate folder");
      expect(markup).toContain(">Use the project folder</button>");
      expect(markup).toContain(">Resolve thread</button>");
      expect(markup).not.toContain("Switch model");
    });

    it("names the folder and offers no other model to a viewer without actions", () => {
      const markup = renderToStaticMarkup(
        <ThreadErrorBanner
          error={error}
          errorClass="validation_error"
          errorCode="workspace_missing"
          onSwitchModel={() => {}}
        />,
      );
      expect(markup).toContain("Thread folder is missing");
      expect(markup).not.toContain("Provider error");
      expect(markup).not.toContain("Switch model");
      expect(markup).not.toContain("data-workspace-missing-recovery");
    });

    it("hides recreate without source control access", () => {
      const { onRecreate: _hidden, ...withoutGit } = recovery("workspace_missing");
      const markup = renderToStaticMarkup(
        <ThreadErrorBanner
          error={error}
          errorClass="validation_error"
          workspaceMissingRecovery={withoutGit}
        />,
      );
      expect(markup).not.toContain("Recreate folder");
      expect(markup).toContain(">Use the project folder</button>");
    });
  });
});
