import {
  AuthSettingsWriteScope,
  EnvironmentId,
  WS_METHODS,
  type AuthPrincipal,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  PERSONAL_DATA_RPC_METHODS,
  refusesOwnerOnlyRpc,
  requiredScopeForRpcMethod,
} from "./RpcAuthorization.ts";

const coordinator: AuthPrincipal = {
  kind: "coordinator",
  environmentId: EnvironmentId.make("env-other-machine"),
};

describe("personal data stays with the machine's owner", () => {
  it("refuses another machine's key, whatever scopes it holds", () => {
    for (const method of PERSONAL_DATA_RPC_METHODS) {
      expect(refusesOwnerOnlyRpc(method, coordinator), method).toBe(true);
    }
  });

  it("lets the owner's own app and paired devices through to the scope check", () => {
    for (const method of PERSONAL_DATA_RPC_METHODS) {
      expect(refusesOwnerOnlyRpc(method, { kind: "device", id: "owner-mac" }), method).toBe(false);
      expect(refusesOwnerOnlyRpc(method, undefined), method).toBe(false);
    }
  });

  it("covers the permission itself, the Google accounts and the Telegram chat", () => {
    expect(new Set(PERSONAL_DATA_RPC_METHODS)).toEqual(
      new Set([
        WS_METHODS.personalDataStatus,
        WS_METHODS.personalDataSetAccess,
        WS_METHODS.googleAccountStatus,
        WS_METHODS.googleAccountConfigureClient,
        WS_METHODS.googleAccountStartSignIn,
        WS_METHODS.googleAccountCompleteSignIn,
        WS_METHODS.googleAccountSetProjectAccess,
        WS_METHODS.googleAccountDisconnect,
        WS_METHODS.googleAccountRemove,
        WS_METHODS.googleAccountSetLabel,
        WS_METHODS.telegramChannelStatus,
        WS_METHODS.telegramChannelConfigure,
        WS_METHODS.telegramChannelUnpair,
        WS_METHODS.telegramChannelRemove,
      ]),
    );
  });

  it("needs settings access to read or change which machines may read personal data", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.personalDataStatus)).toBe(AuthSettingsWriteScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.personalDataSetAccess)).toBe(
      AuthSettingsWriteScope,
    );
  });

  it("leaves other machines' ordinary work alone", () => {
    expect(refusesOwnerOnlyRpc(WS_METHODS.accessListGrants, coordinator)).toBe(false);
    expect(refusesOwnerOnlyRpc(WS_METHODS.serverGetConfig, coordinator)).toBe(false);
  });
});
