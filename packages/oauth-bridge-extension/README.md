# OmniRoute Sign-in Helper

A dependency-free Chrome (Manifest V3) extension that completes OmniRoute OAuth sign-ins on
remote dashboards without copy-paste. Some providers send the final redirect to a loopback address
or a provider-hosted page that a remote dashboard cannot receive. The extension catches that one
redirect and forwards it to your dashboard's `/callback` page, which hands the code to the open
Connect dialog.

## Install

Install the helper from the Chrome Web Store once it is published (see
[Publishing to the Chrome Web Store](#publishing-to-the-chrome-web-store)). For development:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked and pick `packages/oauth-bridge-extension`.

### Extension ID

`manifest.json` carries a committed public `key`, so the unpacked extension always gets the ID
`gmckjokkoeeokoldknjmaipdbnceldil` on every machine. The dashboard uses that ID to load
`bridge.html` and `approve.html`; set `NEXT_PUBLIC_OAUTH_HELPER_EXTENSION_ID` to point it at a
different build (for example the Web Store one). The private key is not in the repository.

The dashboard's Content-Security-Policy must allow framing the extension. `next.config.mjs`
adds `frame-src 'self' chrome-extension://<EXTENSION_ID>` (built by
`scripts/build/oauth-bridge-csp.mjs`) using the same variable, falling back to the default ID.
Set `NEXT_PUBLIC_OAUTH_HELPER_EXTENSION_ID` at build time whenever you use a different build,
or the browser blocks the frame and the helper is never detected.

## Approve a dashboard

The Connect dialog does this for you: when it finds the helper installed but not yet allowed on
the dashboard, it opens a small window (`approve.html?origin=<dashboard origin>`) that shows the
dashboard address and one Allow on `<host>` button (disabled for the first 500 ms). Click it and
the window shows Allowed, then closes itself. There is no Chrome permission prompt. The open
dashboard tab is told the helper is approved and continues the sign-in without a reload.

The toolbar popup lists the approved dashboards; use Remove there to revoke one at any time.

### What a web page can see

While a Connect dialog is open (desktop Chromium only), the dashboard mounts one hidden iframe,
`chrome-extension://<id>/bridge.html`, and talks to it with `postMessage` only. There is no
content script and no page-readable file.

- Any site can embed `bridge.html`. On load it posts
  `{source:"omniroute-oauth-bridge", type:"ready", version, approved}` to its parent, so any
  site can learn that the helper is installed, its version, and whether that site itself is
  approved. It reveals nothing else.
- Only an approved origin can arm. The frame accepts a message only when it is embedded exactly
  one level deep (`window.parent === window.top` and one ancestor origin), the message comes from
  `window.parent`, and `event.origin` equals that ancestor origin. The dashboard origin is never
  taken from message data, and replies go to that origin only. The service worker accepts arm
  and status messages only from its own `bridge.html` frames and still requires the origin to be
  in the approved list.
- `approve.html` can be opened by any site, but it only acts after you click Allow on the
  address it shows. The service worker accepts `approve-origin` only from `approve.html` loaded
  as a top-level tab (not framed), and only for the origin in that page's own `?origin=` query.

The dashboard treats the helper as installed when the frame loads and sends `ready` within about
1.5 seconds, and as absent otherwise.

## How a sign-in works

1. In the Connect dialog you start a sign-in; the dashboard arms the extension (through the
   `bridge.html` frame) for that one `state`.
2. The extension adds a one-shot redirect rule for that `state` only.
3. You approve access at the provider; its final redirect is rewritten to
   `<dashboard-origin>/callback?<same query>`.
4. OmniRoute's `/callback` page relays the code to the Connect dialog.
5. The extension closes the callback tab after 3 seconds.

## Supported providers

<!-- oauth-bridge:providers:start -->

| Provider           | Kind                    | Redirect URI                                                   | Phase |
| ------------------ | ----------------------- | -------------------------------------------------------------- | ----- |
| `codex`            | fixed-loopback          | `http://localhost:1455/auth/callback`                          | major |
| `openai`           | fixed-loopback          | `http://localhost:1455/auth/callback`                          | major |
| `claude`           | provider-code-page      | `https://platform.claude.com/oauth/code/callback`              | major |
| `xai-oauth`        | fixed-loopback          | `http://127.0.0.1:56121/callback`                              | major |
| `grok-cli`         | fixed-loopback          | `http://127.0.0.1:56122/callback`                              | major |
| `devin-desktop`    | fixed-loopback          | `http://127.0.0.1:59653/callback`                              | later |
| `chatgpt`          | fixed-loopback          | `http://127.0.0.1:1455/auth/callback`                          | later |
| `copilot-m365-web` | provider-code-page      | `https://login.microsoftonline.com/common/oauth2/nativeclient` | later |
| `renderhour`       | dashboard-port-loopback | `http://localhost:{port}/callback`                             | later |
| `zed-hosted`       | dashboard-port-loopback | `http://127.0.0.1:{port}/`                                     | later |

`{port}` is the dashboard's own port.

Unsupported:

- `devin-cli`: Import-token only: the browser authorize flow is retired (authorize returns 410) and OAuthModal never starts it, so there is no redirect for the extension to catch.
- `antigravity`: Google firstparty/nativeapp consent hangs without a live loopback listener, so there is no redirect to catch (see googleLoopbackHint.ts).
- `agy`: Same Google native-app consent as antigravity; hangs without a loopback listener.

<!-- oauth-bridge:providers:end -->

If the extension is not installed, the dashboard's paste flow still works as before.

## How it stays working across OmniRoute updates

The extension does not hard-code exact callback URLs. It accepts the redirect URI the approved
dashboard armed with when it is:

- in the generated list (exact match, or the `{port}` template), or
- loopback: `http:` on exactly `127.0.0.1` or `localhost`, any port 1-65535, any path, or
- `https:` on the exact origin of a known provider code page from the generated list, any path.

URIs with userinfo, a query or a fragment, other schemes, other https origins, `[::1]`, the
dashboard's own origin and URIs over 2048 characters are always rejected. The redirect rule is
still built from the exact armed URI, requires the armed state, matches the main frame only, fires
once and expires after 10 minutes.

A changed callback port or path in a new OmniRoute release needs no extension update. Only a new
provider code-page origin needs a new extension build (a new `host_permissions` entry). CI
(`npm run check:oauth-bridge` and `tests/unit/lib/oauth-bridge-extension/manifest-drift.test.ts`)
fails in that case, so it cannot ship silently.

## Privacy

- Nothing leaves the browser except the redirect to your own dashboard.
- No analytics and no remote code.
- `code` and `state` values are never logged or stored beyond the one-shot rule.
- Rules expire after 10 minutes or on first match.
- The extension injects nothing into web pages and reads no page content.
- It only acts for dashboards you approved.

## Permissions

- `declarativeNetRequest`: add the one-shot redirect rule.
- `storage`: remember which dashboards you approved.
- `webNavigation`: detect the redirect landing so the tab can be closed.
- `alarms`: expire rules after 10 minutes.
- `host_permissions`: loopback (`http://127.0.0.1/*`, `http://localhost/*`) and the provider code
  pages listed above, generated from the registry. A redirect rule needs host access to the
  request URL it redirects.

There are no content scripts, no `scripting` or `activeTab`, and no optional host permissions.
Extension pages use the CSP `script-src 'self'; object-src 'self'`. `approve.html`,
`bridge.html` and their scripts are web accessible.

## Publishing to the Chrome Web Store

`npm run oauth-bridge:package` writes `dist/omniroute-oauth-bridge-<version>.zip` (gitignored)
with `manifest.json`, `approve.html`, `bridge.html` and `src/`. The packaged manifest drops `key`,
which the store does not accept; the store assigns its own ID. After the first upload, either
replace `MANIFEST_KEY` in `scripts/build/oauth-bridge-manifest.mjs` with the public key shown on
the store's Package page (so unpacked builds share the store ID) or set
`NEXT_PUBLIC_OAUTH_HELPER_EXTENSION_ID` to the store ID. Bump `version` in
`scripts/build/oauth-bridge-manifest.mjs` and `manifest.json` before each upload.

Listing text:

- **Short description:** Finish OmniRoute provider sign-ins on a remote dashboard without
  copying codes by hand.
- **Single purpose:** The extension completes OAuth sign-ins started from an OmniRoute dashboard
  the user approved, by forwarding the provider's final redirect (which targets a local address
  or a provider code page) to that dashboard's `/callback` page.
- **Remote code:** None. All code ships in the package.
- **Data usage:** No personal data is collected or transmitted. The only network effect is the
  redirect of one sign-in callback to the user's own dashboard.

Permission justifications:

- `declarativeNetRequest`: adds one session redirect rule per sign-in, scoped to the armed
  `state`, that sends the provider's callback to the approved dashboard. Removed on first match
  or after 10 minutes.
- `storage`: remembers the list of approved dashboard origins and the short-lived armed
  sign-ins.
- `alarms`: expires each armed redirect rule after 10 minutes.
- `webNavigation`: notices when the callback page loads so the rule is removed and the
  temporary callback tab is closed.
- `host_permissions` (loopback hosts and provider code pages): the redirect rule can only act on
  requests to hosts the extension has access to; these are the fixed callback hosts of the
  supported providers. No other host access is requested.

## Regenerating

`npm run oauth-bridge:build` rewrites `manifest.json` `host_permissions` and
`src/allowedRedirects.generated.js` from `src/lib/oauth/externalRedirects.ts`.
`npm run check:oauth-bridge` fails in CI when they drift.
