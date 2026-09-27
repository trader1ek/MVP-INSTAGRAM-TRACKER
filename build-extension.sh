#!/usr/bin/env bash
# Copies the tracker into the extension folder and builds a zip you can load or upload.
set -euo pipefail
cd "$(dirname "$0")"
cp ig-tracker.js extension/ig-tracker.js
VERSION=$(grep -o '"version": *"[^"]*"' extension/manifest.json | cut -d'"' -f4)
mkdir -p dist
rm -f "dist/mvp-instagram-tracker-extension-v$VERSION.zip"
(cd extension && zip -qr "../dist/mvp-instagram-tracker-extension-v$VERSION.zip" . -x '.*')
echo "Built dist/mvp-instagram-tracker-extension-v$VERSION.zip"
