import {
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
} from "@specweave-studio/contracts";

import { deriveAvailableInstanceId } from "./AddProviderInstanceDialog.logic";

/** Drivers whose turns can run on an API account's own key, and the variable each reads. */
export const API_CREDIT_ACCOUNT_DRIVERS = {
  claudeAgent: {
    variable: "ANTHROPIC_API_KEY",
    label: "Claude API",
    console: "Claude Console",
    placeholder: "sk-ant-api03-…",
  },
  grok: {
    variable: "XAI_API_KEY",
    label: "Grok API",
    console: "xAI Console",
    placeholder: "xai-…",
  },
} as const;
export type ApiCreditAccountDriver = keyof typeof API_CREDIT_ACCOUNT_DRIVERS;

/**
 * A Claude Console workspace ID. A key that is not scoped to a workspace
 * (Console user keys, `sk-ant-usr…`) is refused unless every request names
 * one in the `anthropic-workspace-id` header.
 */
export const CLAUDE_WORKSPACE_ID_PATTERN = /^wrkspc_[A-Za-z0-9]+$/;

export function isApiCreditAccountDriver(driver: string): driver is ApiCreditAccountDriver {
  return Object.hasOwn(API_CREDIT_ACCOUNT_DRIVERS, driver);
}

/**
 * The provider instance for one API account: the driver on its default home,
 * so a limited thread resumes its own session there, with the key as a
 * sensitive variable. The server moves a sensitive value into its secret
 * store; settings only ever keep a redaction marker for it.
 */
export function apiCreditAccountInstance(input: {
  readonly driver: ApiCreditAccountDriver;
  readonly label: string;
  readonly apiKey: string;
  /** Claude only: the workspace an unscoped key bills, sent as a request header. */
  readonly workspaceId?: string;
  readonly existingIds: ReadonlySet<string>;
}): { readonly instanceId: ProviderInstanceId; readonly instance: ProviderInstanceConfig } {
  const meta = API_CREDIT_ACCOUNT_DRIVERS[input.driver];
  const label = input.label.trim() || meta.label;
  const slug = (label === meta.label ? "api" : label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const instanceId = deriveAvailableInstanceId(
    (value) => (value ? `${input.driver}_${value}` : `${input.driver}_api`),
    slug,
    input.existingIds,
  );
  const workspaceId = input.driver === "claudeAgent" ? input.workspaceId?.trim() : undefined;
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    instance: {
      driver: ProviderDriverKind.make(input.driver),
      enabled: true,
      displayName: label,
      environment: [
        { name: meta.variable, value: input.apiKey.trim(), sensitive: true },
        // Claude Code adds ANTHROPIC_CUSTOM_HEADERS to every API request.
        ...(workspaceId
          ? [
              {
                name: "ANTHROPIC_CUSTOM_HEADERS",
                value: `anthropic-workspace-id: ${workspaceId}`,
                sensitive: false,
              },
            ]
          : []),
      ],
    },
  };
}
