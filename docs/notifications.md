# Desktop and browser notifications

Connect notifications in Settings > General > Behavior on each receiving device. Connection does not sync to paired machines. Connect requests browser permission through a user gesture; the desktop app uses the OS notification API and sends a test. The system may ask for permission. No phone, mobile app, new account or paid transport is required.

Input-needed alerts cover pending questions and approvals. Ordinary monitor waits, background tasks and offline machines do not mean the user is blocking progress. Other thread alerts optionally announce completion, failure or inactivity. In-app messages and sound are separate preferences. Disconnect overrides every system alert, including the input-needed switch, and withdraws outstanding alerts.

A desktop window must remain open (it may be minimized), or the browser page must remain open and connected to the relevant machine. There is no closed-page Web Push subscription, service worker or hosted push relay in this implementation. A sleeping/offline machine cannot deliver current events. On reconnect, a new pending request can be announced; reloading does not flood historical completions.

Clicking a thread notification opens its original environment, project and thread. A test brings the existing window forward without selecting a thread. The desktop retains pending clicks across renderer reloads for one minute. Events are deduplicated per environment and request/run identity, retained locally for seven days with a bounded history. Browser tabs serialize delivery using Web Locks when available; the desktop also elects one notification owner. Browsers without Web Locks cannot guarantee cross-tab exclusion.

Browser permission is refreshed when settings regain focus and when supported permission-change events arrive. Denied permission requires changing browser/site settings. Native OS permission is managed in system settings; Electron's delivery callback cannot establish that a banner was visible or a person saw it. Focus modes may suppress banners. Send test reports a submission result, not physical receipt.

## Claude Code research

The installed Claude Code 2.1.302 artifact was inspected with REA 6.4.0, SHA-256 `5262ce9de86243fed0d21edc39b271555d56780d0112e2b194439fe1c6662d37`. REA evidence `ev_b5977e1b0ee1f834ce284b426563ab71efef321bf8a9f647af3119cc7814f0f6`, `ev_f118ca45da6a0fa2922494731122582ede2edc0ecf15e00d5a94d05c15e994b4`, and `ev_585f321a9a9374f94e2b4aa1dd2dde91b3a528c9404b06eb63a7fa6d58cd6ba8` distinguish terminal escape/bell delivery and Notification hooks from a separate authenticated mobile push path. Static analysis does not establish Anthropic's server delivery guarantees or a reusable browser push service. No proprietary code was copied.

Official corroboration: [terminal notifications](https://code.claude.com/docs/en/terminal-config#get-a-terminal-bell-or-notification), [Notification hook](https://code.claude.com/docs/en/hooks#notification), [mobile push requirements](https://code.claude.com/docs/en/remote-control#mobile-push-notifications).

## Acceptance boundaries

Automated tests cover permission decisions, revoked/denied states, native refusal, connect/disconnect, event identities, reconnect/remount, native click retention and project routing. Headless UI fixtures exercise the real settings and layout with controlled browser/native delivery adapters. These do not prove OS banners. After the release owner integrates this change, manually connect in the signed desktop app, allow the OS prompt, receive a test, background the app and trigger a real question on a connected machine, click the banner and verify the project/thread, then disconnect and verify silence. No installed service restart or release is part of this PR.
