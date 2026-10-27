/**
 * The typed failures of EnvironmentAuth, kept apart so the service file stays
 * small. EnvironmentAuth.ts re-exports every name here.
 */
import {
  DpopFailureReason,
  type DpopFailureReason as DpopFailureReasonType,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

const serverAuthInternalErrorContext = {
  cause: Schema.Defect(),
};

export class ServerAuthBootstrapCredentialValidationError extends Schema.TaggedError<ServerAuthBootstrapCredentialValidationError>()(
  "ServerAuthBootstrapCredentialValidationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to validate bootstrap credential.";
  }
}

export class ServerAuthSessionCredentialValidationError extends Schema.TaggedError<ServerAuthSessionCredentialValidationError>()(
  "ServerAuthSessionCredentialValidationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to validate session credential.";
  }
}

export class ServerAuthAuthenticatedSessionIssueError extends Schema.TaggedError<ServerAuthAuthenticatedSessionIssueError>()(
  "ServerAuthAuthenticatedSessionIssueError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue authenticated session.";
  }
}

export class ServerAuthAuthenticatedAccessTokenIssueError extends Schema.TaggedError<ServerAuthAuthenticatedAccessTokenIssueError>()(
  "ServerAuthAuthenticatedAccessTokenIssueError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue authenticated access token.";
  }
}

export class ServerAuthPairingLinkCreationError extends Schema.TaggedError<ServerAuthPairingLinkCreationError>()(
  "ServerAuthPairingLinkCreationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to create pairing link.";
  }
}

export class ServerAuthPairingLinksListError extends Schema.TaggedError<ServerAuthPairingLinksListError>()(
  "ServerAuthPairingLinksListError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to list pairing links.";
  }
}

export class ServerAuthPairingLinkRevocationError extends Schema.TaggedError<ServerAuthPairingLinkRevocationError>()(
  "ServerAuthPairingLinkRevocationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke pairing link.";
  }
}

export class ServerAuthSessionTokenIssueError extends Schema.TaggedError<ServerAuthSessionTokenIssueError>()(
  "ServerAuthSessionTokenIssueError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue session token.";
  }
}

export class ServerAuthSessionsListError extends Schema.TaggedError<ServerAuthSessionsListError>()(
  "ServerAuthSessionsListError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to list sessions.";
  }
}

export class ServerAuthSessionRevocationError extends Schema.TaggedError<ServerAuthSessionRevocationError>()(
  "ServerAuthSessionRevocationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke session.";
  }
}

export class ServerAuthOtherSessionsRevocationError extends Schema.TaggedError<ServerAuthOtherSessionsRevocationError>()(
  "ServerAuthOtherSessionsRevocationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke other sessions.";
  }
}

export class ServerAuthWebSocketTokenIssueError extends Schema.TaggedError<ServerAuthWebSocketTokenIssueError>()(
  "ServerAuthWebSocketTokenIssueError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue websocket token.";
  }
}

export class ServerAuthDpopReplayStateRecordError extends Schema.TaggedError<ServerAuthDpopReplayStateRecordError>()(
  "ServerAuthDpopReplayStateRecordError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to record DPoP proof replay state.";
  }
}

export class ServerAuthDpopReplayKeyCalculationError extends Schema.TaggedError<ServerAuthDpopReplayKeyCalculationError>()(
  "ServerAuthDpopReplayKeyCalculationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to calculate DPoP replay key.";
  }
}

export class ServerAuthLinkedCloudAccountVerificationError extends Schema.TaggedError<ServerAuthLinkedCloudAccountVerificationError>()(
  "ServerAuthLinkedCloudAccountVerificationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Could not verify the linked cloud account.";
  }
}

export class ServerAuthLinkedCloudAccountReadError extends Schema.TaggedError<ServerAuthLinkedCloudAccountReadError>()(
  "ServerAuthLinkedCloudAccountReadError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Could not read the linked cloud account.";
  }
}

export class ServerAuthLinkedCloudAccountMissingError extends Schema.TaggedError<ServerAuthLinkedCloudAccountMissingError>()(
  "ServerAuthLinkedCloudAccountMissingError",
  {},
) {
  override get message(): string {
    return "Cloud linked user is not installed for this environment.";
  }
}

export class ServerAuthCloudLinkJwtSigningError extends Schema.TaggedError<ServerAuthCloudLinkJwtSigningError>()(
  "ServerAuthCloudLinkJwtSigningError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to sign cloud link JWT.";
  }
}

export class ServerAuthCloudMintPublicKeyMissingError extends Schema.TaggedError<ServerAuthCloudMintPublicKeyMissingError>()(
  "ServerAuthCloudMintPublicKeyMissingError",
  {},
) {
  override get message(): string {
    return "Cloud mint public key is not installed for this environment.";
  }
}

export class ServerAuthCloudRelayIssuerMissingError extends Schema.TaggedError<ServerAuthCloudRelayIssuerMissingError>()(
  "ServerAuthCloudRelayIssuerMissingError",
  {},
) {
  override get message(): string {
    return "Cloud relay issuer is not installed for this environment.";
  }
}

export class ServerAuthCloudHealthJwtSigningError extends Schema.TaggedError<ServerAuthCloudHealthJwtSigningError>()(
  "ServerAuthCloudHealthJwtSigningError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to sign cloud health JWT.";
  }
}

export class ServerAuthCloudMintJwtSigningError extends Schema.TaggedError<ServerAuthCloudMintJwtSigningError>()(
  "ServerAuthCloudMintJwtSigningError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to sign cloud mint JWT.";
  }
}

export const ServerAuthInternalError = Schema.Union([
  ServerAuthBootstrapCredentialValidationError,
  ServerAuthSessionCredentialValidationError,
  ServerAuthAuthenticatedSessionIssueError,
  ServerAuthAuthenticatedAccessTokenIssueError,
  ServerAuthPairingLinkCreationError,
  ServerAuthPairingLinksListError,
  ServerAuthPairingLinkRevocationError,
  ServerAuthSessionTokenIssueError,
  ServerAuthSessionsListError,
  ServerAuthSessionRevocationError,
  ServerAuthOtherSessionsRevocationError,
  ServerAuthWebSocketTokenIssueError,
  ServerAuthDpopReplayStateRecordError,
  ServerAuthDpopReplayKeyCalculationError,
  ServerAuthLinkedCloudAccountVerificationError,
  ServerAuthLinkedCloudAccountReadError,
  ServerAuthLinkedCloudAccountMissingError,
  ServerAuthCloudLinkJwtSigningError,
  ServerAuthCloudMintPublicKeyMissingError,
  ServerAuthCloudRelayIssuerMissingError,
  ServerAuthCloudHealthJwtSigningError,
  ServerAuthCloudMintJwtSigningError,
]);
export type ServerAuthInternalError = typeof ServerAuthInternalError.Type;
export const isServerAuthInternalError = Schema.is(ServerAuthInternalError);

export class ServerAuthMissingCredentialError extends Schema.TaggedError<ServerAuthMissingCredentialError>()(
  "ServerAuthMissingCredentialError",
  {},
) {
  override get message(): string {
    return "Server authentication credential is missing.";
  }
}

export class ServerAuthInvalidCredentialError extends Schema.TaggedError<ServerAuthInvalidCredentialError>()(
  "ServerAuthInvalidCredentialError",
  {
    diagnostic: Schema.optional(Schema.String),
    dpopFailureReason: Schema.optionalKey(DpopFailureReason),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.diagnostic === "device_reapproval_required"
      ? "Approve this device again in SpecWithCode."
      : "Server authentication credential is invalid.";
  }
}

export const ServerAuthCredentialError = Schema.Union([
  ServerAuthMissingCredentialError,
  ServerAuthInvalidCredentialError,
]);
export type ServerAuthCredentialError = typeof ServerAuthCredentialError.Type;
export const isServerAuthCredentialError = Schema.is(ServerAuthCredentialError);
export const serverAuthCredentialReason = (
  error: ServerAuthCredentialError,
): "missing_credential" | "invalid_credential" | "device_reapproval_required" =>
  error._tag === "ServerAuthMissingCredentialError"
    ? "missing_credential"
    : error.diagnostic === "device_reapproval_required"
      ? "device_reapproval_required"
      : "invalid_credential";

export const serverAuthDpopFailureReason = (
  error: ServerAuthCredentialError,
): DpopFailureReasonType | undefined =>
  error._tag === "ServerAuthInvalidCredentialError" ? error.dpopFailureReason : undefined;

export class ServerAuthInvalidScopeError extends Schema.TaggedError<ServerAuthInvalidScopeError>()(
  "ServerAuthInvalidScopeError",
  {},
) {
  override get message(): string {
    return "The requested authentication scope is invalid.";
  }
}

export class ServerAuthScopeNotGrantedError extends Schema.TaggedError<ServerAuthScopeNotGrantedError>()(
  "ServerAuthScopeNotGrantedError",
  {},
) {
  override get message(): string {
    return "The requested authentication scope was not granted.";
  }
}

export const ServerAuthInvalidRequestError = Schema.Union([
  ServerAuthInvalidScopeError,
  ServerAuthScopeNotGrantedError,
]);
export type ServerAuthInvalidRequestError = typeof ServerAuthInvalidRequestError.Type;
export const isServerAuthInvalidRequestError = Schema.is(ServerAuthInvalidRequestError);
export const serverAuthInvalidRequestReason = (
  error: ServerAuthInvalidRequestError,
): "invalid_scope" | "scope_not_granted" =>
  error._tag === "ServerAuthInvalidScopeError" ? "invalid_scope" : "scope_not_granted";

export class ServerAuthMcpApprovalCodeError extends Schema.TaggedError<ServerAuthMcpApprovalCodeError>()(
  "ServerAuthMcpApprovalCodeError",
  {
    reason: Schema.Literals([
      "unknown_or_used",
      "not_a_pairing_code",
      "insufficient_scope",
      "reapproval_required",
    ]),
  },
) {
  override get message(): string {
    return this.reason === "reapproval_required"
      ? "Approve this device again with a new pairing code from this machine."
      : this.reason === "insufficient_scope"
        ? "That pairing code cannot grant this access, and it is now used up. Create one with the standard scopes, or choose Read only with a new code."
        : this.reason === "not_a_pairing_code"
          ? "That is not a one-time pairing code."
          : "That pairing code is unknown, expired, or already used.";
  }
}

export class ServerAuthForbiddenOperationError extends Schema.TaggedError<ServerAuthForbiddenOperationError>()(
  "ServerAuthForbiddenOperationError",
  {},
) {
  override get message(): string {
    return "The current authentication session cannot revoke itself.";
  }
}
