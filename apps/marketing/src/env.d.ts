/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Cloudflare Web Analytics site token. Unset: no beacon is rendered. */
  readonly PUBLIC_CF_WEB_ANALYTICS_TOKEN?: string;
  /** Origin that receives anonymous download events. Default: https://relay.spec-weave.com. */
  readonly PUBLIC_SITE_EVENTS_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
