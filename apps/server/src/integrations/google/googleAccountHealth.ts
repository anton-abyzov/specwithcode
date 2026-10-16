import { GOOGLE_SERVICES, GoogleService } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

import type { GoogleEndpoints } from "./googleAccountLogic.ts";

export const GoogleServiceCheck = Schema.Struct({
  service: GoogleService,
  status: Schema.Literals([
    "not_authorized",
    "scope_missing",
    "not_checked",
    "ok",
    "api_disabled",
    "access_denied",
    "authentication_failed",
    "unreachable",
    "error",
  ]),
  message: Schema.NullOr(Schema.String),
});
export type GoogleServiceCheck = typeof GoogleServiceCheck.Type;

/** Safe for a project agent: never includes another project's grants or global scopes. */
export const GoogleProjectStatus = Schema.Struct({
  email: Schema.NullOr(Schema.String),
  services: Schema.Array(GoogleService),
  connectionState: Schema.Literals([
    "not_configured",
    "disconnected",
    "project_access_required",
    "scope_required",
    "configured",
    "verified",
    "error",
  ]),
  guidance: Schema.String,
  checkedAt: Schema.NullOr(Schema.String),
  serviceChecks: Schema.Array(GoogleServiceCheck),
});
export type GoogleProjectStatus = typeof GoogleProjectStatus.Type;

export function projectGoogleStatus(input: {
  clientConfigured: boolean;
  connected: boolean;
  email: string | null;
  grantedServices: ReadonlyArray<GoogleService>;
  projectServices: ReadonlyArray<GoogleService>;
}): GoogleProjectStatus {
  const allowed = new Set(input.projectServices);
  const granted = new Set(input.grantedServices);
  const services =
    input.connected && input.clientConfigured
      ? GOOGLE_SERVICES.filter((service) => allowed.has(service) && granted.has(service))
      : [];
  const connectionState = !input.clientConfigured
    ? "not_configured"
    : !input.connected
      ? "disconnected"
      : allowed.size === 0
        ? "project_access_required"
        : services.length === 0
          ? "scope_required"
          : "configured";
  const guidance = {
    not_configured:
      "Open Settings > Google account and configure a Google client, then connect Google and enable services for this project.",
    disconnected:
      "Open Settings > Google account, connect Google, then enable the needed services for this project. Connections in other apps do not connect this SpecWithCode host.",
    project_access_required:
      "Open Settings > Google account and enable the needed services for this project.",
    scope_required:
      "Reconnect in Settings > Google account and approve the services enabled for this project.",
    configured:
      "Saved Google sign-in and project access are available. Live access has not been checked; use checkConnection: true before relying on it.",
  }[connectionState];
  return {
    email: services.length > 0 ? input.email : null,
    services,
    connectionState,
    guidance,
    checkedAt: null,
    serviceChecks: GOOGLE_SERVICES.map((service) => ({
      service,
      status: !allowed.has(service)
        ? "not_authorized"
        : input.connected && !granted.has(service)
          ? "scope_missing"
          : "not_checked",
      message: !allowed.has(service)
        ? "This project has no access to this service."
        : input.connected && !granted.has(service)
          ? "Reconnect Google and approve this service."
          : null,
    })),
  };
}

/** GETs test the real API with no mail, event or file content in the response. */
export function googleHealthRequest(service: GoogleService, endpoints: GoogleEndpoints) {
  switch (service) {
    case "gmail":
      return {
        operation: "Gmail connection check",
        url: `${endpoints.gmail}/users/me/profile`,
        query: { fields: "historyId" },
      };
    case "calendar":
      return {
        operation: "Calendar connection check",
        url: `${endpoints.calendar}/calendars/primary/events`,
        query: { maxResults: "1", fields: "kind" },
      };
    case "drive":
      return {
        operation: "Drive connection check",
        url: `${endpoints.drive}/files`,
        query: { pageSize: "1", fields: "kind" },
      };
  }
}

/** Fixed messages only: an upstream error must not echo account or request contents. */
export function googleHealthFailure(
  service: GoogleService,
  error: { status?: number | undefined; reason?: string | undefined; detail?: string | undefined },
): GoogleServiceCheck {
  const reason = error.reason?.toLowerCase() ?? "";
  if (
    ["accessnotconfigured", "servicedisabled", "service_disabled", "api_disabled"].includes(reason)
  )
    return {
      service,
      status: "api_disabled",
      message:
        "Enable this API in the Google Cloud project for the OAuth client, then check again.",
    };
  if (
    error.status === 401 ||
    ["invalid_grant", "invalid_client", "unauthorized_client", "deleted_client"].includes(reason) ||
    error.detail?.includes("sign in again") ||
    error.detail?.includes("not connected")
  )
    return {
      service,
      status: "authentication_failed",
      message: "Google did not accept the sign-in. Reconnect in Settings > Google account.",
    };
  if (error.status === 403)
    return {
      service,
      status: "access_denied",
      message:
        "Google denied this API request. Check the approved service scopes and account or organisation restrictions.",
    };
  if (
    error.status === undefined &&
    (error.detail === undefined || error.detail.includes("could not be reached"))
  )
    return {
      service,
      status: "unreachable",
      message: "Google could not be reached. Check this host's network connection and try again.",
    };
  return {
    service,
    status: "error",
    message: "Google access could not be verified. Check Settings > Google account and try again.",
  };
}
