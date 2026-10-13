import { describe, expect, it } from "@effect/vitest";
import { googleHealthFailure, projectGoogleStatus } from "./googleAccountHealth.ts";

describe("project Google diagnostics privacy", () => {
  it("does not reveal global scopes or account identity to an ungranted project", () => {
    const status = projectGoogleStatus({
      clientConfigured: true,
      connected: true,
      email: "private@example.com",
      grantedServices: ["gmail", "calendar"],
      projectServices: [],
    });
    const otherAccount = projectGoogleStatus({
      clientConfigured: true,
      connected: true,
      email: "another@example.com",
      grantedServices: ["drive"],
      projectServices: [],
    });
    expect(status).toEqual(otherAccount);
    expect(status.email).toBeNull();
    expect(status.services).toEqual([]);
    expect(status.checkedAt).toBeNull();
  });

  it("does not treat configured credentials as live connectivity", () => {
    const status = projectGoogleStatus({
      clientConfigured: true,
      connected: true,
      email: "me@example.com",
      grantedServices: ["calendar"],
      projectServices: ["calendar"],
    });
    expect(status.connectionState).toBe("configured");
    expect(status.guidance).toContain("has not been checked");
    expect(status.serviceChecks.find((check) => check.service === "calendar")?.status).toBe(
      "not_checked",
    );
  });

  it.each(["accessNotConfigured", "SERVICE_DISABLED", "serviceDisabled", "api_disabled"])(
    "recognizes disabled API code %s without repeating upstream text",
    (reason) => {
      const result = googleHealthFailure("calendar", {
        status: 403,
        reason,
        detail: "secret@example.com request contents",
      });
      expect(result.status).toBe("api_disabled");
      expect(JSON.stringify(result)).not.toContain("secret@example.com");
    },
  );

  it("does not echo an arbitrary error detail or reason", () => {
    const result = googleHealthFailure("gmail", {
      status: 500,
      reason: "sensitive-token",
      detail: "private@example.com",
    });
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toMatch(/sensitive-token|private@example/);
  });
});
