"""Repository paths shared by tests that verify cross-project contracts."""

from pathlib import Path

PYTHON_PROJECT = Path(__file__).resolve().parents[3]
REPO_ROOT = PYTHON_PROJECT.parents[1]
WEB_ROOT = PYTHON_PROJECT.parent / "web"
