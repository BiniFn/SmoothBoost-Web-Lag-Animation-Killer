#!/usr/bin/env python3
"""Build a clean ZIP of the files Chrome/Helium need to load SmoothBoost."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_FILES = (
    "manifest.json",
    "popup/popup.html",
    "popup/popup.css",
    "popup/popup.js",
    "scripts/background.js",
    "scripts/content.js",
    "scripts/page-hook.js",
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        help="ZIP destination (defaults to dist/SmoothBoost-<version>.zip)",
    )
    args = parser.parse_args()

    manifest = json.loads((PROJECT_ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    output = args.output or PROJECT_ROOT / "dist" / f"SmoothBoost-{version}.zip"
    if not output.is_absolute():
        output = PROJECT_ROOT / output

    missing = [name for name in PACKAGE_FILES if not (PROJECT_ROOT / name).is_file()]
    if missing:
        raise SystemExit("Cannot package; missing required files: " + ", ".join(missing))

    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        for name in PACKAGE_FILES:
            archive.write(PROJECT_ROOT / name, arcname=name)

    print(f"Created {output}")


if __name__ == "__main__":
    main()
