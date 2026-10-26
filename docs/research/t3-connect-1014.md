# T3 Connect investigation and independent onboarding specification

October 23, 2026. Implementation owner: increment 1014. No deployment, account change, VPN configuration or service restart is authorized by this implementation.

## Answer

T3 Connect uses an account-backed Cloudflare tunnel. Tailscale is a separate optional private route, not the foundation of hosted Connect. Signing into the same hosted account on both devices avoids installing a VPN. Private pairing requires a route the phone can actually reach, plus a one-time credential.

## Shipped evidence

Downloaded the official `pingdotgg/t3code` release `v0.1.2`, macOS arm64 ZIP. Package reports version `0.1.2`, commit `044f07257c96`, MIT license. ZIP SHA-256: `c99dbde726b168853c4409f32292b7381db2c83c1aca0ebdd1c506065eac990f`.

Artifact: `/Users/you/.specwithcode/m4/evidence/t3-connect-1014/artifact/T3 Code (Beta).app/Contents/Resources/app.asar`.

ASAR SHA-256: `0468a385f93ec672d554c301c6a12ad0014b08df8ab93def19a33082fac9d44d`.

REA parent Evidence: `ev_bb0adcdc55b2aa4b89e93c9df6a6745c717371507e864997d9f2e3a08951b99e`. Summary: `ev_f2f72b86a0a2f82e018db9b8f68277d20787dfa0c7ed6f6273324d296c401b8f`. Server module view: `ev_d069e01dae8f7fb967fb378f88dbf8215d2c885496995e1dda5b54666c1fa83c`. Retained receipt: `/Users/you/.specwithcode/m4/evidence/t3-connect-1014/rea-receipt.json`.

REA examined 1,780 relevant files, parsed 1,715 JavaScript files and visited 13,955,226 AST nodes. Coverage is partial: the server module exceeded expanded-relationship capacity, semantic analysis hit heap/time/result limits, and signed unpacked native modules contradict ASAR integrity metadata. Analysis used `record-and-continue`; those native bytes are untrusted. Static observations are not runtime proof.

## Observed

The shipped server bundle at `/Users/you/.specwithcode/m4/evidence/t3-connect-1014/extracted/apps/server/dist/binCli-BQvPfujE.mjs` contains:

| Location                           | Behavior                                                                                                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lines 114130–114155, 114216 onward | Managed `cloudflared` acquisition with platform-specific downloads; user-selected executables are supported.                                                                                                                                              |
| Lines 120172–120232                | Hosted relay and Clerk public configuration. No credentials were used or copied.                                                                                                                                                                          |
| Lines 121434–121565                | Host reachability diagnosis: connector state, HTTPS descriptor, DNS/error classification, outbound TCP port 7844 probes, optional Tailscale exit-node diagnosis. The descriptor request has a 10-second timeout; edge TCP checks have a 5-second timeout. |
| Lines 121684 onward                | Browserless OAuth authorization offers a URL and expiring user code.                                                                                                                                                                                      |
| Lines 121806 onward                | CLI checks remote reachability rather than reporting saved setup as success.                                                                                                                                                                              |
| Lines 121880 onward                | Setup acquires the connector, authorizes the account and saves desired exposure. Publish-only mode explicitly omits the tunnel and expects out-of-band access such as Tailscale.                                                                          |
| Lines 121331 onward                | Connector can run with HTTP/2; the related runtime has recovery/fallback logic.                                                                                                                                                                           |

The release web bundle contains separate Connect account, settings, diagnosis and sign-in surfaces. This corroborates the account/tunnel/private-route distinction; it does not prove the production relay's current availability.

Official reference: https://github.com/pingdotgg/t3code/blob/main/docs/internals/t3-connect.md and https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md . Local shipped bytes are the version-bound evidence; `main` documentation can drift.

## Inferred

The smooth hosted scenario is: sign in on the host, explicitly allow exposure, install the managed connector when prompted, leave the host awake, then sign in on the phone and choose the machine. No router port forwarding or Tailscale installation is required for that path. The host-to-Cloudflare connection still depends on outbound network access.

The smooth private scenario is: install and connect Tailscale on both devices to the same tailnet, enable MagicDNS/HTTPS and Serve for the host, verify the credential-free address from the phone, then generate a fresh pairing code. A host-side route check cannot prove the phone's VPN or ACL access.

## SpecWithCode reconciliation

Live GitHub readback corrected stale thread notes: #444 merged as `fd8d4f0935df51090b4c0e1631832740f4f414a7`, #445 as `5668c3ab41c194e1c7f1276ef44fc4db106fd5fa`, and #469 as `bfd72c102341ac1ac4ecd2c3e97a65812bf5d86e` on October 20. The workflow exists in source but GitHub reports `disabled_manually`; no relay deployment runs were returned. A fresh DNS request for `relay.spec-weave.com` failed with `curl: (6) Could not resolve host: relay.spec-weave.com`. Thus the merged code is not proof of a usable hosted service. This task neither enables configuration nor deploys infrastructure. Existing private pairing APIs are reused.

Current desktop pairing creates the code immediately. Its displayed URL follows the _current_ endpoint, so an endpoint change can attach an existing credential to a different address. The QR remains visible after expiration. These are independent usability and correctness gaps.

## Independent behavior specification (written before implementation)

1. Opening phone setup does not mint a credential. Show the selected address and route-specific prerequisites first.
2. A Tailscale route explains installation on both devices, same-tailnet sign-in, VPN connection, and testing the address in phone Safari. Existing access controls own host-side network changes.
3. A missing route offers the existing access-settings action. It never offers a loopback QR, LAN proxy or automatic network mutation.
4. A credential-free address can be copied for diagnosis. Never send a pairing token to a diagnostic endpoint.
5. Only the user's Generate code action creates a short-lived credential, using the existing delegated permission intersection.
6. Bind each generated credential to the address captured at creation. A changed route invalidates its display. An expired code is hidden and cannot be copied. Offer Generate new code.
7. A displayed QR means a credential is ready, not that the phone has connected. Do not show a success check without a phone acknowledgment.
8. Keep hosted sign-in behind existing configuration gates; never suggest an undeployed relay is usable.

## Unknown and release gates

No T3 app was launched, no hosted account was authorized, and no remote server was exercised. Server-side production behavior, current hosted entitlement and phone connectivity remain unknown. Our isolated UI tests can prove flow and expiration, not actual Tailscale enrollment, physical iPhone access or installed-release acceptance.

## Mobile evaluation

The user-supplied screenshot at `/Users/you/.specwithcode/m4/userdata/attachments/project-coordinator-1332065e-795b-4f98-91c4-f114917e53f6-ce6ba1be-94bd-4ee0-9415-e3caee2f8180.png` shows provider sections, model checkmarks, favorite stars, a default badge, search near the thumb, and reasoning/service-tier/runtime options in one sheet. The screenshot alone does not prove persistence, availability enforcement or backend behavior.

Downloaded official source at release tag `v0.1.2` corroborates the workflow:

- `/Users/you/.specwithcode/m4/evidence/t3-connect-1014/T3-ThreadSettingsSheet.tsx`: lines 535–550 validate a pending model before applying it; lines 1220–1240 supply provider/favorite filters; lines 1300 onward show Save/Cancel and bottom search. Favorite changes have their own persistence path, so Cancel should not be assumed to roll back stars.
- `/Users/you/.specwithcode/m4/evidence/t3-connect-1014/T3-ConnectOnboarding.tsx`: lines 80–145 show signed-in machine discovery, refresh and a persisted opt-out. Mobile does not offer to publish a host tunnel.
- `/Users/you/.specwithcode/m4/evidence/t3-connect-1014/T3-ConnectionDiagnosisDetails.tsx`: lines 55–100 render per-hop results, actionable steps, copy diagnostics and a help link.

These are official source observations, not REA of an installed iOS build. No T3 iOS IPA was supplied or present in the public desktop release, and no T3 phone session was run. Mobile persistence and touch behavior remain unverified at runtime.

Our comparison uses SpecWithCode source commit `252be2eb4` in `/Users/you/.specwithcode/m4/worktrees/t3-connect-1014`; concurrent iOS changes may supersede it.

| Approach                                               | Our current implementation                                                                                                                                                                                                                                                                                                                               | Recommendation                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Account-first machine discovery with refresh           | `/Users/you/.specwithcode/m4/worktrees/t3-connect-1014/apps/ios/SWCKit/Sources/SWCFeatures/Connect/ConnectViews.swift` already has sign-in, an empty-account guide and Check again; private QR is an explicit alternative.                                                                                                                       | Preserve this design. Activate only after the hosted relay is deployed and independently verified. A new wizard would duplicate existing work.                                                                                                                     |
| Provider-grouped searchable model sheet, explicit Save | `/Users/you/.specwithcode/m4/worktrees/t3-connect-1014/apps/ios/SWCKit/Sources/SWCFeatures/Settings/ThreadInfoSheet.swift` shows provider/model identity but does not edit it. `/Users/you/.specwithcode/m4/worktrees/t3-connect-1014/apps/ios/SWCKit/Sources/SWCWire/ModelSelection.swift` already carries model selection on the wire. | Highest-value follow-up: a native thread-model sheet with search, separate selected/default/current identities, server availability and staged Save/Cancel. Keep the two Copilot providers distinct; do not infer permission to spend or fallback from a favorite. |
| Connection-hop diagnosis and safe copy                 | `/Users/you/.specwithcode/m4/worktrees/t3-connect-1014/apps/ios/SWCKit/Sources/SWCTransport/TransportError.swift` maps DNS/refused/no-route/TLS into one unreachable message, although it distinguishes expired pairing and repair.                                                                                                              | Add route-aware next steps and sanitized diagnostics in a future iOS increment. Keep unknown hops unchecked; never report a tunnel success from saved setup.                                                                                                       |
| Thumb-level search and collapsible providers           | User screenshot and release source show bottom search plus provider/favorite filters. Our source snapshot has no equivalent model picker.                                                                                                                                                                                                                | Reuse the interaction principle in SwiftUI, with Dynamic Type and VoiceOver verification. Do not transplant React Native UI or assets.                                                                                                                             |
| Preflight before a short-lived QR                      | Our desktop previously generated credentials immediately.                                                                                                                                                                                                                                                                                                | Implemented in this increment. It benefits the existing iPhone scanner without changing iOS ownership or transport.                                                                                                                                                |

No iOS files were edited. The coordinated release owner retains the mobile release and any subsequent iOS implementation. This evaluation is a bounded workflow comparison, not a claim that every T3 mobile feature was tested.

## Verification receipts

Owned branch: `feat/t3-connect-onboarding`. All commands used Node 22.20.0 and pnpm 11.10.0. No production service or live database was touched.

- 13 focused pairing tests passed: `/Users/you/.specwithcode/m4/evidence/t3-connect-1014/unit.log`.
- Supported web typecheck passed, with one pre-existing suggestion in `CapacityFleet.test.tsx`: `/Users/you/.specwithcode/m4/evidence/t3-connect-1014/typecheck.log`.
- Focused UI lint passed: `/Users/you/.specwithcode/m4/evidence/t3-connect-1014/lint.log`.
- Production web build passed: `/Users/you/.specwithcode/m4/evidence/t3-connect-1014/web-build.log`.
- 14 real-component headless browser checks passed, no page errors: `/Users/you/.specwithcode/m4/evidence/t3-connect-1014/browser-results.json`. Covers preflight without minting, delegated scopes, expiration/renewal, route changes, permission loss, missing routes, access navigation, credential errors, cancelled async responses and narrow layout.
- Fresh-context reviewer returned SHIP: `/Users/you/.specwithcode/m4/evidence/t3-connect-1014/fresh-review.md`.
- Light, dark, QR and narrow screenshots are retained in the evidence folder. Screenshots wait for UI animations to finish.

The built-in preview was tried first, then explicitly reported no available automation host and instructed a headless-shell fallback. The fallback launches Chromium with `headless=True`, `PWDEBUG=0`, `PLAYWRIGHT_HTML_OPEN=never`, and writes only file evidence. No visible browser was opened.
