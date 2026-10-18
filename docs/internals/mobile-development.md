# Mobile development lifecycle

The [connection runtime's HMR boundary](../../apps/mobile/src/lib/hot-swappable-atom-runtime.ts)
keeps a stable atom runtime and replaces its Effect layer through a writable atom.
It accepts the update only after installing the new layer. Otherwise importers
retain the old behavior even though Metro reports a successful refresh.

Do not reset the shared atom registry to refresh a connection-runtime edit. Reset
removes listeners from mounted consumers that Metro has no reason to rerender.
When the registry or managed-runtime module itself changes, normal Metro propagation
disposes its old resources. This boundary does not make arbitrary module-level atom
families safe to hot-swap. Production uses an ordinary atom runtime.

[Environment supervisor scopes](../../packages/client-runtime/src/connection/registry.ts)
are children of the registry scope. The per-environment map supports targeted
shutdown, but a supervisor created after its cleanup runs would escape it. A closed
parent scope also closes late arrivals, preventing interrupted startup or runtime
replacement from leaving a WebSocket alive outside the new registry.

Uniwind compiles CSS on Metro updates so newly used classes are discovered. It
skips global style invalidation only when the generated stylesheet and theme list
are unchanged. Skipping compilation would lose new classes; invalidating every
consumer for unchanged output makes an ordinary component edit refresh the whole
app. The fingerprint is recorded only after initialization succeeds.

Expo 58 guards `NotificationCenterManager`'s delegates and pending responses with a lock. The
[expo-notifications patch](../../patches/expo-notifications@58.0.11.patch) closes the two gaps
left: delivery records a response as pending in the same step that snapshots the delegates, so a
delegate registering during delivery still receives it, and pending-response replay removes only
the responses in its snapshot, preserving responses received during callbacks. The
[expo-modules-core patch](../../patches/expo-modules-core@58.0.11.patch) does the same for
`EXPermissionsService`'s requester registry. Both are checked by the native regressions in
`apps/mobile/scripts/`. When Expo is upgraded, port these patches to the new versions; the
regressions fail otherwise. Changes to a native patch require reinstalling dependencies and
rebuilding the iOS app.
The native modules under `apps/mobile/modules/` are `file:` dependencies, and pnpm
copies those into its virtual store instead of linking them. Metro bundles the copy,
so an edit to a module's TypeScript is invisible to a running dev client until
`vp i` re-syncs it, while Gradle and CocoaPods compile the worktree directory
directly. A JavaScript change that "has no effect" on device is usually this.
