# SmoothBoost

SmoothBoost is a Manifest V3 extension for Chrome and Helium. It reduces background page work while keeping visible media, controls, scrolling, and site navigation usable.

## Credit

The original SmoothBoost / Web Lag & Animation Killer project is by [BiniFn](https://github.com/BiniFn). This repository carries the project forward with Chrome and Helium packaging, safer site controls, diagnostics, and performance fixes.

## Install in Chrome or Helium

1. Download and extract the [latest SmoothBoost ZIP](https://github.com/BiniFn/SmoothBoost/releases/latest).
2. Open `chrome://extensions` in Chrome or Helium and turn on **Developer mode**.
3. Choose **Load unpacked** and select the extracted folder containing `manifest.json`.
4. Pin SmoothBoost from the extensions menu if you want quick access.
5. Reload tabs that were already open so the document-start scripts can take effect.

The popup's **Help & Bugs** tab also has installation instructions. For local development, **Load unpacked** can point directly to this project folder.

The popup checks GitHub for a newer stable release when it opens, then caches the result for up to six hours. If an update is available, choose **Download SmoothBoost** in **Help & Bugs**. Chrome and Helium cannot automatically replace a Developer mode unpacked extension from a ZIP; replace the files in the loaded folder, then click **Reload** on the extensions page. A Chrome Web Store installation can use the browser's built-in updater.

## Profiles and controls

- **Maximum** pauses muted looping autoplay previews only while they are outside the viewport, pauses supported offscreen carousels, pauses offscreen CSS animations, and reduces expensive backdrop blur while raising translucent panel opacity to preserve contrast. It leaves visible previews, player controls, normal scrolling, and page animation frames alone.
- On `reanime.to` home, Maximum stops the hero's automatic rotation after its first change, restores the slide that was showing, and keeps the site's manual controls available.
- **Balanced** leaves page visuals and media behavior unchanged.
- **Custom** controls apply to the current site. Optional controls include an adaptive 30 FPS limit that engages only after long animation frames and releases after the page recovers. It requires browser support for the Long Animation Frames API. **Skip rendering large feeds** can change scrollbar position on long pages.

SmoothBoost registers its scripts only on sites that are enabled. A site turned off in the popup is excluded after the current tab is reloaded. **Why is this page slow?** samples autoplay videos, blurred panels, looping animations, and recent long frames, then offers one-tap settings. Counts are observations, not a promise that SmoothBoost can fix a site's own problems.

In **Help & Bugs**, **Site looks broken?** turns SmoothBoost off for the current site and opens a prefilled GitHub issue. You can also submit an issue without changing the site setting, view existing issues, or read the original BiniFn credit.

Shortcut: **Option/Alt + Shift + S**. Browser shortcut settings can reassign it.

## Build the ZIP

From the project folder, run:

```sh
python3 scripts/package_extension.py
```

The generated `dist/SmoothBoost-1.0.8.zip` places `manifest.json` and the runtime files at the archive root. The test page and test suite are excluded. Chrome's **Load unpacked** expects an extracted directory; it does not load the ZIP directly.

## Benchmark

Open `test-page.html` in Chrome or Helium. If you use its local `file://` URL, allow SmoothBoost access to file URLs in the extension details. Use **Measure before** with SmoothBoost off, turn it on, then use **Measure after**. The page measures animation-frame delivery for a few seconds in the same tab; compare several runs because results vary with device load and power state. The page includes a sample video that requires internet access.

## Project files

- `manifest.json` — extension permissions, metadata, and shortcut.
- `scripts/background.js` — settings, site badges, and enabled-site script registration.
- `scripts/content.js` — isolated-world controls, offscreen observers, blur contrast, status, and diagnostics.
- `scripts/page-hook.js` — narrowly scoped main-world carousel and adaptive frame hooks.
- `data/site-rules.json` — generic carousel selectors and site-specific rules.
- `popup/` — controls, diagnostics, install help, and issue reporting.
- `test-page.html` and `tests/` — local benchmark page and automated checks; excluded from the ZIP.
