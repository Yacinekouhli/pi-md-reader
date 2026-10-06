#!/usr/bin/env python3
"""Smoke-test the npm-installed package, as a user would get it.

Unlike test/e2e.py, which loads the extension by path, this installs from the registry and
launches pi without `--extension`, so discovery comes purely from the published package. That
catches packaging faults the path-based suite cannot: a bad `pi.extensions` manifest, missing
files in the tarball, or a peer import that does not resolve from Pi's npm directory.

This mutates the user's pi settings, so it restores them afterwards and is deliberately not part
of test/run.sh. Requires a real npm install, so it needs network access.

Usage:
    python3 test/smoke-installed.py            # latest from npm
    python3 test/smoke-installed.py --version 0.1.2
    PI_BIN=/path/to/pi python3 test/smoke-installed.py
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from harness import PiSession  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
FIXTURES = REPO / "test" / "fixtures"
PI = os.environ.get("PI_BIN", "pi")
AGENT_DIR = Path(os.environ.get("PI_AGENT_DIR", Path.home() / ".pi" / "agent"))
SETTINGS = AGENT_DIR / "settings.json"
PACKAGE = "pi-md-reader"


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, check=check)


def read_installed_version() -> str | None:
    manifest = AGENT_DIR / "npm" / "node_modules" / PACKAGE / "package.json"
    if not manifest.exists():
        return None
    return json.loads(manifest.read_text())["version"]


def without_local_checkout(packages: list) -> list:
    """Drop any entry that points at this working copy.

    Leaving it in place makes pi load the extension twice (once from the checkout, once from the
    registry), which registers `/md` twice and fails the run for the wrong reason.
    """
    kept = []
    for entry in packages:
        source = entry.get("source") if isinstance(entry, dict) else entry
        if isinstance(source, str) and "pi-md-reader" in source and "npm:" not in source:
            continue
        kept.append(entry)
    return kept


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", help="package version to install (default: latest)")
    parser.add_argument("--document", default="HANDOVER.md", help="fixture to open in the reader")
    parser.add_argument("--expect", default="Quarterly Handover", help="text the reader must show")
    args = parser.parse_args()

    if not FIXTURES.exists():
        print(f"fixtures not found: {FIXTURES}", file=sys.stderr)
        return 2

    source = f"npm:{PACKAGE}" + (f"@{args.version}" if args.version else "")
    backup = SETTINGS.read_text() if SETTINGS.exists() else None
    failures: list[str] = []
    def check(name: str, condition: bool, detail: str = "") -> None:
        print(f"  [{'PASS' if condition else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not condition else ""))
        if not condition:
            failures.append(name)

    try:
        print(f"\n== smoke test: {source} ==")

        print("\n[1] install from the registry")
        # Remove the local checkout entry first; otherwise the package loads twice and `/md` is
        # registered by both sources, which is a test artifact rather than a product fault.
        if backup is not None:
            settings = json.loads(backup)
            settings["packages"] = without_local_checkout(settings.get("packages", []))
            SETTINGS.write_text(json.dumps(settings, indent=2))
            print("  (temporarily removed the local checkout from pi settings)")

        result = run(PI, "install", source, check=False)
        if result.returncode != 0:
            print(result.stdout[-2000:], result.stderr[-2000:])
            check("install succeeds", False)
            return 1
        installed = read_installed_version()
        check("install succeeds", True)
        check("a version is installed", installed is not None, str(installed))
        if args.version:
            check(f"installed version is {args.version}", installed == args.version, str(installed))

        print("\n[2] launch without --extension (discovery must come from the package)")
        # PI_CODING_AGENT_DIR isolates this run's config (so the developer's own extensions and
        # settings stay out) while still reading the agent dir the install went into. Overriding
        # HOME instead would point pi at an empty directory and skip the package entirely.
        session = PiSession(
            [PI, "--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve"],
            cols=118,
            rows=34,
            cwd=str(FIXTURES),
            env={
                "PI_OFFLINE": "1",
                "PI_SKIP_CHANGELOG": "1",
                "PI_CODING_AGENT_DIR": str(AGENT_DIR),
            },
        )
        try:
            # Content-independent: at small heights the startup banner scrolls away.
            end = time.time() + 90
            previous = None
            stable = None
            while time.time() < end:
                session.pump(0.3)
                current = session.text()
                if current.strip():
                    if current == previous:
                        stable = stable or time.time()
                        if time.time() - stable > 0.6:
                            break
                    else:
                        stable = None
                previous = current
            startup = session.text()
            check("extension is loaded", "md-reader" in startup)
            check("no extension error", not ("md-reader" in startup and "rror" in startup), startup[-500:])

            print("\n[3] open a document with the installed reader")
            session.type_text(f"/md {args.document} ")
            session.send("\r")
            session.pump(2.5)
            check(f"reader opens {args.document}", args.expect in session.text(), session.text()[-600:])

            session.send("t")
            session.pump(0.8)
            check("contents panel opens", "▸" in session.text())

            session.send("\x1b")
            session.pump(0.4)
            session.send("q")
            session.pump(0.6)
            check("reader closes", "scroll ·" not in session.text())
        finally:
            session.close()
    finally:
        if backup is not None:
            SETTINGS.write_text(backup)
            print("\n(pi settings restored)")
        # Leave no registry-installed copy behind, so the local dev path keeps being used.
        shutil.rmtree(AGENT_DIR / "npm" / "node_modules" / PACKAGE, ignore_errors=True)

    print(f"\n== {'all checks passed' if not failures else str(len(failures)) + ' check(s) failed'} ==")
    if failures:
        print("failed: " + ", ".join(failures))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
