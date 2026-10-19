# App Store and TestFlight listing

Listing copy and answers for SpecWithCode for iPhone, ready to paste into App Store Connect. Nothing here has been created in App Store Connect or the Apple developer account yet; the steps that need the owner's go-ahead are at the end.

| Field            | Value                                                                         |
| ---------------- | ----------------------------------------------------------------------------- |
| Bundle id        | `com.specwithcode.ios` (Release); Debug builds use `com.specwithcode.ios.dev` |
| Version          | `0.1.0` (`MARKETING_VERSION`), build `1` (`CURRENT_PROJECT_VERSION`)          |
| Platform         | iPhone only, iOS 26.0 or later, portrait                                      |
| Primary language | English (U.S.)                                                                |
| Suggested SKU    | `specwithcode-ios`                                                            |
| Copyright        | 2026 Anton Abyzov                                                             |

Character counts below are Unicode characters, counted with Python `len()` on the text inside each block.

## App name

Limit 30. Count: 12.

```text
SpecWithCode
```

If the name is taken, use `SpecWithCode Mobile` (19). Apple rejects names that contain "iPhone".

## Subtitle

Limit 30. Count: 28.

```text
Steer your projects anywhere
```

## Promotional text

Limit 170. Count: 147. It can change at any time without a new build.

```text
Answer an approval, queue a message or stop a run on any of your machines, right from your phone. Try it first with sample data, no pairing needed.
```

## Description

Limit 4000. Count: 1977.

```text
SpecWithCode for iPhone is a companion to SpecWithCode on your computers. Pair your phone once, then follow and steer your work from wherever you are.

Talk to Aide
Aide is your personal assistant in SpecWithCode. Ask what needs you today, get a summary across all your machines, or ask it to remind you about something later.

Chat with each project's coordinator
Every project opens as a chat with its coordinator. Ask for status, hand over a new task or change direction without opening a laptop.

Follow threads on any machine
See which threads need you, which are working and which are idle, grouped by project. Open a thread to read its progress and see how far its plan has come.

Stay in control
Send a message, or queue one to run after the current one. Stop a run. Approve or deny a command once or for the whole session. Pin, resolve, reopen and archive threads.

Change the settings that matter
Edit a project's name, goal and instructions, pause its coordinator or archive it. Choose the machine and approval mode for new threads, name your phone, and pick a light or dark look.

Pair in seconds
On your computer, open SpecWithCode, go to Settings > Connections and choose Pair a phone. Scan the QR code or paste the pairing link. The phone then talks straight to each machine over your local network, a private VPN or an address you set up. A pairing lasts 30 days; pair again to renew it.

Private by design
There is no account and no sign-up. The app has no ads, no analytics and no tracking. It talks only to your own machines, which pass your messages to the AI tools you set up there. Pairing tokens stay in the iOS Keychain on this phone.

Try it before you pair
Tap Explore with sample data on the welcome screen to look around with made-up machines and projects.

Requirements
SpecWithCode running on at least one computer your phone can reach. Push notifications, attachments, terminal and diffs are not in this version yet.

Learn more at spec-weave.com.
```

## Keywords

Limit 100. Count: 97. Comma separated, no spaces, no competitor names. Words already in the name ("SpecWithCode") are indexed without being repeated here.

```text
coding,agent,remote,ai,assistant,aide,threads,coordinator,developer,approval,spec,workflow,git,ci
```

## Category

- Primary: Developer Tools
- Secondary: Productivity

## Age rating

Every answer is None or No, which gives the lowest rating (4+).

| Question                                                     | Answer                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Parental controls, age assurance                             | No                                                                                    |
| Unrestricted web access                                      | No                                                                                    |
| User-generated content                                       | No                                                                                    |
| Messaging and chat (with other people)                       | No: chat is only with the user's own assistant and coordinators on their own machines |
| Advertising                                                  | No                                                                                    |
| Cartoon, realistic or graphic violence                       | None                                                                                  |
| Sexual content or nudity                                     | None                                                                                  |
| Profanity or crude humor                                     | None                                                                                  |
| Horror or fear themes                                        | None                                                                                  |
| Alcohol, tobacco or drug use                                 | None                                                                                  |
| Mature or suggestive themes                                  | None                                                                                  |
| Medical or treatment information; health and wellness topics | None / No                                                                             |
| Simulated gambling; real gambling; contests; loot boxes      | None / No                                                                             |

Content rights ("Does your app contain, show, or access third-party content?"): No.

## URLs

| Field              | URL                            |
| ------------------ | ------------------------------ |
| Support URL        | https://spec-weave.com/support |
| Marketing URL      | https://spec-weave.com         |
| Privacy policy URL | https://spec-weave.com/privacy |

Both are live on spec-weave.com since 18 October 2026: the support page and the privacy policy's "SpecWithCode for iPhone" section (anton-abyzov/specweave#2094). Every claim in that section was checked against this app's code: what it connects to, what it stores where (the machine list in `machines.json`, tokens in the Keychain on this device only, two `UserDefaults` keys), that a pairing code works once, and that removing a machine on the phone does not revoke it on the computer.

## App Privacy

Answer: **Data Not Collected**.

Why: the app sends data only to the user's own machines, which the developer does not run or have access to, and it contains no analytics, crash reporting, advertising or other third-party SDKs. `App/PrivacyInfo.xcprivacy` agrees: no tracking, no tracking domains, no collected data types, one required-reason API (`UserDefaults`, reason `CA92.1`).

## Export compliance

The app uses only standard HTTPS/TLS and secure WebSockets through Apple's networking APIs, plus the iOS Keychain. That is exempt encryption, so `ITSAppUsesNonExemptEncryption` is `NO`. It is set in `project.yml` (`INFOPLIST_KEY_ITSAppUsesNonExemptEncryption: NO`) and present in the built Release `Info.plist`, so App Store Connect will not ask the export compliance questions for each build.

## App Review notes

Limit 4000. Count: 1456.

```text
No account or sign-in is needed. SpecWithCode for iPhone is a remote control for SpecWithCode, a desktop app people run on their own computers. Real use needs SpecWithCode running on a computer the phone can reach; the phone pairs with it once using a one-time code shown as a QR code or link (on the computer: Settings > Connections > Pair a phone).

To review without a computer, use the built-in sample data:
1. Launch the app. The welcome screen opens.
2. Tap "Explore with sample data" below "Pair a machine". A "Sample data" bar stays at the top; tap Exit there to leave.
3. Aide, the personal assistant, opens as a chat. Tap the menu button (top left) for the drawer with projects, recent threads and settings (gear, bottom left).
4. Tap SpecWeave to open its coordinator chat, then the Threads button (top right) to see threads grouped as Needs you, Working and Idle.
5. Open "Release 3.1 checklist" to see an approval card with Approve, For session and Deny. The ... menu has Pin, Resolve, Mark unread and Archive.
6. Tap the project title at the top of a project chat for project settings. Tap the gear in the drawer for global settings and the list of machines.

The sample data is made up and stays on the device; nothing is sent anywhere in that mode.

Permissions: the camera is used only to scan the pairing QR code, and local network access only to reach the user's own computers. The app has no ads, analytics, tracking or in-app purchases.
```

## What to Test (TestFlight)

Limit 4000. Count: 1049.

```text
This is the first TestFlight build of SpecWithCode for iPhone.

Please try:
- Pairing: on your computer, open SpecWithCode, go to Settings > Connections and choose Pair a phone, then scan the QR code or paste the link.
- Aide: ask what needs you and check that the answer arrives.
- A project: open it from the drawer, send its coordinator a message, then open Threads.
- A thread: send a message while it runs (it queues), stop a run, answer an approval, then pin, resolve and reopen it.
- Settings: change a project's goal or instructions, pause and resume its coordinator, and change the default machine, approval mode and appearance.
- Leave the app for a minute and come back: it should reconnect without showing your machines offline.

No machine at hand? Tap "Explore with sample data" on the welcome screen.

Not in this build: push notifications, attachments, terminal and diffs, iPad layout. A pairing lasts 30 days; pair again after that.

To send feedback, take a screenshot in the app and tap Share Beta Feedback.
```

## Screenshots

6.9-inch display (1320 x 2868), six per appearance, made from fixture data on an iPhone 17 Pro Max simulator with a 9:41 status bar. Upload one set; the light set is the default.

1. `01-aide-chat`: Aide's morning summary across machines
2. `02-drawer-projects`: drawer with Aide, projects and recent threads
3. `03-thread-approval`: a thread with an approval card
4. `04-threads-overview`: a project's threads grouped as Needs you, Working and Idle
5. `05-project-settings`: project name, goal, instructions and pause
6. `06-settings-machines`: machines, defaults for new threads and appearance

The shots use neutral sample names: the main machine is "Office Mac" and the coordinator model shows "Default". The sample data the app ships with (`SWCKit/Sources/SWCSync/FixtureEngine.swift`, also shown to App Review through Explore with sample data) uses the same names.

## Steps that need the owner's go-ahead

1. Register the explicit App ID `com.specwithcode.ios` in Certificates, Identifiers & Profiles. No capabilities are needed.
2. Create the App Store Connect app record: platform iOS, name SpecWithCode, primary language English (U.S.), bundle id `com.specwithcode.ios`, SKU `specwithcode-ios`, full access.
3. Set the team id: `project.yml` reads `DEVELOPMENT_TEAM` from an environment variable (see README > Build). Set it, then run `xcodegen generate`.
4. Archive and upload: archive the `SpecWithCode` scheme in Release with automatic signing (this creates the distribution certificate and profile), then upload to App Store Connect from Xcode Organizer or with `xcodebuild -exportArchive` (method `app-store-connect`). Choose the version first: `0.1.0` (1) as is, or raise `MARKETING_VERSION` before the first App Store release.
5. Add testers: internal testers from the team right after processing; external testers need a TestFlight group, the What to Test text, the review notes above and Beta App Review.
6. Before App Store review: fill in the review contact (name, phone, email), set price (free) and availability, declare EU trader status, and paste the listing, App Privacy and age rating answers from this file.
