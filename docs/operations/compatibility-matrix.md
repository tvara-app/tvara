# Compatibility matrix

## Public support

| Browser | Operating systems | Channel |
| --- | --- | --- |
| Chrome | Windows, macOS, Linux, ChromeOS | Current Stable and Beta |
| Edge | Windows, macOS | Current |

Not supported for this launch: Firefox, Safari, mobile Chrome, and browser versions outside these channels.

## Release matrix

Run this in clean profiles before every public promotion:

- Install, update, uninstall, restart, service-worker suspension, and offline recovery.
- 100%, 125%, and 150% zoom; dark/light mode; keyboard-only and screen-reader paths; reduced motion.
- Storage pressure, ad blockers, extension conflicts, and supported-provider DOM drift.
- Long-chat navigation, local archive, search, Context Bridge, exports, encrypted backup, restore, trial, purchase, refund, and device termination.

Use synthetic accounts and non-sensitive test chats. Record browser version, OS, provider, chat size, result, and linked issue for every failure.

## Provider drift

Run a weekly synthetic smoke pass for each provider. If a provider changes its DOM, disable only the affected adapter through its kill switch. Do not weaken or disable unrelated Tvara features.
