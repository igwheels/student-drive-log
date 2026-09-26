# App Store Privacy Nutrition Label + Play Data Safety — Answer Key

**Linear:** DEV-25 (Step 12) · **Source:** code audit of this repo at commit `4947022` · **Date:** 2026-09-02
**Rev 2 (2026-09-02):** open-questions pass — 1, 2, 3, 4, 5, 8 resolved (code changes landed + verified with an iOS simulator build and binary symbol inspection); 6 staged; 7, 9, 10 need a product/ops decision. Details in [Open questions](#open-questions).
**Rev 3 (2026-09-02):** decision items taken on — Privacy Policy corrected (analytics bullet removed + accuracy fixes), `users/{uid}` orphan fixed in code (rules + client — **not published**), OpenStreetMap added to the Privacy Policy as a processor (chosen over self-hosting), Resend processor details written up for your records, Firebase CLI wired for rules deploys (`firebase.json` + `.firebaserc` added; no login/deploy performed). Web build still passes. See [Open questions](#open-questions) 7/9/10 and [§4](#4-cross-check-against-the-in-app-privacy-policy).

This is a transcription-ready answer key for the two store privacy forms:

- **Apple** — App Store Connect → your app → **App Privacy**
- **Google** — Play Console → your app → **App content → Data safety**

Every answer below is derived from the code, not assumptions. Where the code
can't settle a question, it's called out in [Open questions](#open-questions)
rather than guessed. Nothing here is filled into a real console yet — no
developer accounts exist (per the issue).

---

## 1. What the app actually collects (master inventory)

"Collected" here means **transmitted off the device** (to Firestore, Firebase
Auth, or Resend). Data that never leaves the device is noted separately in
§1.2.

| # | Data | Where it's entered / captured | Where it goes | Linked to a person? | Used for tracking/ads? | Purpose | Retention |
|---|------|-------------------------------|---------------|---------------------|------------------------|---------|-----------|
| 1 | **Account email address** | Login screen (email/password) or Google Sign-In (Google returns profile email) | Firebase Auth; copied onto each student doc as `ownerEmail`; used as the key of `emailPreferences/{email}` | Yes — it *is* the account identifier | No | Authentication, account security, cross-device sync; sending verification / password-reset / weekly-progress / share-invitation email | Life of account. `deleteUser()` removes the Auth record. The `emailPreferences/{email}` doc is intentionally **kept** if the address is still a weekly-email recipient on someone else's dashboard (see `Account.jsx`). Transient copies in routine backups. |
| 2 | **Name** | Student first + last name typed by the supervising adult (`AddStudent`). Account owner's name only if they use Google Sign-In (Firebase returns the Google display name; email/password accounts get a name derived from the email local-part, never asked). | Student doc; `studentDirectory` entry (first/last name + owner name, keyed by SHA-256 of the student email); rendered into the PDF log; student first name appears in weekly emails and in shareable snapshot links | Yes | No | Produce the driving log / affidavit; label dashboards; address the weekly email | Deleted with the student (student doc + directory entry). Snapshot links already sent can't be revoked (data is encoded in the URL). |
| 3 | **Precise location (GPS)** | `navigator.geolocation.watchPosition({enableHighAccuracy:true})` **only while a drive timer is actively running in the foreground**, only after permission is granted. Captures start point, end point, and the full route polyline. (`src/utils/geo.js`) | Stored on the drive-log doc as `startLocation`, `endLocation`, `route`; cached in device `localStorage` (`sdl_data_v1`) until sign-out; **not** included in weekly progress emails (maps removed to avoid exposing minors' location patterns) | Yes — tied to the student/account | No | Auto-calculate drive mileage; draw the route map shown in-app (never in email) | Stored on the log indefinitely until the drive, the student, or the account is deleted. Local cache cleared on sign-out. `sdl_pending_drive` (sessionStorage) is a ≤12 h tab-scoped handoff buffer. |
| 4 | **Driving records** | Log form (`LogDrive`) / drive timer: date, start & end time, duration, day-vs-night, road type, optional distance in miles, skill-category tags. Plus the student's **state of residence**. | Drive-log docs under `users/{ownerId}/students/{studentId}/logs`; cached in `localStorage`; summarized in weekly emails; exported into the user-generated PDF/CSV | Yes | No | Core function — track progress toward the state's supervised-hours requirement; generate the DMV affidavit | Deleted with the drive, the student, or the account. |
| 5 | **Other people's email addresses** | Owner types an address to (a) receive a student's weekly progress emails (`student.email`) or (b) share a dashboard / invite another guardian (`ShareModal` → `sharedWithEmails`, `invitations`, `accessRequests`) | Student doc (`email`, `sharedWithEmails`); `invitations` queue (drained by `send-invitation-emails.js` via Resend); `accessRequests` docs; all recipient addresses passed to **Resend** for delivery | Yes (identifies a third party) | No | Grant shared dashboard access; deliver invitation and weekly-progress email | `invitations` entries deletable by the owner and removed when the student is deleted; `accessRequests` deleted on approve/deny/student-deletion; `sharedWithEmails` cleared on unshare or student deletion. |
| 6 | **User ID** | Assigned by Firebase Auth on sign-in | `ownerId` throughout Firestore paths; `users/{uid}` doc also stores a random **session token** + timestamp for single-active-session enforcement | Yes | No | Address the user's data; enforce one active session per account | UID is the account key. **The `users/{uid}` doc is not removed by account deletion** — rules set `allow delete: if false` and the delete flow doesn't touch it (see Open question 10). It holds only a random UUID + timestamp, no PII. |

### 1.1 Third parties / data recipients

| Recipient | Role | What it receives | Store-form treatment |
|-----------|------|------------------|----------------------|
| **Google Firebase** (Firestore + Authentication), Google Cloud, US | Backend / processor acting on our behalf | All of rows 1–6 | Apple: still "collection" by us. Google Play: a **service provider**, so **not** "Shared". |
| **Resend** (`resend.com`) | Transactional email processor | Recipient email addresses; student first name; drive summaries (rows 2, 4, 5); no location data or maps | Same as above — service provider, not "Shared" under Play's definition. |
| **OpenStreetMap Foundation** (`tile.openstreetmap.org`) | Map tile images: requested from the user's browser by the in-app Leaflet map (`DriveMap.jsx`), (the weekly email no longer renders maps, so no server-side tile requests are made) | Requesting IP + tile x/y/z indices (which imply the map area being viewed). The route/coordinates are **not** sent. | Not a "share" on either form. Disclosed in Privacy Policy §6 (Rev 3). Self-hosting judged not warranted — Open question 7. |
| **GitHub Pages** | Static web hosting (web build only) | Nothing user-specific beyond standard web-server request logs | Not applicable to the iOS/Android submissions. |

### 1.2 On-device only (not "collected" by either form's definition)

- `localStorage` `sdl_data_v1` — offline cache of students + logs + GPS routes. Cleared on sign-out.
- `sessionStorage` `sdl_pending_drive`, `sdl_session_kicked` — transient UI plumbing.
- The exported **PDF / CSV driving log** — generated client-side (`src/utils/pdfExport.js`) and handed to the OS share sheet / file system by the user. Never uploaded by us.

### 1.3 What the app does NOT collect (verified absent in code)

| Not collected | Evidence |
|---------------|----------|
| Analytics / usage data | No `firebase/analytics` import anywhere; `getAnalytics`/`logEvent` never called. `measurementId` removed from `src/firebase.js` (Rev 2). iOS `GoogleService-Info.plist` has `IS_ANALYTICS_ENABLED = false`, `IS_ADS_ENABLED = false`. No `firebase-analytics` Gradle dependency. **Binary-verified** (Rev 2): a release-config-equivalent iOS simulator build links only `FirebaseAuth` + `FirebaseCore` (+ auth/sign-in support libs) — no `FirebaseAnalytics` module, no `GoogleAppMeasurement` (`APM*`) classes, no public `FIRAnalytics` API class, no `GoogleAdsOnDeviceConversion`. `googleappmeasurement` and `google-ads-on-device-conversion-ios-sdk` appear in `Package.resolved` only as unrealized graph resolution from firebase-ios-sdk's manifest; neither is compiled in. |
| Crash logs / diagnostics / performance data | No Crashlytics, no Sentry, no Firebase Performance — none in `package.json`, SPM graph, or the linked iOS binary, or Gradle. |
| Advertising ID / IDFA / device advertising identifiers | No ad SDKs; no `AD_ID` permission in the Android manifest; no `NSUserTrackingUsageDescription` / ATT prompt in `Info.plist`. Facebook SDK (which could read IDFV) **removed from the iOS build** via SPM trait override (Rev 2) — binary-verified: no `FBSDK*` classes linked. |
| Approximate location | `src/utils/geo.js` **rejects** fixes coarser than 100 m — they're reported to the UI but never pushed to `route` or stored. `ACCESS_COARSE_LOCATION` stays in the manifest because it is **mandatory** alongside `ACCESS_FINE_LOCATION` (Android 12+ platform rule for `targetSdk 36`) and Capacitor core's WebView geolocation bridge (`BridgeWebChromeClient`) checks for both — see Open question 3. No approximate location is transmitted or stored. |
| Payment / financial info | No IAP, no billing, no Stripe/RevenueCat — nothing in code. |
| Contacts (device address book), Photos/Camera, Microphone/Audio, Calendar, Health, SMS/Messages, Browsing/Search history | No corresponding permissions or APIs. The only `Info.plist` usage string is `NSLocationWhenInUseUsageDescription`. |
| Phone number, physical/mailing address, race/ethnicity, political/religious beliefs, sexual orientation, other sensitive categories | Never entered or captured. |
| Password | Handled entirely by Firebase Auth; never seen or stored by app code. |

---

## 2. Apple — App Store Privacy Nutrition Label

App Store Connect flow: **App Privacy → Get Started**. For every Apple data
type it asks "Do you collect this data?"; for each one you say yes, it then
asks **(a)** purpose(s), **(b)** "linked to the user's identity?", **(c)**
"used for tracking?".

### 2.1 Top-level

| Prompt | Answer |
|--------|--------|
| Do you or your third-party partners collect data from this app? | **Yes** |
| Data used to track you | **None** — no ATT prompt, no ad networks, no data-broker sale, no linking with third-party data for advertising. (The Facebook SDK that used to be linked on iOS has been removed — Open question 1, resolved.) |

### 2.2 Mark these data types as **Collected** — all others as *Not Collected*

For **every** row below the answers to (b) and (c) are the same:
**Linked to the user's identity: YES** · **Used for tracking: NO** ·
**Purpose: App Functionality** (only).

| Apple category → data type | Collect? | Notes to keep with the submission |
|----------------------------|----------|-----------------------------------|
| **Contact Info → Name** | Yes | Student first/last name entered by the supervising adult; account-owner name only via Google Sign-In. Not used for personalization or marketing. |
| **Contact Info → Email Address** | Yes | Account email (email/password or Google); plus addresses the user types to receive a student's progress emails and to share/invite another guardian. Used for auth, account security, granting shared access, and transactional + weekly-progress email. |
| **Location → Precise Location** | Yes | GPS start point, end point, and route, captured **only during an actively-running drive timer**, in the foreground, with permission. Used to compute mileage and draw the route map (in-app only; weekly emails contain no maps). Optional — user can decline and enter mileage by hand. No background collection. |
| **User Content → Other User Content** | Yes | The supervised-driving records the user creates: date, times, duration, day/night, road type, optional distance, skill tags, and the student's state. |
| **Identifiers → User ID** | Yes | Firebase Auth UID + a random single-session token. No advertising identifier is accessed. |

### 2.3 Explicitly *Not Collected* (select "No" for each)

Financial Info · Health & Fitness · Contacts · Coarse/Precise beyond the
above · Sensitive Info · User Content: Emails or Text Messages, Photos or
Videos, Audio Data, Gameplay Content, Customer Support · Browsing History ·
Search History · Identifiers: Device ID · Purchases · Usage Data (Product
Interaction, Advertising Data, Other) · Diagnostics (Crash Data, Performance
Data, Other) · Other Data.

### 2.4 Resulting label preview

- **Data Linked to You:** Contact Info, Location, User Content, Identifiers
- **Data Not Linked to You:** none
- **Data Used to Track You:** none

---

## 3. Google Play — Data Safety

Play Console flow: **App content → Data safety**. Sections: *Data collection
and security* (top-level), then *Data types* (collected / shared, per type),
then per-type detail (ephemeral?, required vs optional, purposes).

### 3.1 Top-level — Data collection and security

| Prompt | Answer | Basis |
|--------|--------|-------|
| Does your app collect or share any of the required user data types? | **Yes** | Rows 1–6 above. |
| Is all of the user data collected by your app encrypted in transit? | **Yes** | Firebase SDK (HTTPS/TLS), Resend API (HTTPS), OSM tiles (HTTPS). No plaintext transport in code. |
| Do you provide a way for users to request that their data be deleted? | **Yes — account deletion + partial deletion in-app**, plus email. URL to give the console: **`https://sdl.devworksllc.com/data-deletion.html`** (staged at `public/data-deletion.html`, live after the next deploy — Open question 4). | `Account.jsx`, `AppContext.deleteStudent`. Account page deletes the account and every owned dashboard/log (`deleteUser` + Firestore cleanup); Manage Students deletes a single student and all their drives; email fallback to `ian@devworksllc.com`. |

> **"Shared" is "No" for every type.** Under Play's definition, transfers to a
> *service provider* processing on your behalf (Firebase, Resend) are not
> "sharing", and weekly-email content goes only to the user and the people
> they explicitly authorized. Nothing is sold, and nothing goes to a third
> party for that party's own purposes.

### 3.2 Data types — declare as **Collected = Yes, Shared = No**

| Play category → type | Collected | Ephemeral? | Required / Optional | Purposes |
|----------------------|-----------|------------|---------------------|----------|
| **Location → Precise location** | Yes | No (stored on the log) | **Optional** — permission can be declined; mileage can be typed in | App functionality |
| **Personal info → Name** | Yes | No | **Required** (student name is needed to create a student; owner name only via Google Sign-In) | App functionality |
| **Personal info → Email address** | Yes | No | **Required** (account email). Recipient/invitee addresses are a user-chosen feature. | App functionality; Account management |
| **Personal info → User IDs** | Yes | No | **Required** | App functionality; Fraud prevention, security & compliance (single-active-session enforcement); Account management |
| **App activity → Other user-generated content** | Yes | No | **Required** | App functionality |

*(The "Other user-generated content" row covers the drive-log entries, skill
tags, and state of residence — rows 3–4 of the master table, minus the GPS
coordinates which are declared under Location.)*

### 3.3 Data types — declare as **Not collected**

| Play category → type | Why |
|----------------------|-----|
| Location → **Approximate location** | Coarse fixes are explicitly discarded (`geo.js`); see Open question 3. |
| Personal info → Address, Phone number, Race/ethnicity, Political/religious beliefs, Sexual orientation, Other info | Never captured. |
| Financial info (all) | No payments. |
| Health and fitness (all) | N/A. |
| Messages (all) | N/A. |
| Photos and videos / Audio files / Files and docs / Calendar / Contacts | No permissions or APIs. (Exported PDF/CSV is created on-device and handed to the user; not collected.) |
| App activity → App interactions, In-app search history, Installed apps, Other actions | No analytics/telemetry. |
| Web browsing history | N/A. |
| App info and performance → Crash logs, Diagnostics, Other performance data | No crash/telemetry SDK. |
| **Device or other IDs** | No advertising ID, SSAID, IMEI, or similar. `AD_ID` permission absent. Facebook SDK not linked on either platform (Android: `compileOnly`; iOS: removed via SPM trait in Rev 2). |

---

## 4. Cross-check against the in-app Privacy Policy

`src/pages/PrivacyPolicy.jsx` matches this audit: account email, Google
name/email, student name/email/state, drive records, precise location "only
while a drive is actively being timed", the hashed student directory, email
preferences, "no analytics, advertising, or tracking tools of any kind",
US storage, and in-app deletion.

**Rev 3 — corrections applied to `src/pages/PrivacyPolicy.jsx`** (still your
legal doc; review before it ships):

- **Removed** the §3 bullet "To understand overall usage and improve the
  Service" — it implied analytics the app doesn't have and contradicted §2.
- §1 "Student directory" now lists the fields the entry actually holds
  (first **and last** name, **email address**, dashboard id, owner name
  **and account id**) instead of just "first name … and the owner's name".
  The hash is the document *key*; the body is not hashed.
- §1 "Driving records" now also names the **skills-practiced tags** that are
  stored on each drive.
- §4 "Information about minors" now includes **location/route** in its "only
  what is needed" list (it was omitted).
- §6 adds **OpenStreetMap Foundation** as a processor — see Open question 7.
- §9 adds the **retention carve-outs** (co-parent-logged drives stay with
  the owner; your address can remain on another owner's dashboard; an
  opt-out is kept if you're still a recipient elsewhere) — matches
  `public/data-deletion.html`. Keep the two in sync.
- "Last updated" bumped to **September 2026**. Re-bump if it ships later.

Not changed (needs your judgement, not a code fix):

- §5 "Google Cloud infrastructure in the United States" — the Firestore
  region isn't in the repo. Confirm it in the Firebase console (Firestore →
  location) before certifying.
- §5 "only your account … can read your data" is right for student/drive
  data; note `emailPreferences` single-doc `get` is public and
  `studentDirectory` `get` is any-signed-in-user (both disclosed elsewhere
  in §1). Fine as written, flagged for completeness.

---

## Open questions

Status after Rev 3. Numbering unchanged from Rev 1.
(The first task list used a different order: 1 = OQ1, 2 = OQ2, 3 = OQ3,
4 = OQ6, 5 = OQ5, 6 = OQ4. The second task list = OQ 7, 9, 10, plus the
Privacy Policy scan folded into [§4](#4-cross-check-against-the-in-app-privacy-policy).)

**Where things stand:** OQ 1, 2, 3, 5, 6, 7, 8 fully resolved. OQ 9 — my
part done, DPA paperwork is yours. OQ 4 (deletion page) and OQ 10 (session
doc) — **code is ready; nothing published**. Still on you: publish
`firestore.rules` (steps in OQ10), deploy + wire the deletion URL (OQ4),
review the Privacy Policy legal edits (§4), Resend paperwork (OQ9), confirm
the Firestore region for §5, and the iOS build residuals (release Mac needs
Xcode ≥ 16.3; regenerate the App Privacy report at archive time).

### 1. Facebook Login SDK on iOS — ✅ RESOLVED (code change landed + binary-verified)

The Rev 1 finding stands: `@capacitor-firebase/authentication@8.4.0`'s
SwiftPM manifest linked `FacebookCore` + `FacebookLogin` unconditionally, so
the iOS binary carried the Facebook SDK even though only Google sign-in is
offered. (Android was already clean — `rgcfaIncludeFacebook` unset →
`compileOnly`.)

**Fix (clean, supported — no dependency patching):**

- Upgraded the plugin to **`@capacitor-firebase/authentication@^8.5.1`**.
  v8.5.0 added SwiftPM **traits** (`Lite` / `Google` / `Facebook`; default =
  `["Google", "Facebook"]`) that make each optional SDK conditional. No
  breaking changes in 8.5.0/8.5.1; the pre-existing `firebase` JS peer
  (`^12.6.0`, marked optional — the app is on `^11` already) is unchanged by
  this bump.
- Added to `capacitor.config.json`:
  ```json
  "experimental": { "ios": { "spm": {
    "swiftToolsVersion": "6.1",
    "packageTraits": { "@capacitor-firebase/authentication": ["Google"] }
  } } }
  ```
  Capacitor CLI 8.5.0+ emits `traits: ["Google"]` on the plugin's
  `.package(...)` line in the generated `ios/App/CapApp-SPM/Package.swift`.
  `swiftToolsVersion: "6.1"` only raises the generated **manifest** format
  (the plugin pins `swiftLanguageModes: [.v5]`, so no Swift 6 language-mode
  opt-in); it's the CLI's documented gate for traits.
- Ran `npx cap sync ios` (and `android`).

**Verification (this machine — Xcode 26.6 / Swift 6.3):**

- `xcodebuild -resolvePackageDependencies` → `facebook-ios-sdk` **gone** from
  the resolved graph; `GoogleSignIn` still present.
- Full `xcodebuild build` (iphonesimulator, `CODE_SIGNING_ALLOWED=NO`) →
  **BUILD SUCCEEDED**, 1 benign warning (no AppIntents.framework), no trait
  or SPM-identity warnings.
- `nm` on the built binary → **no `FBSDK*` classes**. Linked modules:
  `FirebaseAuth`, `FirebaseCore(+Extension/Internal)`, `GoogleSignIn`,
  `AppAuth`, `GTMAppAuth`, `GTMSessionFetcher`, `AppCheckCore`, `FBLPromises`,
  Capacitor plugins. Nothing Facebook.

**Residual:** needs the same clean build on the CI/release Mac (Xcode ≥ 16.3
for Swift-tools 6.1). The `experimental.ios.spm` block is stable API but
Capacitor labels it "experimental" — pin the plugin minor (`~8.5.1`) so a
future manifest change can't silently reintroduce Facebook.

### 2. GoogleAppMeasurement / ads-conversion on iOS — ✅ RESOLVED (binary-verified, not linked)

Established by inspecting the built binary, not `Package.resolved`:

- Linked Firebase modules: `FirebaseAuth`, `FirebaseAuthInternal`,
  `FirebaseCore`, `FirebaseCoreExtension`, `FirebaseCoreInternal` — **auth
  only**.
- **No** `FirebaseAnalytics` module. **No** `GoogleAppMeasurement` — no
  `APM*` classes, no `GoogleAppMeasurementVersionNumber` symbol. **No**
  public `FIRAnalytics` class. **No** `GoogleAdsOnDeviceConversion`
  (`GAD*`/`ODC*`) classes.
- `FIRAnalyticsConfiguration` **is** present — but it ships inside
  `FirebaseCore` (a no-op notification shim for other SDKs to coordinate
  with); with no measurement library present nothing consumes it.
- `googleappmeasurement` / `google-ads-on-device-conversion-ios-sdk` remain
  in `Package.resolved` purely because SwiftPM resolves firebase-ios-sdk's
  whole manifest regardless of which products are referenced. Resolution ≠
  linking.

Debug build; a Release build strips more, not less. Safe to certify "no
analytics / ads SDK ships" for iOS. Android already had no
`firebase-analytics` dependency.

### 3. Android `ACCESS_COARSE_LOCATION` — ✅ RESOLVED (must stay; no change)

**Cannot be removed.** Two independent hard requirements:

1. **Platform rule.** `targetSdk = 36`. Since Android 12 (API 31), declaring
   `ACCESS_FINE_LOCATION` **requires** co-declaring `ACCESS_COARSE_LOCATION`,
   or the fine-location request is rejected by the system.
2. **Capacitor core.** `BridgeWebChromeClient.onGeolocationPermissionsShowPrompt`
   checks/requests `{ ACCESS_COARSE_LOCATION, ACCESS_FINE_LOCATION }` as a
   pair; a manifest missing COARSE makes `hasPermissions(...)` always false
   and WebView geolocation is denied outright.

It is infrastructure, not a data signal. The app still does not collect
(transmit/store) approximate location — `geo.js` discards fixes coarser than
100 m. **Play answer: Approximate location → not collected** (with the nuance
that the OS may hand a coarse fix to the JS API if the user grants
"approximate only"; the app rejects it and nothing is sent).

### 4. Data-deletion URL for Play — 🟡 STAGED (not deployed, per instruction)

Created **`public/data-deletion.html`** — a standalone, no-JS, no-login page
that documents: (1) in-app whole-account deletion, (2) in-app single-student
deletion, (3) email request to `ian@devworksllc.com` from the account
address, with a **30-day** completion commitment. Lists what is deleted and
the retention carve-outs (mirrors Privacy Policy §9, including the OQ10
session record). Styled to match the app; verified it renders via
`vite preview`.

**To put it live** (all deferred to you):

1. It's already picked up by `npm run build` (files in `public/` copy to the
   site root) and by the PWA precache. Nothing else to wire.
2. Merge + let `.github/workflows/deploy.yml` publish on push to `main`.
3. Live URL will be **`https://sdl.devworksllc.com/data-deletion.html`**.
4. Paste that URL into Play Console → Data safety → "Provide a way for users
   to request that their data is deleted" and into the App Store Connect
   listing's account-deletion field. Optionally link it from the in-app
   Account page and the Privacy Policy.
5. Decide whether the 30-day SLA and the wording of the retention carve-outs
   are what you want to commit to publicly.

### 5. iOS `PrivacyInfo.xcprivacy` — ✅ RESOLVED (created + build-verified)

Added **`ios/App/App/PrivacyInfo.xcprivacy`** and registered it in the App
target (`project.pbxproj`: file reference + `App` group + Resources build
phase, IDs `A1B2C3D4…A1F1/A1F2`). Contents:

- `NSPrivacyTracking = false`, `NSPrivacyTrackingDomains = []`.
- `NSPrivacyCollectedDataTypes`: `EmailAddress`, `Name`, `PreciseLocation`,
  `OtherUserContent`, `UserID` — each `Linked = true`, `Tracking = false`,
  purpose `AppFunctionality`. (Matches §2 of this doc.)
- `NSPrivacyAccessedAPITypes = []` — first-party Swift
  (`AppDelegate`/`SceneDelegate`) calls no required-reason API; the web
  layer's persistence is WKWebView `localStorage`, not Foundation
  `UserDefaults`. The embedded SDKs (Capacitor, Firebase, GoogleSignIn,
  GTMSessionFetcher, GoogleUtilities, …) each ship their own manifest and
  Xcode aggregates them — verified present in the build output.

**Verified:** `plutil -lint` OK; `xcodebuild build` → BUILD SUCCEEDED;
`App.app/PrivacyInfo.xcprivacy` present at the bundle root with the expected
keys.

**Residual:** re-generate the App Privacy report in Xcode Organizer at
archive time and confirm the aggregate matches the nutrition-label answers.

### 6. iOS location usage string — ✅ RESOLVED (rewritten)

`ios/App/App/Info.plist` → `NSLocationWhenInUseUsageDescription` was:
> "…to record mileage and route on logged practice drives, and to compare
> your speed against the posted limit."

No speed/speed-limit feature exists. Now:
> "Student Drive Log uses your location only while you are timing a practice
> drive, to measure the distance driven and draw the route map on the saved
> log. You can decline and enter mileage by hand."

Data classification unchanged (precise location, during active drives only).

### 7. OpenStreetMap tile requests — ✅ RESOLVED (disclosed; self-hosting judged not warranted)

**Decision: add OpenStreetMap as a disclosed processor, do not self-host.**

Why not self-host / proxy for an app this size: the only data exposed is the
requester's IP and which map tiles (x/y/z) are fetched — no identity, no
account data, and **not** the drive's coordinates or route (tiles are
requested by grid index; the route is drawn client-side on top). That is the
same exposure as any embedded map or any third-party image. OSM's tiles are
run by the non-profit OpenStreetMap Foundation, not an ad company, with
short-retention logs for abuse prevention. Standing up a tile proxy/cache
(cost, attribution, rate-limit handling, maintenance) buys a marginal
privacy gain that isn't proportionate here. Disclosure is the right fix.

Also worth noting for accuracy: the **app map** (`DriveMap.jsx`) fetches from
the user's browser (user IP exposed); the **weekly-email renderer**
(`scripts/lib/staticImages.js`) fetches server-side from the GitHub Actions
runner with a descriptive `User-Agent` — so there the *user's* IP is not
exposed, only the CI runner's.

Done: `src/pages/PrivacyPolicy.jsx` §6 now lists "OpenStreetMap Foundation —
map imagery" with a sentence on what its tile servers receive and that maps
aren't loaded for drives without location data or for snapshot links.
Nothing to declare on either store form (still not a "share").

### 8. Dead `measurementId` — ✅ RESOLVED (removed)

`src/firebase.js` no longer carries `measurementId` (replaced with a comment
explaining why). `firebase/analytics` was never imported, so behaviour is
unchanged; this just removes any chance of accidental activation. Web build
re-run: passes.

### 9. Resend as sole email processor — 🟡 DONE (my part) / paperwork is yours

Code audit confirms Resend is the **only** outbound email path
(`scripts/send-weekly-emails.js`, `scripts/send-invitation-emails.js`;
`FROM_EMAIL = 'ian@devworksllc.com'` in both; Gmail removed in commits
`8084591` / `ed3d3dc`). Nothing to change in code.

Where it gets declared: neither the App Store nutrition label nor the Play
Data Safety form has a processor free-text field — both rely on the
**Privacy Policy URL**. `src/pages/PrivacyPolicy.jsx` §6 already names Resend
("delivery of weekly progress emails and sharing invitations"), so the
disclosure requirement is met once the policy ships. No form field to fill.

**What you need on file (you said the DPA is on you):**

| Item | Why | Where to get it |
|------|-----|-----------------|
| Signed **Data Processing Agreement** with Resend | Emails carry a minor's first name, drive summaries, and route-map images | resend.com — request via support / legal |
| Resend's current **sub-processor list** | To keep §6's "processes under its own privacy policy" honest and to answer any App Review follow-up | Resend Trust/Legal page |
| **Sender-domain verification** for `devworksllc.com` (SPF/DKIM) | Both scripts send `from: Student Drive Log <ian@devworksllc.com>` — deliverability + anti-spoofing | Resend dashboard → Domains |
| Resend's **content/log retention** window | So a future Privacy Policy §9 line about "email delivery logs" is accurate if you add one | Resend docs / DPA |
| Confirmation of **data location** (US) | §5 says data is stored in the US; Resend processing should be consistent | Resend DPA / Trust page |

None of this blocks the store forms; it's records to have before launch.

### 10. `users/{uid}` doc survives account deletion — ✅ FIXED IN CODE (rules NOT published — see below)

**Code changes landed:**

- `firestore.rules`, `match /users/{uid}`:
  `allow delete: if false;` → `allow delete: if signedIn() && request.auth.uid == uid;`
  (byte-identical in form to the `allow read` clause two lines above).
  Comment block updated to explain the account-deletion cleanup path.
- `src/context/AppContext.jsx`: new `deleteSessionClaim(uid)` next to
  `claimSession()` — `deleteDoc(doc(db, 'users', uid))` wrapped in
  try/catch, exported on the context.
- `src/pages/Account.jsx`: `performDeletion()` calls
  `await deleteSessionClaim(user.id)` **before** `deleteUser(auth.currentUser)`
  (must run while still authenticated).

**Why the rule change is safe:** `users/{uid}` holds only
`{ activeSessionToken, activeSessionUpdatedAt }` — a random UUID + ISO
timestamp, no PII, no other account's data. `delete` scoped to
`request.auth.uid == uid` is strictly weaker than the `update` the same
block already allows. Other live sessions that were watching the doc read a
missing token as "no active claim" — the watcher condition is
`if (remoteToken && localToken && remoteToken !== localToken)`, so a falsy
`remoteToken` causes **no** spurious sign-out; the next sign-in re-claims.

**Sanity checks run (no publish):** brace balance intact (36/36); the new
clause is identical to the adjacent deployed `allow read`; no other rule
reads or depends on `users/{uid}` being non-deletable (the `exists()`/`get()`
calls elsewhere target `users/{ownerId}/students/...`, a different path);
`npm run build` passes with the JS changes. `firebase-tools` isn't installed
and a real compile check requires contacting the backend, so a full
server-side lint was not possible offline.

---

**What you need to run to publish the rules** (not done — no deploy performed):

**Option A — Firebase console (no setup):** Firestore Database → Rules → paste
the full `firestore.rules` → the console validates syntax → **Publish**.

**Option B — Firebase CLI (now wired up):** Rev 3 added `firebase.json`
(maps `firestore` → `firestore.rules`, nothing else — no hosting/functions)
and `.firebaserc` (`default` → `student-driver-log-b1924`). `.firebase/` and
`firebase-debug.log` are gitignored. One-time auth, then a one-liner each
time:

```bash
# one-time: authenticate YOUR Google account (opens a browser)
npx -y firebase-tools login
npx -y firebase-tools projects:list        # sanity check — should list student-driver-log-b1924

# each publish:
npx -y firebase-tools deploy --only firestore:rules
```

`firebase login` credentials are stored in
`~/.config/configstore/firebase-tools.json` on your machine, never in the
repo. The same credential store is what the Firebase MCP reads, so once
you've logged in, `firebase_get_environment` / `firebase_deploy` from the MCP
work too (the "Gemini in Firebase ToS" prompt only gates Gemini features, not
a rules deploy). Always use `--only firestore:rules` so a stray `deploy`
can't touch anything else.

**Risk window if rules and client go live out of sync:**

| Order | What happens | Severity |
|-------|--------------|----------|
| **Rules published first, client deployed later** (recommended) | `allow delete` is live but nothing calls it yet. Zero behavioural change. | None |
| **Client deployed first, rules published later** | `deleteSessionClaim()` runs during account deletion and gets `permission-denied` (rules still say `if false`). It's caught (`console.warn`), and the rest of `performDeletion()` — student deletion, `deleteUser()`, sign-out — completes normally. Net result: identical to today (orphan doc remains). | Cosmetic only — a console warning; the orphan the fix targets simply persists until the rules catch up. |

Either order is safe because the client call is non-fatal by construction.
Recommended: **publish the rules first**, then there's never even a transient
`permission-denied`. No rollback concern — reverting the rule to `if false`
is safe at any time (the client just goes back to warning).

The Privacy Policy §9 carve-out and `public/data-deletion.html` mention "a
non-identifying session record may persist" — once the rules are published
you can drop that clause if you want, but leaving it is harmless and covers
accounts deleted before the change.
