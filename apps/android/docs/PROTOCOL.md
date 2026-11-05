# Native Android client spec (Kotlin, Compose, OkHttp WS, kotlinx.serialization)

Source of truth is the TypeScript runtime in `packages/client-runtime` plus `packages/contracts`. The Expo app at `apps/mobile` uses that runtime directly. A native Swift port of the same protocol exists at `apps/ios/SWCKit/Sources/{SWCTransport,SWCWire,SWCSync,SWCFeatures}`. Use it as a structural reference for the Kotlin port, and when it disagrees with the TypeScript, the TypeScript wins.

All paths are relative to `repositories/anton-abyzov/specwithcode`.

## Conflicts resolved

I checked each of these against the code.

- **Request `id` type.** The type allows `string | number` (effect `rpc/RpcMessage.ts:73,137,259,315`). The JS client sends numbers from a counter starting at 0 (`RpcClient.ts:217,273`). Send a JSON integer `id`. Then match the `requestId` on replies whether it comes back as a number or a string.
- **Acks are required.** On the server, every stream chunk write closes a latch and waits for `Ack`, unless the client disabled acks (`RpcServer.ts:119,199-201,409-433`). Without acks, a stream stalls after the first chunk.
- **Ticket query parameter.** It is literally `wsTicket` (`apps/server/src/auth/EnvironmentAuth.ts:408`), and the server tests use it (`websocketSession.test.ts:484`).
- **Capability locations.** `serverResolvedCommandContext` and `connectionProbe` are descriptor capabilities (`packages/contracts/src/environment.ts:101,217`). You can read them from `GET /.well-known/studio/environment` → `capabilities`, or from `config.environment.capabilities`. `shellResumeCompletionMarker` and `threadResumeCompletionMarker` are top-level `ServerConfig` fields (`packages/contracts/src/server.ts:803,810`).
- **Clerk Android callback.** The docs say `clerk://<applicationId>.callback` (`docs/operations/connect-setup.md:95-101`), and their table lists only the `com.specweave.studio*` ids. The production Play package is `com.specwithcode.android` (`apps/mobile/app.config.ts:109`), and the generated manifest declares `clerk://com.specwithcode.android.hosted-callback`. Unsure which one is right. Only Connect (phase 2) depends on it.

---

## 1. Connection modes

| Mode | Auth | Ship |
|---|---|---|
| **Direct pairing** (LAN, Tailscale, HTTPS host) | Bearer token, 30 days, no refresh | **v1** |
| Connect via relay (Clerk + DPoP P-256) | Clerk JWT → relay DPoP token → environment DPoP token | v2. The repo has no hosted relay or Clerk values (`.env.example`, `docs/operations/connect-setup.md:9-12`) |

### 1a. Direct handshake (v1)

**Step 1: parse the QR code or link.**
- A wrapper `studio://…?pairingUrl=<urlencoded>` contains the real link. Also unwrap `studio-dev:`, `specwithcode:`, and a `link=` param (`apps/mobile/src/features/connection/pairing.ts:73-91`, `PairingLink.swift`).
- The pairing link looks like `<origin>[/pair]#token=CODE`. Also accept `?token=CODE`; if both are present, the hash wins (`packages/shared/src/remote.ts:144-152,188-245`).
- Hosted form: `https://app/pair?host=<backendUrl>&label=<name>#token=CODE`. Target the `host` value.
- Manual entry is host plus code. A bare IP literal gets `http://`, anything else gets `https://` (`pairing.ts:30-43`).
- The code is 12 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`. It is single-use and expires after 5 minutes (`apps/server/src/auth/PairingGrantStore.ts:270,289`).
- Keep only the origin. `httpBase = scheme://host:port`. For `wsBase`, map http→ws and https→wss.

**Step 2: read the descriptor.** `GET {httpBase}/.well-known/studio/environment` (no auth, 10 s timeout). Do this before spending the code.

```json
{"environmentId":"…","label":"…","platform":"…","serverVersion":"…","orchestrationProtocolVersion":2,"capabilities":{…}}
```

A missing `orchestrationProtocolVersion` means 1. Require exactly 2 (`environment.ts:14`, `connection/compatibility.ts:9-27`). If the server's version is greater than 2, tell the user to update the app. If it is less, tell them to update the server.

**Step 3: exchange the code for a token.** `POST {httpBase}/oauth/token`, `Content-Type: application/x-www-form-urlencoded`, with no Authorization and no DPoP header (`packages/contracts/src/auth.ts:246-337`, `apps/server/src/auth/http.ts:552-621`):

```
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token=<CODE>
&subject_token_type=urn:specweave-studio:params:oauth:token-type:environment-bootstrap
&requested_token_type=urn:ietf:params:oauth:token-type:access_token
&client_label=SpecWithCode%20Android&client_device_type=mobile&client_os=Android
```

Omit `scope` to receive the grant's scopes. If you do send it, the server intersects it with the grant, and an empty result fails with `scope_not_granted`.

The 200 response:

```json
{"access_token":"…","issued_token_type":"urn:ietf:params:oauth:token-type:access_token","token_type":"Bearer","expires_in":2592000,"scope":"orchestration:read orchestration:operate …"}
```

Errors:
- 401 `{"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid","reason":"invalid_credential|device_reapproval_required|…","traceId":"…"}`
- 429 `{"code":"rate_limited","retryAfterSeconds":N}`, plus a `retry-after` header
- 400 with reason `invalid_scope` or `scope_not_granted`

**Step 4 (optional): check the session.** `GET {httpBase}/api/auth/session` with `Authorization: Bearer <t>` returns `{authenticated, scopes, permissions, sessionMethod, expiresAt, auth}`.

**Step 5: get a socket ticket before every socket open.** `POST {httpBase}/api/auth/websocket-ticket` with `Authorization: Bearer <t>` (the exact prefix `Bearer ` is required) and an empty body. The response is `{"ticket":"<b64url>.<sig>","expiresAt":"<ISO>"}`.

The ticket lasts 5 minutes (`SessionStore.ts:556`). It is a stateless HMAC, so you can reuse it until 30 s before expiry, as Swift does. Never store it.

**Step 6: open the socket.** No headers, cookies, or subprotocol. Open timeout is 15 s.

```
{wsBase}/ws?wsTicket=<ticket>&orchestrationProtocol=2&clientSurface=mobile&clientAppVersion=<v>&clientDeviceType=phone&clientOs=Android&clientOsMajorVersion=<n>&clientDeviceModel=<m>&connectionMethod=direct
```

`orchestrationProtocol=2` is mandatory. Without it the server answers HTTP 426 with `{"code":"orchestration_protocol_incompatible","orchestrationProtocolVersion":2}` (`apps/server/src/ws.ts:690-694,3373-3392`). The `client*` params are optional and parsed leniently (`ws.ts:702-780`).

**Step 7: confirm the environment.** Send `subscribeServerConfig` with payload `{}`. The first chunk item is `{"version":1,"type":"snapshot","config":{…}}`. `config.environment.environmentId` must equal the paired id. If it differs, fail with an environment mismatch (`client-runtime/src/rpc/session.ts:457-465`). The session is established once this snapshot arrives.

**Route safety.** Before sending a token to a saved route, re-check that `descriptor.environmentId` is the expected one (`connection/resolver.ts:334-339`). Plain-http routes are acceptable only when the user paired them by hand. Routes the server advertises must be HTTPS or loopback (`resolver.ts:191-196`, `connection/routes.ts:29-38`).

### 1b. Connect handshake (v2, summary)

1. **Clerk token.** Get a Clerk JWT from template `studio-relay` with skipCache. Its `aud` is `studio-code-relay`, and `sub` is the account id.
2. **Relay DPoP token.** `POST {relay}/v1/client/dpop-token`, form-encoded, with a `DPoP` proof that has no `ath`. Fields:
   - `grant_type=…token-exchange`
   - `subject_token=<clerk jwt>`
   - `subject_token_type=urn:ietf:params:oauth:token-type:jwt`
   - `requested_token_type=…access_token`
   - `resource=<relay origin>`
   - `scope=environment:connect`
   - `client_id=studio-mobile`
   - `device_id` (optional)

   The response has `token_type:"DPoP"` and `expires_in:1800`.
3. **List machines.** `GET {relay}/v1/environments` with `Authorization: Bearer <clerk jwt>`. The response is `{environments:[{environmentId,label,endpoint:{httpBaseUrl,wsBaseUrl,providerKind},linkedAt}]}`.
4. **Bootstrap credential.** `POST {relay}/v1/environments/{id}/connect` with `Authorization: DPoP <relay token>`, a `DPoP` proof that includes `ath`, and body `{"clientKeyThumbprint":"<jwk thumbprint>"}`. The response is `{endpoint, credential, expiresAt}`.
5. **Environment token.** `POST {httpBaseUrl}/oauth/token` with the same form as the direct path, `subject_token=<credential>`, and a `DPoP` proof without `ath`. The result is a DPoP-bound token.
6. **Environment calls.** Every call to the environment sends `Authorization: DPoP <envtoken>`, a fresh `DPoP` proof with `ath`, and `x-studio-orchestration-protocol: 2`. Open the socket the same way as direct, with `connectionMethod=relay`.

DPoP proof format:
- Header: `{"typ":"dpop+jwt","alg":"ES256","jwk":{kty,crv,x,y}}`
- Payload: `{htm,htu (no query or hash),jti:uuid,iat,ath?}`
- Signature: raw 64-byte R‖S, not DER. Convert JCA output.
- The server accepts `iat` up to 5 s in the future and up to 300 s old. `jti` is single-use.
- Thumbprint: `b64url(SHA256('{"crv":"P-256","kty":"EC","x":"…","y":"…"}'))` (`packages/shared/src/dpop.ts:70-181`).

## 2. RPC framing

Effect RPC 4.0.1 with `RpcSerialization.layerJson` (client `session.ts:339`, server `ws.ts:3484`).
- One text frame is one JSON document. Send one object per frame.
- When reading, accept an object or an array (a batch).
- There is no hello or auth frame.
- Send `headers: []`.

Client to server:

```json
{"_tag":"Request","id":0,"tag":"server.getConfig","payload":{},"headers":[]}
{"_tag":"Ack","requestId":0}
{"_tag":"Interrupt","requestId":0}
{"_tag":"Ping"}
```

Server to client:

```json
{"_tag":"Chunk","requestId":1,"values":[{…},{…}]}
{"_tag":"Exit","requestId":0,"exit":{"_tag":"Success","value":{…}}}
{"_tag":"Exit","requestId":0,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"EnvironmentAuthorizationError","message":"…","requiredScope":"…"}}]}}
{"_tag":"Pong"}
{"_tag":"Defect","defect":…}
```

A failure `cause` element is one of:
- `{"_tag":"Fail","error":{…}}`, a typed error with a `_tag`
- `{"_tag":"Die","defect":…}`
- `{"_tag":"Interrupt","fiberId":…}`

Rules:
- **Pending requests.** Keep a `Map<id, Pending>`.
- **Unary calls** end with one `Exit`. Use a 30 s timeout.
- **Streams** send zero or more `Chunk`s, then `Exit`. Ignore `value` on a stream's `Exit`; it is presumably `null` from `Schema.Void`, but unsure.
- **Acks.** After you process each `Chunk`, send `Ack{requestId}`.
- **Leaving a screen.** Send `Interrupt` for its subscriptions.
- **Keepalive.** Send `Ping` every 5 s. If a Pong is missing, declare the socket dead after roughly 3 windows (`RpcClient.ts:1221-1242`; Swift uses 5 s and 3 misses).
- **`Defect` frame.** Fail every pending request and reconnect.
- **Socket drop.** Every in-flight request fails, and the wire does not resume. Reconnect, then re-subscribe with `afterSequence`.

Encoding (`Schema.toCodecJson`):
- **Optional keys.** Omit them when absent. Send `null` only for `NullOr` fields.
- **Dates** are ISO-8601 strings.
- **Ids** are non-empty strings.
- **Sequences** are ints.
- **Unions** are discriminated by `kind`, `type`, or `_tag`.
- **Unknown data.** Use `Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }`. Give every sealed union a fallback `Unknown` subclass through a custom `JsonContentPolymorphicSerializer`. Decode each `values[i]` on its own, so one bad item does not kill the stream. Still advance the sequence for unknown events.
- **Generated ids.** `commandId`, `messageId`, and new `threadId` are client-generated UUIDv4. `commandId` is the idempotency key, so keep it the same when you retry a command.

## 3. Minimal method set

Tags are in `packages/contracts/src/rpc.ts:430-700` and `orchestrationV2.ts:3870-3884`.

| Purpose | Call | Payload | Result |
|---|---|---|---|
| Config + models | `subscribeServerConfig` (stream) | `{}` | `{"version":1,"type":"snapshot","config":ServerConfig}`, then `providerStatuses`, `settingsUpdated`, … (`server.ts:990`) |
| Liveness probe | `server.probe` if `capabilities.connectionProbe`, else `server.getConfig` | `{}` | `{}` / `ServerConfig` |
| Shell list (cold) | HTTP `GET /api/orchestration/shell`, with the auth header and `x-studio-orchestration-protocol: 2`, 20 s timeout | — | `{schemaVersion,snapshotSequence,threads[],archivedThreads[],projects[]}` |
| Shell live | `orchestration.subscribeShell` | `{"afterSequence":N}`, plus `"requestCompletionMarker":true` only if `config.shellResumeCompletionMarker` | items: `synchronized`, `snapshot{snapshot}`, `project.updated{sequence,project}`, `project.removed{sequence,projectId}`, `thread.updated{sequence,location,thread}`, `thread.removed{sequence,location,threadId}` |
| Thread (cold) | HTTP `GET /api/orchestration/threads/{id}`, same headers; 404 means the thread was deleted | — | `{snapshotSequence,projection,historyCursor?,hasMoreHistory?}` |
| Thread live | `orchestration.subscribeThread` | `{"threadId":"…","afterSequence":N}`, plus `requestCompletionMarker` if `config.threadResumeCompletionMarker` | items: `synchronized`, `snapshot{snapshotSequence,projection,…}`, `event{sequence,event:{id,threadId,occurredAt,type,payload}}` |
| Projection refetch | `orchestration.getThreadProjection` | `{"threadId":"…"}` | `ThreadProjection` |
| Send message | `orchestration.dispatchCommand` | see below | `{"sequence":N}` |
| New thread | `orchestration.launchThread` | see below | `{threadId,projection,resumed}` |
| Approve / answer | `dispatchCommand` `runtime-request.respond` | see below | `{sequence}` |
| Stop | `dispatchCommand` `run.interrupt` | see below | `{sequence}` |

Older history pages are available at `GET /api/orchestration/threads/{id}/history?cursor=<historyCursor>` (`environmentHttp.ts:861,910`). They are not needed for the MVP.

**Applying stream updates.** Upsert by `id`. Skip anything with `sequence <= lastSequence`.

Thread events carry the full new entity in `payload`:
- `turn-item.updated` → TurnItem
- `message.updated` → ConversationMessage
- `run.created` / `run.updated` → Run
- `runtime-request.updated` → RuntimeRequest
- `thread.*` → thread

Render chat from `projection.visibleTurnItems`. Each row is `{position, visibility, sourceThreadId, sourceItemId, item}`. Unsure how `visibleTurnItems` is re-derived after `turn-item.updated`; the reference reducer is `packages/client-runtime/src/state/orchestrationV2Projection.ts`. For the MVP, update the matching `item.id` in place, and call `getThreadProjection` again (debounced) whenever an event adds a new item id.

**TurnItem types for the MVP.** Each item has `type`, `id`, `ordinal`, `status`, `title`, `startedAt`, `completedAt`, and `updatedAt`, plus:
- `user_message`: `text`, `attachments`
- `assistant_message`: `text`, `streaming`
- `reasoning`
- `proposed_plan`: `markdown`
- `command_execution`: `input`, `output?`, `exitCode?`
- `file_change`: `fileName`, `additions`, `deletions`
- `approval_request`: `requestId`, `requestKind`, `prompt?`, `appName?`, `options?[{decision,label,warning?}]`
- `user_input_request`: `requestId`, `questions[{id,header,question,options[{label,description,value?}],multiSelect?,allowCustomAnswer?}]`

Anything else renders as a generic row.

**ThreadShell fields for the list.** `id, projectId, title, status, modelSelection{instanceId,model}, runtimeMode, latestVisibleMessage{role,text,updatedAt}|null, pendingRuntimeRequest|null, activeRunId|null, updatedAt, archivedAt|null`.

**Models.** Use `config.providers[]`, a `ServerProvider` list (`server.ts:273-354`). Each provider has `instanceId`, `displayName?`, `status`, `availability?`, and `models[{slug,name,isDefault?}]`. Hide providers whose `availability` is `"unavailable"`.

**Send a message** (requires `capabilities.serverResolvedCommandContext == true`):

```json
{"type":"message.dispatch","commandId":"<uuid>","createdBy":"user","creationSource":"mobile","threadId":"<id>","messageId":"<uuid>","text":"hello","attachments":[],"deliveryIntent":"auto","dispatchMode":{"type":"start_immediately"}}
```

If that capability is missing:
- With an active run, send `dispatchMode:{"type":"queue_after_active"}` and no `deliveryIntent`.
- Otherwise send `start_immediately`.

An active run is the last run whose status is in `{preparing, starting, running, waiting}`.

**Launch a thread:**

```json
{"commandId":"<uuid>","creationSource":"mobile","threadId":"<uuid>","projectId":"<id>","title":"<first 72 chars>","generateTitle":true,"modelSelection":{"instanceId":"<id>","model":"<slug>","options":{}},"runtimeMode":"approval-required","interactionMode":"default","workspaceStrategy":{"type":"root"},"initialMessage":{"messageId":"<uuid>","text":"…","attachments":[]}}
```

`runtimeMode` is one of `approval-required`, `auto-accept-edits`, `auto`, `full-access`.

**Approve:**

```json
{"type":"runtime-request.respond","commandId":"<uuid>","threadId":"<id>","requestId":"<id>","decision":"accept"}
```

`decision` is one of `accept`, `acceptForSession`, `acceptAlways`, `decline`, `cancel`. Show only the options the item lists; if it lists none, show accept and decline.
- A pending request is one in `projection.runtimeRequests` with `status == "pending"`, and its `kind` is not `user_input`, `auth_refresh`, or `dynamic_tool_call`.
- Enable the buttons only when `responseCapability.type == "live"`.

**Answer questions:** the same command with `"answers":{"<questionId>":"<value>"|["…"]},"answeredInChat":false` instead of `decision`.

**Stop:**

```json
{"type":"run.interrupt","commandId":"<uuid>","threadId":"<id>","runId":"<activeRunId>","holdQueue":true}
```

**Scopes.** Reads need `orchestration:read`. Mutations need `orchestration:operate`. Check `/api/auth/session` `scopes` and disable mutating UI when `operate` is missing.

## 4. Credential storage

- **Bearer token.** Store it with an AES-GCM key held in Android Keystore (`KeyGenParameterSpec`, non-exportable), and keep the ciphertext in DataStore. EncryptedSharedPreferences is deprecated, though still workable on minSdk 24.
- **Catalog.** Mirror Expo's `studio.connection-catalog.v1`. Each entry is `{connectionId:"bearer:<environmentId>:<origin>", environmentId, label, httpBaseUrl, wsBaseUrl, token, expiresAt}`. A second route for the same environment, such as Tailscale next to LAN, is a separate connectionId.
- **Never persist** the ws ticket or the pairing code.
- **Backups.** Exclude token storage from them: `android:dataExtractionRules` and `fullBackupContent` should exclude the datastore file, matching `secure_store_*_rules`.
- **DPoP key (v2).** Generate a Keystore EC P-256 key with `PURPOSE_SIGN` and SHA256. Export only the public x/y for the JWK, and convert the DER signature to R‖S. The same key must be used for the thumbprint and for every environment call afterwards.
- **Re-pairing.** Prompt for re-pairing on 401 `invalid_credential` or `device_reapproval_required`, and when `expiresAt` passes. The direct path has no refresh.

## 5. MVP screens

1. **Pair.** QR scanner (CameraX + ML Kit), manual host and code entry, and the `studio://` deep-link intent.
2. **Machines.** List with a status dot (connecting, online, blocked) and remove.
3. **Home.** Threads grouped by project, with search, status chip, pending-approval badge, and a new-thread FAB.
4. **New thread.** Project, model (from `config.providers`), runtime mode, and prompt, then launch.
5. **Thread.** Streamed `visibleTurnItems` with markdown and code blocks, approval and question cards, and a composer with send and stop.
6. **Settings.** Appearance, About, privacy policy and legal links (required by Play), and open-source licenses.

Deferred: Connect sign-in, FCM push (it needs Connect sign-in, `POST /v1/mobile/devices` with `platform:"android"` and `androidApiLevel`), diffs, files, attachments, share target, terminal, previews, widgets, and voice.

**Android config:**
- package `com.specwithcode.android`
- minSdk 24, target/compile 36, portrait
- permissions: `INTERNET`, `CAMERA`, and `POST_NOTIFICATIONS` (later)
- deep link: `VIEW` for scheme `studio`, `singleTask`
- `network_security_config` that permits cleartext, since manual LAN `http://`/`ws://` pairings are an existing product path
- brand: indigo `#5B6CFF` adaptive icon background, DM Sans font

**Reconnect policy** (`connection/supervisor.ts:45-63,172-200,1121-1137`):
- Delay is a random value in `[c/2, c]`, where `c = min(300 s, 1 s·2^(failures+1))`.
- Reset the failure count after 30 s of stable connection.
- On a network change (ConnectivityManager callback) or a return to foreground, retry immediately.
- A 429's `retryAfterSeconds` is the minimum delay.
- On 401, enter `blocked` and stop retrying.
- After any reconnect, mint a new ticket, re-run the HTTP snapshot, and re-subscribe with `afterSequence`.

## 6. Risks and unknowns

1. **Play listing and signing.** `com.specwithcode.android` is already set as the Play package for the Expo build. Unsure whether a listing and upload key exist. A native build must reuse the same Play App Signing upload key, or it cannot update that listing. Anton has to do the Play Console upload and publish himself.
2. **Schema drift.** The server adds fields and event types. Lenient decoding with `Unknown` fallbacks is mandatory. The HTTP bodies and the WS payloads are assumed to share the same JSON encoding (the `*Json` schema variants in `orchestrationV2.ts:2629,2981`), but this is unverified. Test against a live server.
3. **The visibleTurnItems reducer is not ported.** The MVP relies on refetching, which costs extra traffic on long threads. Port `orchestrationV2Projection.ts` later.
4. **Stream `Exit.value`** on success is assumed to be `null`. Unverified.
5. **Connect blockers.** It needs Anton's Clerk publishable key, the `studio-relay` template, the relay URL, the correct Clerk callback form for `com.specwithcode.android`, the relay's DPoP scope mapping (`infra/relay/src/auth/RelayTokens.ts`, unconfirmed), and `FCM_SERVICE_ACCOUNT` for push. Push only works for Connect users, not LAN-only pairings.
6. **Cleartext LAN.** The bearer token travels unencrypted over `http://` on the LAN. Upstream accepts this for manual pairings only. Warn in the UI and prefer HTTPS or Tailscale.
7. **Swift port parity.** `apps/ios/SWCKit` was only partly read. Unsure whether it is current or shipping. It is not authoritative.
8. **Not live-tested.** Every wire example here was built from code, not captured from a running server. Verify against a real server before building on it.