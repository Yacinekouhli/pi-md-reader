#!/usr/bin/env python3
"""End-to-end test for the Markdown Reader extension.

Drives a real `pi` process inside a PTY, sends keystrokes, and asserts against the
rendered terminal screen decoded by pyte -- the same bytes a user would see.

Run:  /tmp/e2evenv/bin/python test/e2e.py
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from harness import PiSession  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
EXTENSION = REPO / "extensions" / "md-reader.ts"
FIXTURES = REPO / "test" / "fixtures"
PI = os.environ.get("PI_BIN", "pi")

ARTIFACT_DIR = REPO / "test" / "artifacts"
ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)

results: list[tuple[bool, str, str]] = []
steps = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((bool(condition), name, detail))
    mark = "PASS" if condition else "FAIL"
    print(f"  [{mark}] {name}" + (f"  -- {detail}" if detail and not condition else ""))


def launch(cols: int = 110, rows: int = 32) -> PiSession:
    """Start pi on the fixtures with the extension loaded.

    `--no-approve` and an isolated HOME keep this deterministic: without them pi can stop at a
    project-trust prompt, or load the developer's own global extensions and settings.
    """
    home = os.environ.get("PI_TEST_HOME") or tempfile.mkdtemp(prefix="pi-md-reader-home-")
    return PiSession(
        [
            PI,
            "--extension",
            str(EXTENSION),
            "--no-session",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
            "--no-approve",
        ],
        cols=cols,
        rows=rows,
        cwd=str(FIXTURES),
        env={"PI_OFFLINE": "1", "PI_SKIP_CHANGELOG": "1", "HOME": home},
    )


def wait_ready(session: PiSession) -> None:
    """Wait until pi has painted a settled screen and is accepting input.

    This is deliberately content-independent: at small heights the startup banner scrolls out of
    the visible viewport, and in CI there is no model provider, so probes for specific startup
    text are unreliable. Waiting for the screen to stop changing works at every size.
    """
    end = time.time() + 90
    previous = None
    stable_since = None
    while time.time() < end:
        session.pump(0.3)
        current = session.text()
        if current.strip():
            if current == previous:
                stable_since = stable_since or time.time()
                # Half a second of quiet means startup finished animating.
                if time.time() - stable_since > 0.6:
                    session.pump(0.4)
                    return
            else:
                stable_since = None
        previous = current
    raise TimeoutError(f"pi did not settle at startup\n--- screen ---\n{session.text()}")


def open_reader(session: PiSession, path: str, expect: str | None = None) -> None:
    """Type `/md <path>` and wait until the reader shows the document.

    `expect` is the heading the reader must display; it defaults to the file stem so the
    predicate never depends on which fixture the previous step left on screen.
    """
    needle = expect or Path(path).stem.replace("-", " ").replace("_", " ")
    session.type_text(f"/md {path} ")
    session.send("\r")
    session.wait_for(lambda s: needle in s.text(), timeout=25, description=f"reader for {path}")


def main() -> int:
    print("\n== Markdown Reader E2E ==")

    # -------------------------------------------------------------------
    print("\n[1] reader opens a file given as an argument")
    with launch() as session:
        wait_ready(session)
        open_reader(session, "HANDOVER.md", expect="Quarterly Handover")
        screen = session.text()
        check("document title in border", "Quarterly Handover" in screen)
        check("file name shown", "HANDOVER.md" in screen)
        check("markdown heading rendered", "Scope" in screen and "Numbers" in screen)
        check("table rendered as box drawing", "│" in screen and "┌" in screen, screen)
        check("frontmatter is not shown as body text", "owner: platform" not in screen, screen)

        session.send("G")  # jump to the end, where the fence lives
        session.pump(0.4)
        scrolled = session.text()
        check("code fence language preserved", "python" in scrolled, scrolled[-1200:])
        session.send("g")  # back to the top for the scrolling checks
        session.pump(0.4)

        # -------------------------------------------------------------------
        print("\n[2] scrolling moves the viewport")
        before = session.text()
        session.send("\x1b[B" * 6)  # down arrow x6
        session.pump(0.4)
        after = session.text()
        check("down arrow scrolls", before != after)
        check("position indicator advances", bool(re.search(r"\d+–\d+/\d+", after)), after)

        session.send("G")  # jump to bottom
        session.pump(0.4)
        bottom = session.text()
        check("G jumps to end", "Appendix" in bottom, bottom[-1200:])

        session.send("g")  # jump to top
        session.pump(0.4)
        top = session.text()
        check("g returns to top", "Quarterly Handover" in top and "Scope" in top)

        # -------------------------------------------------------------------
        print("\n[3] table of contents navigates headings")
        session.send("t")
        session.pump(0.4)
        toc = session.text()
        check("contents panel shows headings", "Timeline" in toc and "Appendix" in toc, toc[-1500:])
        check("contents header hint", "contents" in toc.lower(), toc[-600:])

        session.send("\x1b[B" * 4)  # walk down to later headings
        session.pump(0.4)
        walked = session.text()
        check("walking the contents scrolls the document", "Timeline" in walked or "Appendix" in walked, walked[-1500:])

        session.send("\r")
        session.pump(0.3)
        closed = session.text()
        check("enter closes the contents panel", "move ·" not in closed, closed[-600:])

        # -------------------------------------------------------------------
        print("\n[4] search finds and highlights")
        session.send("g")
        session.pump(0.3)
        session.send("/")
        session.pump(0.3)
        check("search prompt visible", "find" in session.text().lower())
        session.type_text("ZEBRA_UNIQUE_TOKEN")
        session.pump(0.3)
        check("match counter shows", "1/1" in session.text(), session.text()[-900:])
        session.send("\r")
        session.pump(0.4)
        found = session.text()
        check("search reveals the matching line", "ZEBRA_UNIQUE_TOKEN" in found, found[-1500:])
        check("search highlights use background", "\x1b[48" in "".join(session.screen.display) or "ZEBRA_UNIQUE_TOKEN" in found)

        session.send("n")
        session.pump(0.3)
        session.send("N")
        session.pump(0.3)
        check("n/N wrap safely on a single match", "ZEBRA_UNIQUE_TOKEN" in session.text())

        # case-insensitive, and correct on a line whose search target has no ASCII neighbours
        session.send("g")
        session.pump(0.3)
        session.send("/")
        session.pump(0.3)
        session.type_text("zebra_unique_token")
        session.pump(0.4)
        check("search is case-insensitive", "1/1" in session.text(), session.text()[-400:])
        session.send("\r")
        session.pump(0.4)
        check("case-insensitive search reveals the line", "ZEBRA_UNIQUE_TOKEN" in session.text())
        session.send("\x1b")
        session.pump(0.3)

        # -------------------------------------------------------------------
        print("\n[5] reload picks up on-disk edits")
        file = FIXTURES / "HANDOVER.md"
        original = file.read_text()
        try:
            file.write_text(original + "\n## Freshly Added Section\n\nEDITED_ON_DISK_MARKER\n")
            time.sleep(0.4)
            session.send("R")
            session.pump(0.6)
            session.send("G")
            session.pump(0.4)
            reloaded = session.text()
            check("reload shows new content", "EDITED_ON_DISK_MARKER" in reloaded, reloaded[-1500:])
            session.send("t")
            session.pump(0.4)
            check("reload refreshes the contents panel", "Freshly Added" in session.text(), session.text()[-1500:])
            session.send("\r")
            session.pump(0.2)
        finally:
            file.write_text(original)

        # -------------------------------------------------------------------
        print("\n[6] closing returns to the editor")
        session.send("q")
        session.pump(0.6)
        after_close = session.text()
        check("reader closes on q", "move ·" not in after_close and "scroll ·" not in after_close)
        session.type_text("the reader closed")
        session.pump(0.3)
        check("editor accepts input again", "the reader closed" in session.text())

    # -------------------------------------------------------------------
    print("\n[7] picker indexes the project")
    with launch(rows=28) as session:
        wait_ready(session)
        session.type_text("/md")
        session.send("\r")
        session.wait_for(lambda s: "Open Markdown file" in s.text(), timeout=25, description="picker")
        picker = session.text()
        check("picker lists markdown files", "HANDOVER.md" in picker, picker[-1500:])
        check("picker shows count", re.search(r"\d+/\d+", picker) is not None, picker[-400:])
        check("picker indexes nested directories", "nested" in picker, picker[-1500:])
        check("picker indexes .markdown extension", "other.markdown" in picker, picker[-1500:])

        session.type_text("notes")
        session.pump(0.6)
        filtered = session.text()
        check("filter narrows the list", "notes.md" in filtered and "HANDOVER.md" not in filtered, filtered[-1200:])

        session.send("\r")
        session.wait_for(lambda s: "Nested Notes" in s.text(), timeout=20, description="filtered file opens")
        check("enter opens the filtered file", "Nested Notes" in session.text())
        session.send("q")
        session.pump(0.4)

    # -------------------------------------------------------------------
    print("\n[8] narrow terminals do not break the layout")
    with launch(cols=58, rows=18) as session:
        wait_ready(session)
        open_reader(session, "HANDOVER.md", expect="Quarterly Handover")
        lines = session.screen.display
        over = [i for i, line in enumerate(lines) if len(line.rstrip()) > 58]
        check("no line exceeds the terminal width", not over, f"rows {over}")
        check("reader still shows the title", "Quarterly Handover" in session.text(), session.text())
        session.send("q")
        session.pump(0.3)

    # -------------------------------------------------------------------
    print("\n[9] a path outside the working directory, and a missing file")
    with launch() as session:
        wait_ready(session)
        target = ARTIFACT_DIR / "outside.md"
        target.write_text("# Outside File\n\nOpened by absolute path.\n")
        session.type_text(f"/md {target}")
        session.send("\r")
        session.wait_for(lambda s: "Outside File" in s.text(), timeout=20, description="absolute path reader")
        check("absolute path opens", "Opened by absolute path." in session.text())
        session.send("q")
        session.pump(0.3)
        session.type_text("/md does-not-exist.md")
        session.send("\r")
        session.pump(1.5)
        check("missing file reports an error", "No such file" in session.text(), session.text()[-600:])

    # -------------------------------------------------------------------
    print("\n[10] a line with wide characters searches correctly")
    with launch() as session:
        wait_ready(session)
        open_reader(session, "unicode.md", expect="Unicode")
        session.send("/")
        session.pump(0.3)
        session.type_text("é")
        session.pump(0.4)
        counter = re.search(r"(\d+)/(\d+)", session.text())
        check("wide-character search finds its matches", counter is not None and counter.group(1) != "0", session.text()[-400:])
        session.send("\r")
        session.pump(0.4)
        check("wide-character document still renders", "🎉" in session.text(), session.text()[-600:])
        session.send("q")
        session.pump(0.3)

    # -------------------------------------------------------------------
    print("\n[11] escape as an alternative close key")
    with launch() as session:
        wait_ready(session)
        open_reader(session, "other.markdown", expect="A file with the")
        check(".markdown extension opens", "A file with the" in session.text())
        session.send("\x1b")
        session.pump(0.7)
        check("escape closes the reader", "A file with the" not in session.text(), session.text()[-500:])

    # -------------------------------------------------------------------
    passed = sum(1 for ok, _, _ in results if ok)
    failed = [name for ok, name, _ in results if not ok]
    artifact = ARTIFACT_DIR / "e2e-summary.md"
    artifact.write_text(
        "# Markdown Reader E2E\n\n"
        f"- Extension: `{EXTENSION}`\n"
        f"- Fixtures: `{FIXTURES}`\n"
        f"- Result: {passed}/{len(results)} checks passed\n\n"
        + "\n".join(f"- {'PASS' if ok else 'FAIL'} — {name}" + (f" (`{detail[:200]}`)" if not ok and detail else "") for ok, name, detail in results)
        + "\n"
    )
    print(f"\n== {passed}/{len(results)} checks passed ==")
    print(f"artifact: {artifact}")
    if failed:
        print("failed: " + ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
