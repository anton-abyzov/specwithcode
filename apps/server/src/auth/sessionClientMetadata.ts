/**
 * What a session records about the client that opened it (1327): the device
 * gate names a waiting device by these, never by the pairing link's label.
 */
import type { AuthClientMetadata } from "@specweave-studio/contracts";

import { CONNECT_SUBJECT, PHONE_LINK_PREFIX } from "../fleet/ConnectDeviceTrust.ts";
import { isOwnDeviceName } from "../fleet/connectDeviceNames.ts";

/** System, browser and user agent the device gate describes a device by (1327). */
export const clientDescriptionFacts = (client: AuthClientMetadata) => ({
  ...(client.os === undefined ? {} : { clientOs: client.os }),
  ...(client.browser === undefined ? {} : { clientBrowser: client.browser }),
  ...(client.userAgent === undefined ? {} : { clientUserAgent: client.userAgent }),
});

/**
 * A pairing link's label names the link, not the device: every Connect window
 * came out as "SpecWithCode Connect connect" (1327). A gated device keeps the
 * name it gave itself; everything else keeps the grant's label as before.
 */
export const sessionClient = (
  requestMetadata: AuthClientMetadata,
  grant: { readonly subject: string; readonly label?: string | undefined },
): AuthClientMetadata => {
  if (!grant.label) return requestMetadata;
  const gated = grant.subject === CONNECT_SUBJECT || grant.subject.startsWith(PHONE_LINK_PREFIX);
  return gated && isOwnDeviceName(requestMetadata.label)
    ? requestMetadata
    : { ...requestMetadata, label: grant.label };
};
