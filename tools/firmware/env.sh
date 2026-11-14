#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
base="${PYTHON:-python3}"
packages=()
for pair in python3:python3 git:git cmake:cmake ninja:ninja-build gperf:gperf dtc:device-tree-compiler \
	make:make gcc:gcc g++:g++ xz:xz-utils wget:wget; do
	command -v "${pair%%:*}" >/dev/null 2>&1 || packages+=("${pair#*:}")
done
if command -v "$base" >/dev/null 2>&1; then
	"$base" -c 'import venv, ensurepip' >/dev/null 2>&1 || packages+=(python3-venv)
else
	[[ "$base" == python3 ]] || {
		printf 'Error: requested Python interpreter not found: %s\n' "$base" >&2
		exit 1
	}
	packages+=(python3-venv)
fi
if ((${#packages[@]})); then
	if ! command -v apt-get >/dev/null 2>&1; then
		printf 'Error: install missing host prerequisites with your package manager: %s\n' "${packages[*]}" >&2
		exit 1
	fi
	printf 'Installing missing host prerequisites: %s (may require sudo).\n' "${packages[*]}"
	privilege=()
	if ((EUID != 0)); then
		command -v sudo >/dev/null 2>&1 || {
			printf 'Error: sudo is required to install host prerequisites.\n' >&2
			exit 1
		}
		privilege=(sudo)
	fi
	"${privilege[@]}" apt-get update
	"${privilege[@]}" apt-get install -y --no-install-recommends "${packages[@]}"
fi

workspace="$root"
while [[ ! -f "$workspace/.west/config" ]]; do
	if [[ "$workspace" == / ]]; then
		workspace="$(dirname "$root")"
		break
	fi
	workspace="$(dirname "$workspace")"
done

venv="${VENV_DIR:-$workspace/.venv}"
[[ "$venv" == /* ]] || venv="$PWD/$venv"
bin="$venv/bin"
[[ -d "$venv/Scripts" ]] && bin="$venv/Scripts"
if [[ ! -f "$venv/pyvenv.cfg" || ! -f "$bin/activate" ]]; then
	if [[ -e "$venv" ]]; then
		printf 'Error: %s exists but is not a Python venv; select another VENV_DIR.\n' "$venv" >&2
		exit 1
	fi
	if ! command -v "$base" >/dev/null 2>&1; then
		printf 'Error: Python interpreter not found: %s\n' "$base" >&2
		exit 1
	fi
	"$base" -m venv "$venv"
	[[ -d "$venv/Scripts" ]] && bin="$venv/Scripts"
fi

source "$bin/activate"
cd "$workspace"
unset ZEPHYR_BASE
python -m pip install --disable-pip-version-check --no-input west
if [[ ! -f "$workspace/.west/config" ]]; then
	printf 'Initializing Zephyr workspace at %s.\n' "$workspace"
	python -m west init -l "$root"
fi
# Keep dependencies aligned with the pinned manifest; west preserves local working-tree changes.
python -m west update --narrow -o=--depth=1
zephyr="$(python -m west list zephyr -f '{abspath}')"
espressif="$(python -m west list hal_espressif -f '{abspath}')"
for requirements in "$zephyr/scripts/requirements-base.txt" "$espressif/zephyr/requirements.txt"; do
	if [[ ! -f "$requirements" ]]; then
		printf 'Error: missing requirements after west update: %s\n' "$requirements" >&2
		exit 1
	fi
done
python -m pip install --disable-pip-version-check --no-input \
	-r "$zephyr/scripts/requirements-base.txt" -r "$espressif/zephyr/requirements.txt"
export ZEPHYR_BASE="$zephyr"
python -m west blobs fetch hal_espressif

sdk=""
for candidate in "${ZEPHYR_SDK_INSTALL_DIR:-}" "$HOME/zephyr-sdk-0.17.4" /opt/zephyr-sdk-0.17.4; do
	if [[ -f "$candidate/sdk_version" ]] && [[ "$(<"$candidate/sdk_version")" == 0.17.4 ]] &&
		[[ -x "$candidate/xtensa-espressif_esp32s3_zephyr-elf/bin/xtensa-espressif_esp32s3_zephyr-elf-gcc" ]]; then
		sdk="$candidate"
		break
	fi
done
if [[ -n "$sdk" ]]; then
	export ZEPHYR_SDK_INSTALL_DIR="$sdk"
else
	python -m west sdk install --version 0.17.4 --toolchains xtensa-espressif_esp32s3_zephyr-elf
fi
