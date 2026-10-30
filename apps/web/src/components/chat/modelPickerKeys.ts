import type { ProviderInstanceId } from "@specweave-studio/contracts";

const MODEL_KEY_PREFIX = "model:";
const LEGACY_SECTION_KEY_PREFIX = "legacy-models:";

export function modelPickerModelKey(instanceId: ProviderInstanceId, slug: string): string {
  return `${MODEL_KEY_PREFIX}${instanceId.length}:${instanceId}${slug}`;
}

export function parseModelPickerModelKey(
  key: string,
): { instanceId: ProviderInstanceId; slug: string } | null {
  if (!key.startsWith(MODEL_KEY_PREFIX)) {
    return null;
  }
  const encoded = key.slice(MODEL_KEY_PREFIX.length);
  const separatorIndex = encoded.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  const instanceIdLengthText = encoded.slice(0, separatorIndex);
  if (!/^\d+$/.test(instanceIdLengthText)) {
    return null;
  }

  const instanceIdLength = Number(instanceIdLengthText);
  const value = encoded.slice(separatorIndex + 1);
  if (!Number.isSafeInteger(instanceIdLength) || instanceIdLength > value.length) {
    return null;
  }

  return {
    instanceId: value.slice(0, instanceIdLength) as ProviderInstanceId,
    slug: value.slice(instanceIdLength),
  };
}

export function modelPickerLegacySectionKey(instanceId: ProviderInstanceId): string {
  return `${LEGACY_SECTION_KEY_PREFIX}${instanceId}`;
}

export function parseModelPickerLegacySectionKey(key: string): ProviderInstanceId | null {
  return key.startsWith(LEGACY_SECTION_KEY_PREFIX)
    ? (key.slice(LEGACY_SECTION_KEY_PREFIX.length) as ProviderInstanceId)
    : null;
}

const GROUP_KEY_PREFIX = "group:";

/** A provider group's header in the grouped list. It is never a pickable item. */
export function modelPickerGroupKey(instanceId: ProviderInstanceId): string {
  return `${GROUP_KEY_PREFIX}${instanceId}`;
}

export function parseModelPickerGroupKey(key: string): ProviderInstanceId | null {
  return key.startsWith(GROUP_KEY_PREFIX)
    ? (key.slice(GROUP_KEY_PREFIX.length) as ProviderInstanceId)
    : null;
}

/**
 * The provider whose header sits above each list item, keyed by the item. Only the first
 * item of each run of one provider gets a header, so headers never become rows of their
 * own: arrow keys move over models and legacy sections only.
 */
export function modelPickerGroupStarts(
  keys: ReadonlyArray<string>,
): ReadonlyMap<string, ProviderInstanceId> {
  const starts = new Map<string, ProviderInstanceId>();
  let previous: ProviderInstanceId | null = null;
  for (const key of keys) {
    const instanceId =
      parseModelPickerModelKey(key)?.instanceId ?? parseModelPickerLegacySectionKey(key);
    if (instanceId === null) continue;
    if (instanceId !== previous) starts.set(key, instanceId);
    previous = instanceId;
  }
  return starts;
}
