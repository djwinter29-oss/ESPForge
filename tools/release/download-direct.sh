#!/usr/bin/env bash
# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong
set -euo pipefail

version=$(bash tools/firmware/release-version.sh "$RELEASE_TAG")
is_stable=$(gh release view "$RELEASE_TAG" --json isDraft,isPrerelease \
  --jq '.isDraft == false and .isPrerelease == false')
if [ "$is_stable" != true ]; then
  printf 'Error: Pages requires a published, non-prerelease release.\n' >&2
  exit 1
fi
tag_sha=$(git rev-parse "refs/tags/$RELEASE_TAG^{commit}")
if [ -n "$SOURCE_SHA" ] && [ "$tag_sha" != "$SOURCE_SHA" ]; then
  printf 'Error: published tag does not match the release workflow source commit.\n' >&2
  exit 1
fi
mkdir incoming
gh release download "$RELEASE_TAG" --pattern "espforge-direct-v$version.zip" \
  --pattern SHA256SUMS.txt --dir incoming
cd incoming
awk -v filename="espforge-direct-v$version.zip" '$2 == filename { print }' SHA256SUMS.txt > direct.sha256
if [ "$(wc -l < direct.sha256)" -ne 1 ]; then
  printf 'Error: release checksum manifest must contain exactly one Direct archive entry.\n' >&2
  exit 1
fi
sha256sum --check direct.sha256
unzip "espforge-direct-v$version.zip" -d ../site
cd ..
test -f site/web/index.html
test -f site/web/favicon.svg
test -f site/web/js/app.mjs
VERSION="$version" TAG_SHA="$tag_sha" python - <<'PY'
import os
from pathlib import Path
from host.direct.server import verify_site
metadata = verify_site(Path("site/web"), os.environ["VERSION"])
assert metadata["commit"] == os.environ["TAG_SHA"], "Direct build identity differs from published tag"
PY
if ! grep -Fxq "ESPForge $version" site/RELEASE.txt ||
   ! grep -Fxq "Source: $tag_sha" site/RELEASE.txt; then
  printf 'Error: Direct archive version/source metadata does not match the published tag.\n' >&2
  exit 1
fi
cp site/LICENSE site/web/LICENSE
