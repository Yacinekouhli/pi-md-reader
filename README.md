# pi-md-reader

Read `.md` files inside [Pi](https://pi.dev) with a paged overlay reader: contents panel,
search with highlights, scrollbar, and reload — rendered through Pi's own Markdown renderer,
so headings, tables, code fences and LaTeX look exactly like they do in the transcript.

No leaving the harness, no `cat`, no scrolling back through tool output to re-read a plan.

```bash
pi install npm:pi-md-reader
```

```
/md                              fuzzy picker over the Markdown files in your project
/md TECHNO-10997-plan.md         open one file directly (Tab completes paths)
/md ~/notes/design.md            absolute and ~/ paths work
Ctrl+Alt+M                       open the picker from anywhere
```

## The reader

![The reader showing a Markdown plan](https://raw.githubusercontent.com/Yacinekouhli/pi-md-reader/main/test/assets/reader.png)

The path sits in the border, the section you are reading sits on the left, and the reading
position sits on the right. The file is watched, so if the agent edits it while you read,
the border shows `●` and `R` picks up the new content.

## Contents panel

![The contents panel walking between headings](https://raw.githubusercontent.com/Yacinekouhli/pi-md-reader/main/test/assets/contents.png)

`t` opens a panel of every heading, indented by level. `↑↓` walks the headings and scrolls
the document with you; `⏎` closes the panel. The breadcrumb above tracks where you are.

## Search

![Search highlighting every match](https://raw.githubusercontent.com/Yacinekouhli/pi-md-reader/main/test/assets/search.png)

`/` searches the rendered text with a live match counter, highlights every hit, and jumps to
the current one. `n` / `N` step through matches. `esc` clears the highlight before it closes
anything else.

## Picker

![The file picker filtering Markdown files](https://raw.githubusercontent.com/Yacinekouhli/pi-md-reader/main/test/assets/picker.png)

`/md` with no argument indexes the Markdown in your project — including nested directories
and both `.md` and `.markdown` — and filters fuzzily as you type.

## Keys

| Key | Action |
| --- | --- |
| `↑` `↓` `j` `k` | scroll one line |
| `⇟` `space` `⏎` | page down |
| `⇞` `b` | page up |
| `g` / `G` | jump to the top / bottom |
| `/` | search; `n` / `N` for the next / previous match |
| `t` | contents panel; `↑↓` walks headings, `⏎` closes |
| `R` | reload from disk |
| `q` / `esc` | close (`esc` unwinds search, then the panel, then the reader) |

The mouse wheel scrolls. Clicks are absorbed by the reader so nothing leaks into the
transcript behind it.

## Design notes

- **It renders with Pi's own renderer.** The reader instantiates a `Markdown` component from
  `@earendil-works/pi-tui` with `getMarkdownTheme()`, so it cannot drift from the transcript,
  and it follows the active theme when you switch themes.
- **It is a real pager.** The overlay is opaque, takes the full terminal, pins its height so
  scrolling never reflows the screen, and adapts down to a 58-column window without
  overflowing a single line.
- **Headings are lexed, not guessed.** Heading anchors are found with the same Markdown parser
  that renders the document, then planted in the source as zero-width characters. The contents
  panel, the breadcrumb and the search therefore agree with what is on screen — including
  setext headings, headings with inline code, and `#` inside a code fence.
- **Search offsets are terminal columns**, measured with `visibleWidth`, so highlighting lands
  on the right cells on lines containing CJK, emoji, or combining characters.
- **Long documents stay cheap.** Rendering is cached per width and invalidated on reload, so a
  400-line document redraws in one pass when the window is resized.

## Install

```bash
pi install npm:pi-md-reader        # from npm
pi install git:github.com/Yacinekouhli/pi-md-reader   # from git
```

## Development

```bash
pi --extension ./extensions/md-reader.ts    # try it without installing
```

### Tests

`test/run.sh` is an end-to-end test: it boots a real `pi` inside a PTY, sends keystrokes,
decodes the terminal with pyte, and asserts on the screen a user would actually see —
scrolling, the contents panel, search, reload-after-edit, the picker, empty/headingless/CRLF/
setext/Unicode documents, absolute paths, missing files, and a narrow-terminal pass that fails
if any line overflows. It writes `test/artifacts/e2e-summary.md`.

```bash
python3 -m venv /tmp/e2evenv && /tmp/e2evenv/bin/pip install pyte pillow
test/run.sh
```

`test/screenshot.py` regenerates the screenshots in this README from live sessions and checks
each rendered image against the terminal buffer before saving it, so a broken render fails
instead of being committed.

```bash
/tmp/e2evenv/bin/python test/screenshot.py
```

### Publishing

`test/preflight.sh` verifies the Pi package contract, that the entry point imports nothing
outside Node built-ins and the two host-provided peers, the exact tarball contents, and whether
the version is free on npm:

```bash
test/preflight.sh
npm publish --access public
```

There is no submission step for [pi.dev/packages](https://pi.dev/packages): the gallery indexes
npm packages carrying the `pi-package` keyword.

## License

MIT
