/**
 * Markdown Reader
 *
 * Read `.md` files inside Pi, rendered the way Pi renders Markdown (same theme, same
 * syntax highlighting, same tables and LaTeX), in a paged overlay you can scroll.
 *
 *   /md                       fuzzy picker over the Markdown files in the project
 *   /md <path>                open a file directly (Tab completes paths)
 *   Ctrl+Alt+M                open the picker
 *
 * Reader keys:
 *   ↑↓ j k        scroll one line          g / G   jump to top / bottom
 *   ⇟ space ⏎     page down                ⇞ b     page up
 *   /             find, then n / N for next / previous
 *   t             contents, ↑↓ + ⏎ to jump
 *   R             reload from disk         q esc   close
 *
 * The header follows the section you are reading, the contents panel jumps between
 * headings, and the file is watched so `R` picks up edits made by the agent.
 */

import { type FSWatcher, existsSync, readdirSync, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
	getMarkdownTheme,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	Markdown,
	Marked,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	fuzzyFilter,
	getKeybindings,
	matchesKey,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Zero-width space, used to tuck an invisible heading anchor into rendered Markdown. */
const ZWSP = "\u200b";
const MARKER_RE = /\u200b(\d+)\u200b/g;
const MARKDOWN_EXT = [".md", ".markdown", ".mdx"];
const SKIP_DIRS = new Set([
	".git",
	".bfs",
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	"vendor",
	".venv",
	"venv",
	"__pycache__",
	".next",
	".cache",
	".gradle",
	".idea",
	".vscode",
]);
const MAX_INDEXED = 4000;
const INDEX_TTL_MS = 30_000;
/** Wider prose gets hard to read; extra terminal width becomes inner padding. */
const MAX_TEXT_WIDTH = 108;

// ---------------------------------------------------------------------------
// File index
// ---------------------------------------------------------------------------

interface MarkdownFile {
	/** Path as typed on the command line: relative to the working directory when inside it. */
	value: string;
	label: string;
	description: string;
	absolute: string;
}

interface FileIndex {
	cwd: string;
	at: number;
	files: MarkdownFile[];
}

let index: FileIndex | undefined;

function isMarkdown(name: string): boolean {
	const lower = name.toLowerCase();
	return MARKDOWN_EXT.some((ext) => lower.endsWith(ext));
}

function collectMarkdownFiles(root: string): MarkdownFile[] {
	const out: MarkdownFile[] = [];
	const walk = (dir: string, depth: number): void => {
		if (out.length >= MAX_INDEXED || depth > 8) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // Unreadable directory: not a reason to fail the picker.
		}
		for (const entry of entries) {
			if (out.length >= MAX_INDEXED) return;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
				walk(full, depth + 1);
				continue;
			}
			if (!entry.isFile() || !isMarkdown(entry.name)) continue;
			const rel = relative(root, full);
			out.push({
				value: rel,
				label: entry.name,
				description: dirname(rel) === "." ? "" : dirname(rel),
				absolute: full,
			});
		}
	};
	walk(root, 0);
	return out.sort((a, b) => a.value.localeCompare(b.value));
}

function markdownFiles(cwd: string): MarkdownFile[] {
	const now = Date.now();
	if (index && index.cwd === cwd && now - index.at < INDEX_TTL_MS) return index.files;
	index = { cwd, at: now, files: collectMarkdownFiles(cwd) };
	return index.files;
}

function expandPath(input: string, cwd: string): string {
	let path = input;
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
	return resolve(cwd, path);
}

/** Compact display path: relative to the working directory, `~`-shortened when outside it. */
function displayPath(absolute: string, cwd: string): string {
	const rel = relative(cwd, absolute);
	if (rel && !rel.startsWith("..")) return rel;
	const home = homedir();
	return absolute === home || absolute.startsWith(`${home}/`) ? `~${absolute.slice(home.length)}` : absolute;
}

function stripInlineMarkdown(text: string): string {
	return text
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/~~([^~]*)~~/g, "$1")
		.replace(/\*\*([^*]*)\*\*/g, "$1")
		.replace(/__([^_]*)__/g, "$1")
		.replace(/\*([^*]*)\*/g, "$1")
		.replace(/_([^_]*)_/g, "$1")
		.trim();
}

// ---------------------------------------------------------------------------
// Document preparation
// ---------------------------------------------------------------------------

interface Heading {
	level: number;
	text: string;
	/** Index of the invisible marker planted in the source. */
	anchor: number;
	/** Rendered line the heading starts on; -1 until rendered. */
	line: number;
}

interface PreparedDocument {
	/** Markdown source with invisible heading anchors, frontmatter removed. */
	source: string;
	headings: Heading[];
	title: string;
}

interface LexedToken {
	type: string;
	raw: string;
	depth?: number;
	text?: string;
}

function prepareDocument(raw: string, path: string): PreparedDocument {
	const { frontmatter, body } = parseFrontmatter<{ title?: unknown }>(raw);
	const tokens = new Marked().lexer(body) as LexedToken[];

	const headings: Heading[] = [];
	let source = "";
	for (const token of tokens) {
		if (token.type !== "heading") {
			source += token.raw;
			continue;
		}
		const anchor = headings.length;
		headings.push({
			level: token.depth ?? 1,
			text: stripInlineMarkdown(token.text ?? ""),
			anchor,
			line: -1,
		});
		const marker = `${ZWSP}${anchor}${ZWSP}`;
		const prefix = /^(#{1,6}[ \t]*)/.exec(token.raw);
		source += prefix ? `${prefix[0]}${marker}${token.raw.slice(prefix[0].length)}` : `${marker}${token.raw}`;
	}

	const declared = typeof frontmatter.title === "string" ? frontmatter.title : undefined;
	const firstHeading = headings.find((h) => h.level === 1) ?? headings[0];
	return {
		source,
		headings,
		title: declared ?? firstHeading?.text ?? basename(path),
	};
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function padTo(text: string, width: number): string {
	const visible = visibleWidth(text);
	if (visible === width) return text;
	if (visible > width) return truncateToWidth(text, width, "");
	return text + " ".repeat(width - visible);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/** Right-align `text` inside `width`, dropping it when it does not fit. */
function alignRight(text: string, width: number): string {
	const visible = visibleWidth(text);
	if (visible > width) return " ".repeat(width);
	return " ".repeat(width - visible) + text;
}

// ---------------------------------------------------------------------------
// Reader overlay
// ---------------------------------------------------------------------------

interface Match {
	line: number;
	start: number;
	length: number;
}

interface ReaderOptions {
	tui: TUI;
	theme: Theme;
	path: string;
	cwd: string;
	done: () => void;
}

class MarkdownReader implements Component, Focusable {
	/** Focusable: the overlay owns the keyboard while it is open. */
	focused = true;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly path: string;
	private readonly cwd: string;
	private readonly done: () => void;
	private readonly find: Input;

	private document: PreparedDocument = { source: "", headings: [], title: "" };
	private version = 0;
	private cacheKey = "";
	private lines: string[] = [];
	private plain: string[] = [];

	private scrollTop = 0;
	private tocOpen = false;
	private tocIndex = 0;
	private tocScroll = 0;

	private searchMode: "closed" | "input" | "active" = "closed";
	private matches: Match[] = [];
	private matchIndex = -1;
	private stale = false;
	private watcher: FSWatcher | undefined;

	constructor(options: ReaderOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.path = options.path;
		this.cwd = options.cwd;
		this.done = options.done;
		this.find = new Input({
			prompt: "find ",
			placeholder: "search this document",
			placeholderStyle: (text) => this.theme.fg("dim", text),
		});
		this.find.focused = true;

		this.load();
		try {
			this.watcher = watch(this.path, () => {
				this.stale = true;
				this.tui.requestRender();
			});
		} catch {
			// Watching is a convenience; a file we cannot watch still reads fine.
		}
	}

	// -- document ----------------------------------------------------------

	private load(): void {
		let raw: string;
		try {
			raw = readFileSync(this.path, "utf8");
		} catch (error) {
			raw = `# Cannot read this file\n\n\`${this.path}\`\n\n\`\`\`\n${String(error)}\n\`\`\`\n`;
		}
		this.document = prepareDocument(raw, this.path);
		this.version += 1;
		this.cacheKey = "";
		this.stale = false;
	}

	private reload(): void {
		this.load();
		this.recomputeMatches();
		this.tui.requestRender();
	}

	private ensureLines(textWidth: number): void {
		const key = `${this.version}:${textWidth}`;
		if (key === this.cacheKey && this.lines.length > 0) return;

		const rendered = new Markdown(this.document.source, 0, 0, getMarkdownTheme()).render(textWidth);
		const headings = this.document.headings.map((heading) => ({ ...heading, line: -1 }));
		const lines: string[] = [];
		const plain: string[] = [];

		for (let i = 0; i < rendered.length; i += 1) {
			let line = rendered[i] ?? "";
			for (const match of line.matchAll(MARKER_RE)) {
				const anchor = Number.parseInt(match[1] ?? "", 10);
				const heading = headings[anchor];
				if (heading) heading.line = i;
			}
			line = line.replace(MARKER_RE, "");
			lines.push(padTo(line, textWidth));
			plain.push(stripTerminalSequences(line));
		}

		this.document = { ...this.document, headings };
		this.lines = lines;
		this.plain = plain;
		this.cacheKey = key;
	}

	// -- search ------------------------------------------------------------

	/**
	 * Rebuild the match list. Offsets are terminal columns, computed from the plain text,
	 * so highlighting a line with wide characters still lands on the right cells.
	 */
	private recomputeMatches(): void {
		if (this.searchMode === "closed") {
			this.matches = [];
			this.matchIndex = -1;
			return;
		}
		const query = this.find.getValue().trim();
		if (!query) {
			this.matches = [];
			this.matchIndex = -1;
			return;
		}
		const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
		const matches: Match[] = [];
		for (let line = 0; line < this.plain.length; line += 1) {
			const text = this.plain[line] ?? "";
			for (const found of text.matchAll(pattern)) {
				const at = found.index ?? 0;
				matches.push({
					line,
					start: visibleWidth(text.slice(0, at)),
					length: Math.max(1, visibleWidth(found[0])),
				});
			}
		}
		this.matches = matches;
		this.matchIndex = matches.length > 0 ? 0 : -1;
		if (this.matchIndex >= 0) this.revealMatch(this.matchIndex);
	}

	private revealMatch(at: number): void {
		const match = this.matches[at];
		if (!match) return;
		const viewportHeight = this.viewportHeight();
		const target = match.line - Math.floor(viewportHeight / 2);
		this.scrollTop = clamp(target, 0, this.maxScroll(viewportHeight));
		this.matchIndex = at;
	}

	private stepMatch(direction: 1 | -1): void {
		if (this.matches.length === 0) return;
		const next = (this.matchIndex + direction + this.matches.length) % this.matches.length;
		this.revealMatch(next);
		this.tui.requestRender();
	}

	private openSearch(): void {
		this.searchMode = "input";
		this.find.setValue("");
		this.matches = [];
		this.matchIndex = -1;
		this.tui.requestRender();
	}

	private commitSearch(): void {
		const query = this.find.getValue().trim();
		this.recomputeMatches();
		this.searchMode = query ? "active" : "closed";
		this.tui.requestRender();
	}

	private closeSearch(): void {
		this.searchMode = "closed";
		this.matches = [];
		this.matchIndex = -1;
		this.tui.requestRender();
	}

	// -- geometry ----------------------------------------------------------

	private viewportHeight(): number {
		return Math.max(1, this.tui.terminal.rows - this.chromeRows());
	}

	/** Rows the reader spends on borders, identity, hints, and the search prompt. */
	private chromeRows(): number {
		return 4 + (this.searchMode === "closed" ? 0 : 1);
	}

	private maxScroll(viewportHeight: number): number {
		return Math.max(0, this.lines.length - viewportHeight);
	}

	private scrollBy(lines: number): void {
		const viewportHeight = this.viewportHeight();
		this.scrollTop = clamp(this.scrollTop + lines, 0, this.maxScroll(viewportHeight));
		this.tui.requestRender();
	}

	private scrollTo(line: number): void {
		const viewportHeight = this.viewportHeight();
		this.scrollTop = clamp(line, 0, this.maxScroll(viewportHeight));
		this.tui.requestRender();
	}

	private jumpToHeading(at: number): void {
		const heading = this.document.headings[at];
		if (!heading || heading.line < 0) return;
		this.scrollTo(Math.max(0, heading.line - 1));
	}

	private tocVisibleRows(): number {
		return Math.max(1, this.viewportHeight());
	}

	private syncTocScroll(): void {
		const visible = this.tocVisibleRows();
		if (this.tocIndex < this.tocScroll) this.tocScroll = this.tocIndex;
		else if (this.tocIndex >= this.tocScroll + visible) this.tocScroll = this.tocIndex - visible + 1;
		const max = Math.max(0, this.document.headings.length - visible);
		this.tocScroll = clamp(this.tocScroll, 0, max);
	}

	/** Breadcrumb of the heading that owns the current scroll position. */
	private breadcrumb(): string {
		let current: Heading | undefined;
		for (const heading of this.document.headings) {
			if (heading.line >= 0 && heading.line <= this.scrollTop + 1) current = heading;
			else if (heading.line > this.scrollTop + 1) break;
		}
		if (!current) return "";
		const chain: Heading[] = [current];
		let level = current.level;
		for (let i = this.document.headings.indexOf(current) - 1; i >= 0 && level > 1; i -= 1) {
			const candidate = this.document.headings[i];
			if (candidate && candidate.level < level) {
				chain.unshift(candidate);
				level = candidate.level;
			}
		}
		return chain.map((heading) => heading.text).join(" › ");
	}

	// -- input -------------------------------------------------------------

	handleInput(data: string): void {
		if (this.searchMode === "input") {
			if (matchesKey(data, "escape")) {
				this.closeSearch();
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return")) {
				this.commitSearch();
				return;
			}
			this.find.handleInput(data);
			this.recomputeMatches();
			this.tui.requestRender();
			return;
		}

		const kb = getKeybindings();
		const page = Math.max(1, this.viewportHeight() - 2);

		// Escape unwinds one layer at a time: an active highlight, then the contents
		// panel, and only the bare reader closes. `q` always closes.
		if (matchesKey(data, "escape")) {
			if (this.searchMode === "active") this.closeSearch();
			else if (this.tocOpen) this.tocOpen = false;
			else this.done();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "q")) {
			this.done();
			return;
		}
		if (this.tocOpen) {
			if (matchesKey(data, "t") || matchesKey(data, "enter") || matchesKey(data, "return")) {
				this.tocOpen = false;
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "up") || matchesKey(data, "k") || kb.matches(data, "tui.select.up")) {
				this.tocIndex = Math.max(0, this.tocIndex - 1);
				this.syncTocScroll();
				this.jumpToHeading(this.tocIndex);
				return;
			}
			if (matchesKey(data, "down") || matchesKey(data, "j") || kb.matches(data, "tui.select.down")) {
				this.tocIndex = Math.min(this.document.headings.length - 1, this.tocIndex + 1);
				this.syncTocScroll();
				this.jumpToHeading(this.tocIndex);
				return;
			}
			if (matchesKey(data, "/")) {
				this.openSearch();
				return;
			}
			if (matchesKey(data, "pageDown")) {
				this.tocIndex = Math.min(this.document.headings.length - 1, this.tocIndex + page);
				this.syncTocScroll();
				this.jumpToHeading(this.tocIndex);
				return;
			}
			if (matchesKey(data, "pageUp")) {
				this.tocIndex = Math.max(0, this.tocIndex - page);
				this.syncTocScroll();
				this.jumpToHeading(this.tocIndex);
				return;
			}
			return;
		}

		if (matchesKey(data, "up") || matchesKey(data, "k") || kb.matches(data, "tui.editor.cursorUp")) {
			this.scrollBy(-1);
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j") || kb.matches(data, "tui.editor.cursorDown")) {
			this.scrollBy(1);
			return;
		}
		if (matchesKey(data, "pageDown") || matchesKey(data, "space") || matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.scrollBy(page);
			return;
		}
		if (matchesKey(data, "pageUp") || matchesKey(data, "shift+space") || matchesKey(data, "b")) {
			this.scrollBy(-page);
			return;
		}
		if (matchesKey(data, "home") || matchesKey(data, "g")) {
			this.scrollTo(0);
			return;
		}
		if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
			this.scrollTo(this.maxScroll(this.viewportHeight()));
			return;
		}
		if (matchesKey(data, "t")) {
			this.tocOpen = true;
			this.tocIndex = this.nearestHeadingIndex();
			this.syncTocScroll();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "/")) {
			this.openSearch();
			return;
		}
		if (matchesKey(data, "n")) {
			this.stepMatch(1);
			return;
		}
		if (matchesKey(data, "shift+n")) {
			this.stepMatch(-1);
			return;
		}
		if (matchesKey(data, "shift+r")) {
			this.reload();
		}
	}

	/** Heading nearest at or above the current scroll position, for opening the contents panel. */
	private nearestHeadingIndex(): number {
		let found = 0;
		for (let i = 0; i < this.document.headings.length; i += 1) {
			const heading = this.document.headings[i];
			if (heading && heading.line >= 0 && heading.line <= this.scrollTop + 1) found = i;
		}
		return found;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			const delta = event.wheelDelta ?? 0;
			if (delta !== 0) this.scrollBy(delta);
			return { handled: true, render: delta !== 0 };
		}
		// The reader is modal: absorb clicks so the transcript behind it does not react.
		return { handled: true, render: false };
	}

	// -- render ------------------------------------------------------------

	render(width: number): string[] {
		const theme = this.theme;
		const border = (text: string) => theme.fg("border", text);
		// The reader owns the whole screen: an opaque page reads like a pager and
		// never lets the transcript behind it show through.
		const height = Math.max(6, this.tui.terminal.rows);
		const inner = Math.max(12, width - 2);
		const viewportHeight = this.viewportHeight();

		const tocWidth = this.tocOpen ? clamp(Math.round(inner * 0.34), 16, 44) : 0;
		const tocGap = this.tocOpen ? 1 : 0;
		const bodyWidth = inner - tocWidth - tocGap;
		const availableText = Math.max(8, bodyWidth - 3);
		const textWidth = Math.min(availableText, MAX_TEXT_WIDTH);
		const slack = Math.max(0, availableText - textWidth);
		const leftPadding = 1 + Math.floor(slack / 2);
		const rightPadding = Math.max(0, slack - Math.floor(slack / 2));

		this.ensureLines(textWidth);
		const maxScroll = this.maxScroll(viewportHeight);
		this.scrollTop = clamp(this.scrollTop, 0, maxScroll);
		const matchesByLine = new Map<number, Match[]>();
		for (const match of this.matches) {
			const list = matchesByLine.get(match.line);
			if (list) list.push(match);
			else matchesByLine.set(match.line, [match]);
		}

		const rows: string[] = [];

		// Top border carries the file path; the identity row carries the reading context.
		const pathLabel = ` ${displayPath(this.path, this.cwd)} `;
		const pathWidth = visibleWidth(pathLabel);
		if (pathWidth + 4 <= inner) {
			const rule = inner - pathWidth - 2;
			rows.push(
				border("╭─") + theme.fg("accent", theme.bold(pathLabel)) + border(`${this.stale ? "●" : "─"}${"─".repeat(Math.max(0, rule - 1))}╮`),
			);
		} else {
			rows.push(border(`╭${theme.fg("accent", theme.bold(truncateToWidth(pathLabel, inner - 2, "…")))}${border("╮")}`));
		}

		// Identity row: current section on the left, document facts on the right.
		const section = this.breadcrumb() || this.document.title;
		const sectionText = ` ${theme.fg("text", section)}`;
		const facts: string[] = [];
		if (this.document.headings.length > 0) {
			facts.push(`${this.document.headings.length} section${this.document.headings.length === 1 ? "" : "s"}`);
		}
		if (this.stale) facts.push("changed on disk · R");
		const factsText = facts.length > 0 ? theme.fg("dim", `${facts.join(" · ")} `) : "";
		const identity =
			visibleWidth(sectionText) + visibleWidth(factsText) <= inner
				? sectionText +
					alignRight(factsText, inner - visibleWidth(sectionText))
				: truncateToWidth(sectionText, inner, "…");
		rows.push(`${border("│")}${padTo(identity, inner)}${border("│")}`);

		if (this.searchMode !== "closed") {
			const count =
				this.matches.length > 0
					? `${this.matchIndex + 1}/${this.matches.length} `
					: this.find.getValue().trim()
						? "no match "
						: "";
			const countText = count ? theme.fg(this.matches.length > 0 ? "accent" : "warning", count) : "";
			const inputWidth = Math.max(4, inner - visibleWidth(countText) - 1);
			const inputLine = truncateToWidth(this.find.render(inputWidth)[0] ?? "", inputWidth, "");
			rows.push(
				`${border("│")}${padTo(inputLine, inputWidth)}${alignRight(countText, inner - inputWidth - 1)} ${border("│")}`,
			);
		}

		// Body. Keep the contents selection in view before laying out the rows it fills.
		if (this.tocOpen) this.syncTocScroll();
		const scrollbar = this.scrollbarCells(viewportHeight, maxScroll);
		const bodyRows: string[] = [];
		for (let offset = 0; offset < viewportHeight; offset += 1) {
			const lineIndex = this.scrollTop + offset;
			const source = this.lines[lineIndex];
			const content =
				source === undefined
					? " ".repeat(textWidth)
					: this.highlight(source, matchesByLine.get(lineIndex), textWidth);
			const left = " ".repeat(leftPadding);
			const right = " ".repeat(rightPadding);
			let body = `${left}${content}${right}${scrollbar[offset] ?? " "}`;
			if (this.tocOpen) {
				const tocText = this.tocLine(offset, tocWidth);
				body = `${tocText}${border("│")}${body}`;
			}
			bodyRows.push(body);
		}

		for (const body of bodyRows) {
			rows.push(`${border("│")}${padTo(body, inner)}${border("│")}`);
		}

		// Hints, with the reading position on the right.
		const position =
			this.lines.length === 0
				? "empty"
				: `${this.scrollTop + 1}–${Math.min(this.lines.length, this.scrollTop + viewportHeight)}/${this.lines.length}`;
		const percent = maxScroll > 0 ? `${Math.round((this.scrollTop / maxScroll) * 100)}%  ` : "";
		const positionText = theme.fg("dim", `${percent}${position} `);
		const hints = this.tocOpen
			? "↑↓ move · ⏎ close contents · / find · q quit"
			: "↑↓ scroll · ⇟/space page · g/G ends · / find · t contents · R reload · q quit";
		const hintText = theme.fg("dim", ` ${hints}`);
		const hintRoom = inner - visibleWidth(positionText);
		const hintLine =
			visibleWidth(hintText) <= hintRoom
				? padTo(hintText, hintRoom) + positionText
				: alignRight(positionText, inner);
		rows.push(`${border("│")}${padTo(hintLine, inner)}${border("│")}`);
		rows.push(border(`╰${"─".repeat(inner)}╯`));

		// Pin the height to the terminal so the reader stays opaque.
		while (rows.length < height) {
			rows.splice(rows.length - 1, 0, `${border("│")}${" ".repeat(inner)}${border("│")}`);
		}
		return rows.slice(0, height);
	}

	private tocLine(offset: number, tocWidth: number): string {
		const theme = this.theme;
		const index = this.tocScroll + offset;
		const heading = this.document.headings[index];
		if (!heading) return " ".repeat(tocWidth);
		const indent = " ".repeat(Math.max(0, heading.level - 1) * 2);
		const marker = index === this.tocIndex ? "▸ " : "  ";
		const text = truncateToWidth(`${indent}${heading.text}`, Math.max(1, tocWidth - 3), "…");
		const row = ` ${marker}${text}`;
		if (index === this.tocIndex) {
			return theme.bg("selectedBg", padTo(theme.fg("accent", row), tocWidth));
		}
		return padTo(theme.fg(heading.level <= 1 ? "text" : "muted", row), tocWidth);
	}

	private scrollbarCells(viewportHeight: number, maxScroll: number): string[] {
		if (maxScroll <= 0) return new Array<string>(viewportHeight).fill(" ");
		const theme = this.theme;
		const thumbHeight = Math.max(2, Math.min(viewportHeight, Math.round((viewportHeight * viewportHeight) / this.lines.length)));
		const travel = viewportHeight - thumbHeight;
		const thumbTop = maxScroll === 0 ? 0 : Math.round((this.scrollTop / maxScroll) * travel);
		const cells: string[] = [];
		for (let row = 0; row < viewportHeight; row += 1) {
			cells.push(
				row >= thumbTop && row < thumbTop + thumbHeight
					? theme.fg("scrollbarThumb", "┃")
					: theme.fg("scrollbarTrack", "│"),
			);
		}
		return cells;
	}

	/** Overlay search highlights on one rendered line. */
	private highlight(line: string, matches: Match[] | undefined, textWidth: number): string {
		if (!matches || matches.length === 0) return padTo(line, textWidth);
		const theme = this.theme;
		let out = "";
		let cursor = 0;
		for (const match of matches) {
			if (match.start < cursor) continue;
			const before = sliceByColumn(line, cursor, match.start - cursor, true);
			const hit = sliceByColumn(line, match.start, match.length, true);
			const isCurrent = this.matches[this.matchIndex] === match;
			out += before;
			out += theme.style(hit, isCurrent ? { bg: "searchMatchBg", underline: true } : { bg: "searchMatchBg" });
			cursor = match.start + match.length;
		}
		out += sliceByColumn(line, cursor, Math.max(0, textWidth - cursor), true);
		return padTo(out, textWidth);
	}

	invalidate(): void {
		this.cacheKey = "";
	}

	dispose(): void {
		this.watcher?.close();
		this.watcher = undefined;
	}
}

// ---------------------------------------------------------------------------
// File picker overlay
// ---------------------------------------------------------------------------

interface PickerOptions {
	tui: TUI;
	theme: Theme;
	files: MarkdownFile[];
	done: (file: MarkdownFile | undefined) => void;
}

class MarkdownPicker implements Component, Focusable {
	focused = true;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly files: MarkdownFile[];
	private readonly done: (file: MarkdownFile | undefined) => void;
	private readonly filter: Input;
	private filtered: MarkdownFile[] = [];
	private selected = 0;
	private offset = 0;

	constructor(options: PickerOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.files = options.files;
		this.done = options.done;
		this.filter = new Input({
			prompt: "filter ",
			placeholder: "type to narrow the list",
			placeholderStyle: (text) => this.theme.fg("dim", text),
		});
		this.filter.focused = true;
		this.apply();
	}

	private apply(): void {
		const query = this.filter.getValue().trim();
		this.filtered = query
			? fuzzyFilter(this.files, query, (file) => `${file.value} ${file.label}`)
			: this.files.slice();
		this.selected = 0;
		this.offset = 0;
		this.tui.requestRender();
	}

	private visibleRows(): number {
		return Math.max(1, this.height() - 5);
	}

	private height(): number {
		return Math.min(Math.max(8, this.tui.terminal.rows - 6), 22);
	}

	handleInput(data: string): void {
		const page = Math.max(1, this.visibleRows() - 2);
		if (matchesKey(data, "escape")) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.done(this.filtered[this.selected]);
			return;
		}
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.ensureVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = Math.min(this.filtered.length - 1, this.selected + 1);
			this.ensureVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.selected = Math.min(this.filtered.length - 1, this.selected + page);
			this.ensureVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.selected = Math.max(0, this.selected - page);
			this.ensureVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "tab")) {
			this.selected = this.filtered.length === 0 ? 0 : (this.selected + 1) % this.filtered.length;
			this.ensureVisible();
			this.tui.requestRender();
			return;
		}
		this.filter.handleInput(data);
		this.apply();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			const delta = event.wheelDelta ?? 0;
			if (delta === 0) return { handled: true, render: false };
			this.selected = clamp(this.selected + delta, 0, Math.max(0, this.filtered.length - 1));
			this.ensureVisible();
			return { handled: true, render: true };
		}
		return { handled: true, render: false };
	}

	private ensureVisible(): void {
		const visible = this.visibleRows();
		if (this.selected < this.offset) this.offset = this.selected;
		else if (this.selected >= this.offset + visible) this.offset = this.selected - visible + 1;
		this.offset = clamp(this.offset, 0, Math.max(0, this.filtered.length - visible));
	}

	render(width: number): string[] {
		const theme = this.theme;
		const border = (text: string) => theme.fg("border", text);
		const height = this.height();
		const inner = Math.max(12, width - 2);
		const visible = this.visibleRows();
		const rows: string[] = [];

		// Top border, with the picker title tucked into it.
		const title = " Open Markdown file ";
		const titleWidth = visibleWidth(title);
		const rule = Math.max(0, inner - titleWidth - 2);
		rows.push(border("╭─") + theme.fg("accent", theme.bold(title)) + border(`${ "─".repeat(rule)}╮`));
		const countText = theme.fg("dim", `${this.filtered.length}/${this.files.length} `);
		const inputWidth = Math.max(4, inner - visibleWidth(countText) - 1);
		const inputLine = truncateToWidth(this.filter.render(inputWidth)[0] ?? "", inputWidth, "");
		rows.push(`${border("│")}${padTo(inputLine, inputWidth)}${alignRight(countText, inner - inputWidth - 1)} ${border("│")}`);

		if (this.filtered.length === 0) {
			rows.push(`${border("│")}${padTo(theme.fg("warning", " No Markdown file matches the filter"), inner)}${border("│")}`);
		}
		for (let offset = 0; offset < visible; offset += 1) {
			const index = this.offset + offset;
			const file = this.filtered[index];
			if (!file) {
				rows.push(`${border("│")}${" ".repeat(inner)}${border("│")}`);
				continue;
			}
			const isSelected = index === this.selected;
			const name = `${isSelected ? "▸ " : "  "}${file.label}`;
			const description = file.description ? theme.fg("dim", `  ${file.description}`) : "";
			const nameWidth = Math.min(visibleWidth(name), Math.max(8, Math.floor(inner * 0.55)));
			const line = `${truncateToWidth(name, nameWidth, "…")}${" ".repeat(Math.max(1, nameWidth - visibleWidth(name)))}${truncateToWidth(description, Math.max(0, inner - nameWidth - 2), "…")}`;
			const styled = isSelected ? theme.bg("selectedBg", theme.fg("accent", padTo(line, inner))) : padTo(theme.fg("text", line), inner);
			rows.push(`${border("│")}${styled}${border("│")}`);
		}
		rows.push(
			`${border("│")}${padTo(theme.fg("dim", " ↑↓ choose · type to filter · ⏎ open · esc cancel"), inner)}${border("│")}`,
		);
		rows.push(border(`╰${"─".repeat(inner)}╯`));

		while (rows.length < height) rows.splice(rows.length - 1, 0, `${border("│")}${" ".repeat(inner)}${border("│")}`);
		return rows.slice(0, height);
	}

	invalidate(): void {}
	dispose(): void {}
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function unquote(args: string): string {
	const trimmed = args.trim();
	const quoted = /^"([^"]*)"$/.exec(trimmed) ?? /^'([^']*)'$/.exec(trimmed);
	return quoted?.[1] ?? trimmed;
}

async function pickFile(ctx: ExtensionContext, files: MarkdownFile[]): Promise<MarkdownFile | undefined> {
	if (ctx.mode !== "tui") return Promise.resolve(files[0]);
	return ctx.ui.custom<MarkdownFile | undefined>(
		(tui, theme, _keybindings, done) => new MarkdownPicker({ tui, theme, files, done }),
		{ overlay: true, overlayOptions: { width: "72%", minWidth: 40, anchor: "center" } },
	);
}

async function openReader(ctx: ExtensionCommandContext, absolute: string): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("The Markdown reader needs interactive mode; /md opens a pager overlay.", "warning");
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new MarkdownReader({ tui, theme, path: absolute, cwd: ctx.cwd, done }),
		{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" } },
	);
}

async function openFromArgs(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const requested = unquote(args);
	if (requested) {
		const absolute = expandPath(requested, ctx.cwd);
		if (!existsSync(absolute)) {
			ctx.ui.notify(`No such file: ${absolute}`, "error");
			return;
		}
		await openReader(ctx, absolute);
		return;
	}

	const files = markdownFiles(ctx.cwd);
	if (files.length === 0) {
		ctx.ui.notify(`No Markdown file found under ${ctx.cwd}`, "warning");
		return;
	}
	const picked = await pickFile(ctx, files);
	if (picked) await openReader(ctx, picked.absolute);
}

export default function mdReaderExtension(pi: ExtensionAPI): void {
	pi.registerCommand("md", {
		description: "Read a Markdown file in a pager (usage: /md [path])",
		getArgumentCompletions: (prefix) => {
			// A trailing space means the user is done typing the path; a prefix that
			// already names a file needs no completion. Returning null in both cases
			// keeps the completion menu from swallowing the submit key.
			if (/^\s*$/.test(prefix) || /\s$/.test(prefix)) return null;
			const query = unquote(prefix);
			const files = markdownFiles(process.cwd());
			if (files.some((file) => file.value === query)) return null;
			const matches = fuzzyFilter(files, query, (file) => `${file.value} ${file.label}`);
			if (matches.length === 0) return null;
			return matches.slice(0, 30).map((file) => ({
				value: file.value,
				label: file.label,
				description: file.description,
			}));
		},
		handler: async (args, ctx) => openFromArgs(args, ctx),
	});

	pi.registerShortcut("ctrl+alt+m", {
		description: "Open a Markdown file in the reader",
		handler: async (ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The Markdown picker needs interactive mode", "warning");
				return;
			}
			const files = markdownFiles(ctx.cwd);
			if (files.length === 0) {
				ctx.ui.notify(`No Markdown file found under ${ctx.cwd}`, "warning");
				return;
			}
			const picked = await pickFile(ctx, files);
			if (picked) await openReader(ctx as ExtensionCommandContext, picked.absolute);
		},
	});
}
