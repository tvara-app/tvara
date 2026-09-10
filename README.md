# <img src="icons/icon256.png" alt="Tvara logo" width="24"> Tvara

Tvara keeps long AI chats responsive, searchable, and backed up locally without deleting messages or sending chat text to us.

## Launch support

Public launch targets are current Chrome Stable and Beta on Windows, macOS, Linux, and ChromeOS, plus current Edge on Windows and macOS. Tvara does not support mobile Chrome, Firefox, Safari, or unsupported browser versions for this launch.

Supported AI sites: ChatGPT, Claude, Gemini, Perplexity, DeepSeek, and Grok. Provider interfaces can change; an affected adapter can be disabled without affecting the rest of the extension.

## What it does

- Reduces rendering work for off-screen messages in long loaded chats.
- Adds a minimap, outline, and in-chat search.
- Stores an on-device archive of chats opened on supported sites.
- Provides local archive search, Context Bridge, and encrypted local backup as Pro features; standard local export stays free.
- Displays a provider’s own allowance information when available; otherwise shows “not reported.”

Free features need no sign-in. Google sign-in is required only to start the seven-day trial or buy and restore Pro. Pro is a one-time $1 purchase for up to five devices; there is no subscription.

## Privacy and permissions

Tvara does not transmit chat text, titles, prompts, exports, or chat URLs. It uses narrow host permissions for the named AI sites so automatic local speed, archive, search, and usage features work when you open a chat; `tvara.pages.dev` is limited to the post-purchase activation page. It does not request `tabs`, `history`, `cookies`, `bookmarks`, `webRequest`, or `scripting`.

- `storage` and `unlimitedStorage` keep settings and the archive on-device.
- `downloads` writes exports and encrypted backup files you request or schedule.
- `alarms` schedules local archive, backup, entitlement, and session checks across service-worker suspension.
- `notifications` shows local deletion-review, sign-out, and allowance notices.
- `identity` starts Google sign-in only after you choose trial, purchase, restore, or device management; it requests `openid email` only.

See the [privacy policy](https://tvara.pages.dev/privacy), [terms](https://tvara.pages.dev/terms), and [Chrome Web Store copy](store/listing.md). The privacy policy and Store listing must be updated together.

## Development

Node 24.11 or newer is required.

```sh
npm ci
npm test
npm run lint
npm run store-assets
npm run pack
npm run preflight
```

`npm run pack` creates a Chrome/Edge upload zip in `dist/`. It applies readable minification only; code obfuscation is prohibited by Chrome Web Store policy.

## Release operations

- [Compatibility matrix](docs/operations/compatibility-matrix.md)
- [Issuer architecture and SLOs](docs/architecture/issuer.md)
- [Launch checklist and incident runbook](docs/operations/launch-runbook.md)
- [Store localization workflow](store/locales/README.md)

Do not deploy or publish until `npm run preflight` passes against the exact production extension IDs and production configuration.
