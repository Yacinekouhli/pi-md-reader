#!/usr/bin/env python3
"""Render a terminal screenshot PNG from a live pi session.

Boots pi in a PTY, drives it to a chosen screen, reads the character grid and the
24-bit colors out of pyte, and paints them with the real Menlo font. The result
is a faithful screenshot rather than a mockup, which is what the gallery preview
and the README need.

Usage:
    python3 test/screenshot.py            # writes test/assets/*.png
"""

from __future__ import annotations

import os
import pty
import select
import struct
import sys
import time
import fcntl
import termios
from pathlib import Path
from typing import Callable, Sequence

import pyte
from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
EXTENSION = REPO / "extensions" / "md-reader.ts"
FIXTURES = REPO / "test" / "fixtures"
ASSETS = REPO / "test" / "assets"

# Pi's dark theme tokens, read from the live theme so the image matches the product.
PI_DARK_BG = "#1b1c21"
DEFAULT_FG = "#dee0e1"

# xterm-256 palette for the symbolic names pyte reports for indexed colors.
ANSI_16 = {
    "black": "#2e3436", "red": "#cc0000", "green": "#4e9a06", "brown": "#c4a000",
    "blue": "#3465a4", "magenta": "#75507b", "cyan": "#06989a", "white": "#d3d7cf",
    "brightblack": "#555753", "brightred": "#ef2929", "brightgreen": "#8ae234",
    "brightbrown": "#fce94f", "brightblue": "#729fcf", "brightmagenta": "#ad7fa8",
    "brightcyan": "#34e2e2", "brightwhite": "#eeeeec",
}
ANSI_256_CACHE: dict = {}


def ansi256_to_hex(index: str) -> str:
    """Resolve `ansi256:<n>` to a hex color using the standard 256-color palette."""
    cached = ANSI_256_CACHE.get(index)
    if cached:
        return cached
    n = int(index.split(":", 1)[1])
    if n < 16:
        hex_color = list(ANSI_16.values())[n]
    elif n < 232:
        n -= 16
        levels = [0, 95, 135, 175, 215, 255]
        r, g, b = levels[n // 36], levels[(n // 6) % 6], levels[n % 6]
        hex_color = f"#{r:02x}{g:02x}{b:02x}"
    else:
        v = 8 + (n - 232) * 10
        hex_color = f"#{v:02x}{v:02x}{v:02x}"
    ANSI_256_CACHE[index] = hex_color
    return hex_color


def resolve_color(value: str, fallback: str) -> str:
    if not value or value == "default":
        return fallback
    if value.startswith("#"):
        return value
    # pyte reports 24-bit colors as a bare six-digit hex string.
    if len(value) == 6 and all(c in "0123456789abcdefABCDEF" for c in value):
        return f"#{value}"
    if value.startswith("ansi256:"):
        return ansi256_to_hex(value)
    return ANSI_16.get(value.lower(), fallback)
FONT_REGULAR = "/System/Library/Fonts/Menlo.ttc"
FONT_BOLD = "/System/Library/Fonts/Menlo.ttc"
FONT_SIZE = 15
CELL_W = 9
LINE_H = 20
PADDING = 18


class TermShot:
    """A pi session driven in a PTY, with its screen available as a color grid."""

    def __init__(self, cols: int, rows: int, cwd: str):
        self.cols, self.rows = cols, rows
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        env = dict(os.environ)
        env.update({"TERM": "xterm-256color", "PI_OFFLINE": "1", "COLUMNS": str(cols), "LINES": str(rows)})
        env.pop("PI_TUI_WRITE_LOG", None)
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            os.execvpe(
                "pi",
                ["pi", "--extension", str(EXTENSION), "--no-session", "--no-skills", "--no-prompt-templates"],
                env,
            )
        self.pid, self.fd = pid, fd
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def pump(self, seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            readable, _, _ = select.select([self.fd], [], [], 0.05)
            if not readable:
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                break
            if not data:
                break
            self.stream.feed(data)

    def wait_for(self, predicate: Callable[["TermShot"], bool], timeout: float = 40.0) -> None:
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.3)
            if predicate(self):
                return
        raise TimeoutError("timed out waiting for the screen to settle")

    def send(self, text: str) -> None:
        os.write(self.fd, text.encode())

    def text(self) -> str:
        return "\n".join(line.rstrip() for line in self.screen.display)

    def close(self) -> None:
        try:
            os.kill(self.pid, 9)
            os.waitpid(self.pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass

    def render(self, path: Path) -> None:
        """Paint the current screen to a PNG, then verify the PNG matches the buffer."""
        base = ImageFont.truetype(FONT_REGULAR, FONT_SIZE)
        bold = ImageFont.truetype(FONT_BOLD, FONT_SIZE)
        width = self.cols * CELL_W + PADDING * 2
        height = self.rows * LINE_H + PADDING * 2
        image = Image.new("RGB", (width, height), PI_DARK_BG)
        draw = ImageDraw.Draw(image)

        for y in range(self.rows):
            for x in range(self.cols):
                cell = self.screen.buffer[y][x]
                px = PADDING + x * CELL_W
                py = PADDING + y * LINE_H

                # Paint background bands first: they carry meaning (search highlights,
                # the selected row in the contents panel) and are lost if we only draw text.
                cell_bg = resolve_color(cell.bg, "") if cell.bg != "default" else ""
                if cell.reverse:
                    cell_bg = resolve_color(cell.fg, DEFAULT_FG)
                if cell_bg:
                    draw.rectangle([px, py, px + CELL_W - 1, py + LINE_H - 1], fill=cell_bg)

                char = cell.data
                if not char or char == " ":
                    continue
                fg = resolve_color(cell.fg, DEFAULT_FG)
                if cell.reverse:
                    fg = PI_DARK_BG
                draw.text((px, py), char, font=bold if cell.bold else base, fill=fg)

        failures = self.verify(image)
        if failures:
            raise AssertionError(
                f"{path.name}: rendered image does not match the terminal buffer "
                f"({len(failures)} cells, first: {failures[0]})"
            )

        image.save(path)
        print(f"wrote {path}  ({width}x{height})")

    def verify(self, image: Image.Image) -> list[str]:
        """Check that every non-space cell has ink where the glyph was drawn.

        This is what makes the screenshots trustworthy as evidence: a blank, offset or
        mis-scaled render is caught instead of being committed as a plausible-looking PNG.
        """
        failures: list[str] = []
        for y in range(self.rows):
            for x in range(self.cols):
                char = self.screen.buffer[y][x].data
                if not char or char == " ":
                    continue
                px = PADDING + x * CELL_W
                py = PADDING + y * LINE_H
                region = image.crop((px, py, px + CELL_W, py + LINE_H))
                colors = set(region.getdata())
                # Ink means any colour other than the flat cell background.
                if len(colors) <= 1:
                    failures.append(f"({y},{x}) {char!r} drew nothing")
        return failures


def capture(
    name: str,
    cols: int,
    rows: int,
    cwd: str,
    script: Sequence[str | Callable[[TermShot], None]],
    expect: Sequence[str] = (),
    reject: Sequence[str] = (),
    settle: float = 1.2,
) -> None:
    """Drive pi to a screen, assert what is on it, then paint it.

    `expect` / `reject` guard the image against silently capturing the wrong screen:
    a screenshot is only useful if the text it shows is the text we meant to show.
    """
    shot = TermShot(cols, rows, cwd)
    try:
        shot.wait_for(lambda s: "CRITEO" in s.text() or "ctrl+o" in s.text(), timeout=60)
        shot.pump(1.2)
        for step in script:
            if callable(step):
                step(shot)
            else:
                shot.send(step)
            shot.pump(0.6)
        shot.pump(settle)

        text = shot.text()
        for needle in expect:
            if needle not in text:
                raise AssertionError(f"{name}: expected {needle!r} on screen\n{text}")
        for needle in reject:
            if needle in text:
                raise AssertionError(f"{name}: unexpected {needle!r} on screen\n{text}")
        (ASSETS / f"{name}.txt").write_text(text + "\n")
        shot.render(ASSETS / name)
    finally:
        shot.close()


def main() -> int:
    ASSETS.mkdir(parents=True, exist_ok=True)
    fixtures = str(FIXTURES)

    print("capturing reader.png")
    capture(
        "reader.png", 116, 34, fixtures,
        ["/md HANDOVER.md ", "\r"],
        expect=["╭─ HANDOVER.md", "Scope", "Numbers", "│ Metric", "↑↓ scroll"],
    )

    print("capturing contents.png")
    capture(
        "contents.png", 116, 34, fixtures,
        ["/md HANDOVER.md ", "\r", "t", "\x1b[B" * 4],
        expect=["▸   Timeline", "↑↓ move", "Quarterly Handover › Numbers"],
    )

    print("capturing search.png")
    capture(
        "search.png", 116, 34, fixtures,
        ["/md HANDOVER.md ", "\r", "/", "the", "\r", "n", "n", "n"],
        expect=["find the", "4/8", "Quarterly Handover"],
    )

    print("capturing picker.png")
    capture(
        "picker.png", 116, 30, fixtures,
        ["/md", "\r"],
        expect=["Open Markdown file", "HANDOVER.md", "nested", "↑↓ choose"],
    )

    print("capturing narrow.png")
    capture(
        "narrow.png", 64, 20, fixtures,
        ["/md HANDOVER.md ", "\r"],
        expect=["╭─ HANDOVER.md", "Scope"],
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
