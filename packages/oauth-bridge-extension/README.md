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
`gmckjokkoeeokoldknjmaipdbnceldil` on every machine. The dashboard uses that ID to reach
`ping.json` and `approve.html`; set `NEXT_PUBLIC_OAUTH_HELPER_EXTENSION_ID` to point it at a
different build (for example the Web Store one). The private key is not in the repository.

## Approve a dashboard

The Connect dialog does this for you: when it finds the helper installed but not yet allowed on
the dashboard, it opens a small window (`approve.html?origin=<dashboard origin>`) that shows the
dashboard address and one Allow on `<host>` button. Click it, accept Chrome's permission prompt
and the window closes itself. Already open dashboard tabs pick the helper up without a reload.

Manual alternative: with the dashboard tab focused, click the extension icon, then Use with this
site.

Use Remove in the popup to revoke a dashboard at any time.

### What a web page can see

- `ping.json` (`{"name":"omniroute-oauth-bridge","version":1}`) is readable from any site, so the
  dashboard can tell the helper is installed before it is allowed. It reveals nothing else.
- `approve.html` can be opened by any site, but it only acts after you click Allow on the
  address it shows, exactly like the popup. The service worker accepts the `approve-origin`
  message from extension pages only (never from content scripts or web pages) and only for an
  origin whose permission you just granted.

## How a sign-in works

1. In the Connect dialog you start a sign-in; the dashboard arms the extension for that one `state`.
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
- The extension only reads pages of dashboards you approved.

## Permissions

- `declarativeNetRequest`: add the one-shot redirect rule.
- `storage`: remember which dashboards you approved.
- `scripting`: register and inject the content script on approved dashboards.
- `webNavigation`: detect the redirect landing so the tab can be closed.
- `alarms`: expire rules after 10 minutes.
- `activeTab`: read the focused tab's address when you click the icon, so the popup can offer
  that dashboard for approval.
- `host_permissions`: the provider redirect hosts listed above, generated from the registry.
- `optional_host_permissions` (`http://*/*`, `https://*/*`): requested per dashboard when you
  click Use with this site.

## Publishing to the Chrome Web Store

`npm run oauth-bridge:package` writes `dist/omniroute-oauth-bridge-<version>.zip` (gitignored)
with `manifest.json`, `ping.json`, `approve.html` and `src/`. The packaged manifest drops `key`,
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
- `scripting`: registers the content script on dashboards the user approved and injects it
  into already open dashboard tabs right after approval.
- `storage`: remembers the list of approved dashboard origins and the short-lived armed
  sign-ins.
- `alarms`: expires each armed redirect rule after 10 minutes.
- `webNavigation`: notices when the callback page loads so the rule is removed and the
  temporary callback tab is closed.
- `activeTab`: lets the toolbar popup read the address of the focused tab when the user clicks
  the icon, so it can offer that dashboard for approval.
- `host_permissions` (loopback hosts and provider code pages): the redirect rule can only act on
  requests to hosts the extension has access to; these are the fixed callback hosts of the
  supported providers.
- `optional_host_permissions` (`http://*/*`, `https://*/*`): requested at runtime for one
  dashboard origin at a time, only after the user clicks Allow; OmniRoute dashboards are
  self-hosted on arbitrary domains, so they cannot be listed in advance.

## Regenerating

`npm run oauth-bridge:build` rewrites `manifest.json` `host_permissions` and
`src/allowedRedirects.generated.js` from `src/lib/oauth/externalRedirects.ts`.
`npm run check:oauth-bridge` fails in CI when they drift.
