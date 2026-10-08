# SmoothBoost

SmoothBoost is a Manifest V3 browser extension for Chrome and Helium. The default Maximum profile pauses muted, looping background previews and removes backdrop blur while preserving site animations, normal scrolling, shadows, filters, embedded players, and controls. Balanced leaves site behavior and visuals unchanged. Custom exposes optional controls for stronger changes, including a page-wide animation-frame limit.

## Credit

The original SmoothBoost / Web Lag & Animation Killer project is by [BiniFn](https://github.com/BiniFn). This repository carries the project forward with Chrome and Helium packaging, safer performance profiles, status reporting, and the Re:Anime carousel rule.

## Install in Chrome or Helium

### Install from the ZIP

1. Download `SmoothBoost-1.0.6.zip` from the [Version 1.0.6 release](https://github.com/BiniFn/SmoothBoost-Web-Lag-Animation-Killer/releases/tag/v1.0.6) and extract it.
2. Open `chrome://extensions` in Chrome or Helium.
3. Turn on **Developer mode** and choose **Load unpacked**.
4. Select the extracted folder containing `manifest.json`.
5. Pin SmoothBoost from the extensions menu if you want one-click access.
6. Reload already-open tabs after loading or updating SmoothBoost so its document-start scripts can run.

For local development, **Load unpacked** can also point directly to this project folder.

The same install and usage steps are available from the extension popup under **Install and use instructions**.

The extension runs on eligible sites by default. Use its toolbar popup to turn it off for a site or choose Maximum, Balanced, or Custom settings. Maximum leaves JavaScript animation frames uncapped, pauses muted looping previews, and removes backdrop blur; it does not rewrite wheel handlers or force CSS animations to finish, which can break site scrolling, hide content, or produce blank views. Balanced leaves site behavior and visuals unchanged. The Custom profile includes optional controls that can affect a site's appearance or behavior; use them per site if needed. The optional frame limiter is page-wide and may feel choppy. Media handling is limited to muted, looping autoplay previews in the top-level page; embedded video players and their playback controls are left alone, and previews paused by SmoothBoost resume when it is turned off. On `reanime.to`'s home page, SmoothBoost detects and stops the hero's autoplay interval, restores the slide that was showing, and keeps the manual slide controls available. The popup reports whether that pause was confirmed. The shortcut is **Option/Alt + Shift + S**; browser shortcut settings can change or reassign it.

Use the **Help & Bugs** popup tab to open a GitHub issue, view existing issues, see the BiniFn credit, or read install instructions. When reporting a bug, include your browser, site, profile, expected and actual behavior, and steps to reproduce it. Upgrading from an earlier version resets the old Custom feature defaults once while preserving the selected profile and frame-limit choice; re-enable any optional Custom controls you want to use.

### Build a ZIP package

Run this from the project folder to rebuild the ZIP:

```sh
python3 scripts/package_extension.py
```

The generated `dist/SmoothBoost-1.0.6.zip` contains the extension files at the archive root. For local Developer mode installation, use **Load unpacked** and select the extracted folder; Chrome does not load this ZIP directly from that button. Reload open tabs after installing or updating the extension so document-start scripts take effect.

## Try the included stress page

Open `test-page.html` in Chrome or Helium, then enable SmoothBoost. If the page is opened as a `file://` URL, enable **Allow access to file URLs** for SmoothBoost on the extensions page. The test page loads a public sample video from Google Cloud Storage.

## Project files

- `manifest.json` — extension metadata, permissions, scripts, and shortcut.
- `popup/` — toolbar controls and styling.
- `scripts/` — service worker, isolated content script, page-world performance hooks, and ZIP packager.
- `icons/` — extension icons.
- `test-page.html` — local performance stress page; excluded from the ZIP.
