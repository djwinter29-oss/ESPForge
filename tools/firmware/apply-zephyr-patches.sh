#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
zephyr="${1:?Usage: apply-zephyr-patches.sh ZEPHYR_CHECKOUT}"
expected="$(python -m west list zephyr -f '{abspath}')"
[[ "$(realpath "$zephyr")" == "$(realpath "$expected")" ]] || {
	printf 'Error: refusing to patch a Zephyr checkout outside this workspace.\n' >&2
	exit 1
}
[[ "$(git -C "$zephyr" rev-parse HEAD)" == 28af05ca658cbacf745fd5b099566311c58ccb1d ]] || {
	printf 'Error: ZephyrForge SD patches require Zephyr v4.3.2.\n' >&2
	exit 1
}
for patch in "$root"/patches/zephyr/v4.3.2/*.patch; do
	if git -C "$zephyr" apply --check "$patch" 2>/dev/null; then
		git -C "$zephyr" apply "$patch"
	elif git -C "$zephyr" apply --reverse --check "$patch" 2>/dev/null; then
		printf 'Zephyr patch already applied: %s\n' "$(basename "$patch")"
	else
		printf 'Error: Zephyr patch neither applies nor matches: %s\n' "$patch" >&2
		exit 1
	fi
done
