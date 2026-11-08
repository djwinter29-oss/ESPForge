#!/usr/bin/env sh
# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

set -eu

case "${1:-}" in
    "")
        ;;
    -h|--help)
        printf 'Usage: ./tools/host/remove-local-branches.sh\n'
        printf 'Force-delete all local branches except main, including unmerged branches.\n'
        printf 'Deletion stops if any branch other than main is checked out in a worktree.\n'
        printf 'Remote branches are never changed.\n'
        exit 0
        ;;
    *)
        echo "Unknown argument: $1" >&2
        exit 2
        ;;
esac
if [ "$#" -gt 1 ]; then
    echo "No arguments expected; use --help for usage." >&2
    exit 2
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$REPO_ROOT"

git rev-parse --verify refs/heads/main >/dev/null
branches=$(git for-each-ref \
    --format='%(refname:short) %(worktreepath)' refs/heads/)

while read -r branch worktree; do
    [ -n "$branch" ] || continue
    [ "$branch" != main ] || continue
    if [ -n "$worktree" ]; then
        printf 'Cannot delete checked-out branch %s in worktree %s. Switch it to main or detach it first.\n' \
            "$branch" "$worktree" >&2
        exit 1
    fi
done <<EOF
$branches
EOF

count=0
while read -r branch worktree; do
    [ -n "$branch" ] || continue
    case "$branch" in
        main)
            continue
            ;;
    esac
    git branch --delete --force -- "$branch"
    count=$((count + 1))
done <<EOF
$branches
EOF

if [ "$count" -eq 0 ]; then
    echo "No local branches other than main."
fi
