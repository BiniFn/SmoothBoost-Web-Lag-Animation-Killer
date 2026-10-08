# SmoothBoost

SmoothBoost is a Manifest V3 browser extension that reduces page animations, visual effects, scroll interception, and autoplaying background media. An optional Custom setting limits JavaScript animation frames. Settings are stored in the browser and can be adjusted globally or for each site.

## Credit

The original SmoothBoost / Web Lag & Animation Killer project is by [BiniFn](https://github.com/BiniFn/SmoothBoost-Web-Lag-Animation-Killer). This repository carries that project forward with the packaged Chrome/Helium extension, performance profile updates, status reporting, and the Re:Anime carousel rule.

## Install in Chrome or Helium

### Install from the ZIP

1. Download `SmoothBoost-1.0.5.zip` from the [Version 1.0 release](https://github.com/BiniFn/SmoothBoost-Web-Lag-Animation-Killer/releases/tag/v1.0) and extract it.
2. Open `chrome://extensions` in Chrome or Helium.
3. Turn on **Developer mode** and choose **Load unpacked**.
4. Select the extracted folder containing `manifest.json`.
5. Pin SmoothBoost from the extensions menu if you want one-click access.
6. Reload already-open tabs after loading or updating SmoothBoost so its document-start scripts can run.

For local development, **Load unpacked** can also point directly to this project folder.

The same install and usage steps are available from the extension popup under **Install and use instructions**.

The extension runs on all sites by default. Use its toolbar popup to turn it off for a site or choose Maximum, Balanced, or Custom settings. Maximum leaves JavaScript animation frames uncapped and reduces decorative motion and visual effects; CSS animations finish almost instantly instead of freezing content in its hidden first frame. A 30 FPS limit is available as an optional Custom setting. Media handling is limited to muted, looping autoplay previews in the top-level page; embedded video players and their playback controls are left alone, and previews paused by SmoothBoost resume when it is turned off. On Re:Anime’s home page, SmoothBoost detects and stops the hero’s autoplay interval, restores the slide that was showing, and keeps the manual slide controls available. The popup reports whether that pause was confirmed. The shortcut is **Option/Alt + Shift + S**; browser shortcut settings can change or reassign it.

### Build a ZIP package

Run this from the project folder to rebuild the ZIP:

```sh
python3 scripts/package_extension.py
```

The generated `dist/SmoothBoost-1.0.5.zip` contains the extension files at the archive root. Upload that ZIP through the Chrome Web Store Developer Dashboard if you want to publish it. For local Developer mode installation, use **Load unpacked** and select the project folder; Chrome does not load this ZIP directly from that button. Reload open tabs after installing or updating the extension.

## Try the included stress page

Open `test-page.html` in Chrome or Helium, then enable SmoothBoost. If the page is opened as a `file://` URL, enable **Allow access to file URLs** for SmoothBoost on the extensions page. The test page loads a public sample video from Google Cloud Storage.

## Project files

- `manifest.json` — extension metadata, permissions, scripts, and shortcut.
- `popup/` — toolbar controls and styling.
- `scripts/` — service worker, isolated content script, page-world performance hooks, and ZIP packager.
- `icons/` — extension icons.
- `test-page.html` — local performance stress page; excluded from the ZIP.
