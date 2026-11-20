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

| Provider           | Redirect URI                                                   |
| ------------------ | -------------------------------------------------------------- |
| `codex`            | `http://localhost:1455/auth/callback`                          |
| `openai`           | `http://localhost:1455/auth/callback`                          |
| `claude`           | `https://platform.claude.com/oauth/code/callback`              |
| `xai-oauth`        | `http://127.0.0.1:56121/callback`                              |
| `grok-cli`         | `http://127.0.0.1:56122/callback`                              |
| `devin-desktop`    | `http://127.0.0.1:59653/callback`                              |
| `chatgpt`          | `http://127.0.0.1:1455/auth/callback`                          |
| `copilot-m365-web` | `https://login.microsoftonline.com/common/oauth2/nativeclient` |
| `devin-cli`        | `http://localhost:{port}/auth/callback`                        |
| `renderhour`       | `http://localhost:{port}/callback`                             |
| `zed-hosted`       | `http://127.0.0.1:{port}/`                                     |

`{port}` is the dashboard-chosen loopback port. `antigravity` and `agy` are not supported: Google's
native-app consent hangs without a live loopback listener, so there is no redirect to catch.

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
