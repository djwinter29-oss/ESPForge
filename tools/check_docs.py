"""Check local Markdown link targets without requesting external URLs."""

import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    failures: list[str] = []
    count = 0
    files = [root / "README.md", root / "CONTRIBUTING.md", root / "SECURITY.md"]
    files.extend((root / "docs").rglob("*.md"))
    files.extend((root / "host").rglob("README.md"))
    for file in files:
        for target in re.findall(r"\[[^\]]*\]\(([^)\s]+)\)", file.read_text()):
            url = urlsplit(target)
            if url.scheme or not url.path:
                continue
            count += 1
            if not (file.parent / unquote(url.path)).exists():
                failures.append(f"{file.relative_to(root)}: missing {target}")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print(f"PASS: {count} local documentation link targets")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
