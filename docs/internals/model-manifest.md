# Model manifest

The [bundled manifest](../../apps/server/src/provider/model-manifest.json) allows
offline startup; fetching it from `main` lets model metadata change between
releases. Failed fetches or invalid data preserve the last usable manifest.
Remote data must pass both catalog-reference validation and the owning provider's
adapter validation before replacing the cache.

A newer bundle outranks the cached remote manifest by `updatedAt`, so a release can
correct model data before the next successful fetch. Bump `updatedAt` whenever the
file changes. Fetch time cannot establish which copy contains the newer edit.

Generic catalog data describes presentation and capabilities. Each provider owns
its adapter schema and dispatch mappings. Claude discovers current models and
capabilities from its native SDK initialization, without generating a response.
Codex discovers models through its native account and app-server catalogs. New
models become available through provider health refreshes (every five minutes
with the default background settings while provider status is in use), without
a Studio release or a manifest update. Discovery is scoped to each configured
provider instance.

Claude's native aliases and default resolve to the current canonical model IDs.
The same instance catalog drives the picker, chat execution and text generation,
including effort, thinking and fast-mode options. New models receive only options
the native provider reports; existing manifest entries supply known detailed
runtime mappings and the offline fallback. Explicit model IDs in saved chats
remain unchanged. A failed Claude probe preserves the last usable catalog; a
successful initialization with no model data returns to the manifest fallback.
For native Codex instances, a failed model-list request can reuse the last good
list for up to one hour while the account identity still matches. An explicit
empty response clears it. Authentication failures and account changes invalidate
the retained Codex list.

A public model directory such as OpenRouter is not an entitlement source for a
native Claude or Codex subscription. Native discovery controls what Studio
offers for those accounts; a router requires its own configured provider.

`currentModels.claudeAgent` is the current-model classification overlay for
releases that predate catalog discovery; it does not add models to their catalogs.
Catalog-aware releases use `providers.claudeAgent.models[].status` for fallback
entries; native discovery identifies the current Claude models. Codex models
reported by the provider are not considered legacy merely because an older
manifest does not mention them. Explicit legacy metadata remains respected, and
a native default takes precedence over the manifest default.

Model data is schema-validated configuration. Tests should cover resolver, cache,
and adapter semantics with synthetic model names, so adding a model never requires
tests that repeat the configuration.
