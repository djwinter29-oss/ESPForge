#!/usr/bin/env bash
# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong
set -euo pipefail

version=$(bash tools/firmware/release-version.sh "$RELEASE_TAG")
test "$(gh release view "$RELEASE_TAG" --json isDraft,isPrerelease \
  --jq '.isDraft == false and .isPrerelease == false')" = true
git fetch --no-tags origin "refs/tags/$RELEASE_TAG"
if [ -n "$SOURCE_SHA" ]; then
  test "$(git rev-parse 'FETCH_HEAD^{commit}')" = "$SOURCE_SHA"
fi
mkdir dist
gh release download "$RELEASE_TAG" --pattern "espforge-$version-py3-none-any.whl" \
  --pattern SHA256SUMS.txt --dir dist
cd dist
sha256sum --check SHA256SUMS.txt --ignore-missing
rm SHA256SUMS.txt
