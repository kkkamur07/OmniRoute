# OmniRoute Sign-in Helper

A dependency-free Chrome (Manifest V3) extension that completes OmniRoute OAuth sign-ins on
remote dashboards without copy-paste. Some providers send the final redirect to a loopback address
or a provider-hosted page that a remote dashboard cannot receive. The extension catches that one
redirect and forwards it to your dashboard's `/callback` page, which hands the code to the open
Connect dialog.

## Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked and pick `packages/oauth-bridge-extension`.

## Approve a dashboard

1. Open your OmniRoute dashboard in a tab.
2. Click the extension icon.
3. Click Use with this site and accept the permission prompt.
4. Reload the dashboard if it was already open.

Use Remove in the popup to revoke a dashboard at any time.

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

`{port}` is the dashboard's own port.

Unsupported:

- `devin-cli`: Import-token only: the browser authorize flow is retired (authorize returns 410) and OAuthModal never starts it, so there is no redirect for the extension to catch.
- `antigravity`: Google firstparty/nativeapp consent hangs without a live loopback listener, so there is no redirect to catch (see googleLoopbackHint.ts).
- `agy`: Same Google native-app consent as antigravity; hangs without a loopback listener.
- `zed-hosted`: Zed native_app_signin sends no OAuth state (zedAuth.ts createZedNativeAuthData) and redirects to http://127.0.0.1:<native_app_port>/?user_id&access_token (an RSA-encrypted token, not code/state). The bridge rule is state-keyed, so remote sign-in uses manual URL paste.

<!-- oauth-bridge:providers:end -->

If the extension is not installed, the dashboard's paste flow still works as before.

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
- `host_permissions`: the provider redirect hosts listed above, generated from the registry.
- `optional_host_permissions` (`http://*/*`, `https://*/*`): requested per dashboard when you
  click Use with this site.

## Regenerating

`npm run oauth-bridge:build` rewrites `manifest.json` `host_permissions` and
`src/allowedRedirects.generated.js` from `src/lib/oauth/externalRedirects.ts`.
`npm run check:oauth-bridge` fails in CI when they drift.
