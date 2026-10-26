/**
 * The scripts the built-in browser runs inside a page. They run there as written, so they are plain JavaScript in
 * strings.
 */
/**
 * The page outline Pi reads: headings, text, and every control with a ref (`[e12]`) that click, type, select, and
 * hover take until the next snapshot. Refs are kept in the page itself, as weak references, so a page that changed
 * underneath still finds the controls it has. Elements that only look clickable (a `cursor: pointer` div with a
 * script's listener) count as controls too: apps are full of them.
 */
export const SNAPSHOT_SCRIPT = String.raw`(() => {
	const MAX = 16000;
	const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "BR", "WBR"]);
	const ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "switch", "option", "combobox", "textbox", "searchbox", "slider", "spinbutton", "treeitem", "listbox"]);
	const INPUTS = { button: "button", submit: "button", reset: "button", image: "button", file: "button", color: "button", checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox" };
	const LANDMARKS = { HEADER: "header", NAV: "nav", MAIN: "main", ASIDE: "aside", FOOTER: "footer", FORM: "form", DIALOG: "dialog", TABLE: "table" };
	const styles = new Map();
	const style = (el) => { let s = styles.get(el); if (!s) { s = getComputedStyle(el); styles.set(el, s); } return s; };
	const clip = (text, max) => { const flat = String(text ?? "").replace(/\s+/g, " ").trim(); return flat.length > max ? flat.slice(0, max - 1) + "…" : flat; };
	const shown = (el) => { const s = style(el); if (s.display === "contents") return true; return s.display !== "none" && s.visibility !== "hidden" && s.visibility !== "collapse" && el.getClientRects().length > 0; };
	const up = (el) => el.parentElement ?? (el.parentNode instanceof ShadowRoot ? el.parentNode.host : null);
	const roleOf = (el) => {
		const explicit = el.getAttribute("role");
		if (explicit) return explicit.trim().split(/\s+/)[0];
		const tag = el.tagName;
		if (tag === "A") return el.hasAttribute("href") ? "link" : null;
		if (tag === "BUTTON" || tag === "SUMMARY") return "button";
		if (tag === "SELECT") return el.multiple ? "listbox" : "combobox";
		if (tag === "TEXTAREA") return "textbox";
		if (tag === "INPUT") { const type = (el.getAttribute("type") || "text").toLowerCase(); return type === "hidden" ? null : (INPUTS[type] ?? "textbox"); }
		if (el.isContentEditable && (el.getAttribute("contenteditable") ?? "") !== "false" && !el.parentElement?.isContentEditable) return "textbox";
		if (/^H[1-6]$/.test(tag)) return "heading";
		return null;
	};
	const nameOf = (el) => {
		const aria = el.getAttribute("aria-label");
		if (aria && aria.trim()) return aria;
		const by = el.getAttribute("aria-labelledby");
		if (by) { const text = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? "").join(" "); if (text.trim()) return text; }
		if (el.labels && el.labels.length > 0) { const text = [...el.labels].map((label) => label.innerText).join(" "); if (text.trim()) return text; }
		if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type)) return el.value;
		if (el.tagName === "IMG") return el.alt;
		if (el.tagName !== "SELECT" && el.tagName !== "TEXTAREA" && el.tagName !== "INPUT") { const text = el.innerText; if (text && text.trim()) return text; }
		// A code field with no name of its own says what it is for (rakazo b89c3e71).
		return el.getAttribute("title") || el.getAttribute("placeholder") || el.querySelector?.("img[alt]")?.alt || (el.tagName === "INPUT" && el.autocomplete === "one-time-code" ? "One-time code" : "");
	};
	const clickable = new Set();
	const holders = new Set();
	const scan = (root) => {
		for (const el of root.querySelectorAll("*")) {
			if (el.shadowRoot) scan(el.shadowRoot);
			if (SKIP.has(el.tagName)) continue;
			const role = roleOf(el);
			let control = ROLES.has(role) || el.hasAttribute("onclick") || (el.hasAttribute("tabindex") && el.tabIndex >= 0 && el !== document.body);
			if (!control) { const parent = up(el); control = style(el).cursor === "pointer" && (!parent || style(parent).cursor !== "pointer"); }
			if (!control || !shown(el)) continue;
			clickable.add(el);
			for (let parent = up(el); parent && !holders.has(parent); parent = up(parent)) holders.add(parent);
		}
	};
	scan(document);
	const refs = new Map();
	window.__piPocketRefs = refs;
	let count = 0;
	let size = 0;
	let full = false;
	const lines = [];
	const add = (depth, text) => {
		if (full) return;
		const line = "  ".repeat(Math.min(depth, 12)) + text;
		if (size + line.length > MAX) { full = true; return; }
		size += line.length + 1;
		lines.push(line);
	};
	const control = (el, role) => {
		const ref = "e" + ++count;
		refs.set(ref, new WeakRef(el));
		let line = "[" + ref + "] " + (role ?? (style(el).cursor === "pointer" ? "clickable" : el.tagName.toLowerCase()));
		const name = clip(nameOf(el), 80);
		if (name) line += ' "' + name + '"';
		if (role === "link") { const href = el.getAttribute("href"); if (href && !href.startsWith("javascript:")) line += " -> " + clip(href, 90); }
		if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
			const type = el.tagName === "TEXTAREA" ? "textarea" : el.type;
			if (type === "checkbox" || type === "radio") { if (el.checked) line += " (checked)"; }
			else if (!["button", "submit", "reset", "image"].includes(type)) {
				if (type === "file") { const chosen = [...(el.files ?? [])].map((file) => file.name); if (chosen.length > 0) line += ' = "' + clip(chosen.join(", "), 80) + '"'; }
				else if (el.value) line += ' = "' + (type === "password" ? "••••" : clip(el.value, 60)) + '"';
				else if (el.placeholder && !name.includes(el.placeholder)) line += ' placeholder "' + clip(el.placeholder, 40) + '"';
				if (!["text", "textarea", "search"].includes(type)) line += " [" + type + "]";
			}
		}
		if (el.tagName === "SELECT") {
			const chosen = el.selectedOptions?.[0]?.text;
			if (chosen) line += ' = "' + clip(chosen, 40) + '"';
			const options = [...el.options].map((option) => clip(option.text, 30));
			line += " options: " + options.slice(0, 12).join(" | ") + (options.length > 12 ? " … (" + options.length + ")" : "");
		}
		const expanded = el.getAttribute("aria-expanded");
		if (expanded) line += expanded === "true" ? " (expanded)" : " (collapsed)";
		if (["aria-checked", "aria-selected", "aria-pressed"].some((attr) => el.getAttribute(attr) === "true")) line += " (selected)";
		if (el.disabled || el.getAttribute("aria-disabled") === "true") line += " (disabled)";
		return line;
	};
	const visit = (node, depth) => {
		if (full) return;
		if (node.nodeType === 3) { const text = clip(node.textContent, 200); if (text) add(depth, text); return; }
		if (node.nodeType !== 1) return;
		const el = node;
		if (SKIP.has(el.tagName)) return;
		if (el.tagName === "SLOT") { for (const child of el.assignedNodes({ flatten: true })) visit(child, depth); return; }
		const s = style(el);
		if (s.display === "none") return;
		if (!shown(el) && !holders.has(el)) return;
		const role = roleOf(el);
		if (clickable.has(el)) {
			add(depth, control(el, role));
			if (holders.has(el)) walk(el, depth + 1);
			return;
		}
		if (role === "heading") {
			const level = Number(el.getAttribute("aria-level") ?? el.tagName.slice(1)) || 2;
			add(depth, "#".repeat(Math.min(level, 6)) + " " + clip(el.innerText, 120));
			if (holders.has(el)) walk(el, depth + 1);
			return;
		}
		if (el.tagName === "IMG") { const alt = clip(el.alt, 80); if (alt) add(depth, 'img "' + alt + '"'); return; }
		if (el.tagName === "IFRAME") { add(depth, "iframe " + clip(el.src, 90)); return; }
		if (el.namespaceURI === "http://www.w3.org/2000/svg") { const title = clip(el.querySelector("title")?.textContent, 60); if (title) add(depth, 'svg "' + title + '"'); return; }
		if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") return;
		const landmark = LANDMARKS[el.tagName] ?? (el.getAttribute("role") === "dialog" ? "dialog" : undefined);
		if (landmark) {
			const label = el.getAttribute("aria-label");
			add(depth, landmark + (label ? ' "' + clip(label, 60) + '"' : "") + ":");
			walk(el, depth + 1);
			return;
		}
		if (!holders.has(el) && !s.display.startsWith("inline")) {
			const text = el.innerText ?? "";
			if (text.trim() === "") return;
			if (text.length <= 300 || el.children.length === 0) { add(depth, clip(text, 500)); return; }
		}
		walk(el, depth);
	};
	const walk = (el, depth) => { for (const child of (el.shadowRoot ?? el).childNodes) visit(child, depth); };
	if (document.body) walk(document.body, 0);
	// Every file input, under its own head: a styled upload button often hides its input, and the upload action needs one
	// (after rakazo 73a6b102). Those already listed keep their ref; open shadow roots count too.
	const files = [];
	const findFiles = (root) => { for (const el of root.querySelectorAll("*")) { if (el.shadowRoot) findFiles(el.shadowRoot); if (el.tagName === "INPUT" && el.type === "file") files.push(el); } };
	findFiles(document);
	// Listed: given a ref on a line the snapshot kept (one past its size limit has a ref but no line).
	const kept = new Set(lines.flatMap((line) => [...line.matchAll(/\[(e\d+)\]/g)].map((match) => match[1])));
	const listed = new Set([...refs].filter(([ref]) => kept.has(ref)).map(([, each]) => each.deref()));
	const fileLines = files.filter((el) => !listed.has(el) && !el.disabled).map((el) => {
		const ref = "e" + ++count;
		refs.set(ref, new WeakRef(el));
		const name = clip(nameOf(el), 60);
		const chosen = [...(el.files ?? [])].map((file) => file.name);
		return "[" + ref + "] file upload" + (name ? ' "' + name + '"' : "") + (el.multiple ? " (multiple)" : "") + (el.accept ? " accepts " + clip(el.accept, 60) : "") + (chosen.length > 0 ? ' = "' + clip(chosen.join(", "), 80) + '"' : "");
	});
	// Past the size limit too, as a page's last lines: at most 20.
	if (fileLines.length > 0) lines.push("File uploads (browser upload with this ref):", ...fileLines.slice(0, 20).map((line) => "  " + line));
	const scrolling = document.scrollingElement ?? document.documentElement;
	return { lines: lines.join("\n"), truncated: full, controls: count, scrollY: Math.round(scrollY), scrollHeight: Math.round(scrolling.scrollHeight), innerHeight: Math.round(innerHeight) };
})()`;

/**
 * Finds what Pi points at, scrolls it into view, and returns its middle in screen coordinates (CSS pixels of the
 * visual viewport, which mouse events use), with a short description and what covers it, if anything.
 */
export const LOCATE_SCRIPT = String.raw`(async (target) => {
	const clip = (text, max) => { const flat = String(text ?? "").replace(/\s+/g, " ").trim(); return flat.length > max ? flat.slice(0, max - 1) + "…" : flat; };
	// A password field's value is never part of what describes or finds it.
	const valueOf = (el) => (el.tagName === "INPUT" && el.type === "password" ? "" : el.value);
	const describe = (el) => {
		const name = clip(el.getAttribute("aria-label") || el.innerText || valueOf(el) || el.getAttribute("placeholder") || el.getAttribute("title") || "", 60);
		return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (name ? ' "' + name + '"' : "");
	};
	let el = null;
	if (target.ref) {
		el = window.__piPocketRefs?.get(target.ref)?.deref() ?? null;
		if (!el || !el.isConnected) throw new Error("No element " + target.ref + " on the page now: take a new snapshot.");
	} else if (target.selector) {
		el = document.querySelector(target.selector);
		if (!el) throw new Error("Nothing matches the selector " + target.selector + ".");
	} else if (target.label) {
		const want = target.label.replace(/\s+/g, " ").trim().toLowerCase();
		const text = (each) => (each.getAttribute("aria-label") || each.innerText || valueOf(each) || each.getAttribute("placeholder") || each.getAttribute("title") || "").replace(/\s+/g, " ").trim().toLowerCase();
		const seen = (each) => each.getClientRects().length > 0 && getComputedStyle(each).visibility !== "hidden";
		const controls = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, label, [role], [onclick], [tabindex]')].filter(seen);
		el = controls.find((each) => text(each) === want) ?? controls.find((each) => text(each).includes(want)) ?? null;
		if (!el) {
			const all = [...document.body.querySelectorAll("*")].filter((each) => each.children.length === 0 && seen(each) && text(each).includes(want));
			el = all.find((each) => text(each) === want) ?? all[0] ?? null;
		}
		if (!el) throw new Error('Nothing on the page says "' + target.label + '".');
		// A label stands for its field.
		if (el.tagName === "LABEL" && el.control) el = el.control;
	}
	el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
	await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
	const box = el.getBoundingClientRect();
	if (box.width === 0 && box.height === 0) throw new Error(describe(el) + " is not visible.");
	const x = box.left + box.width / 2;
	const y = box.top + box.height / 2;
	const hit = document.elementFromPoint(x, y);
	const covered = hit && hit !== el && !el.contains(hit) && !hit.contains(el) ? describe(hit) : undefined;
	const view = window.visualViewport;
	const scale = view?.scale ?? 1;
	return { x: (x - (view?.offsetLeft ?? 0)) * scale, y: (y - (view?.offsetTop ?? 0)) * scale, label: describe(el), covered, editable: el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) };
})`;

/** The focused element, inside web components too (their shadow roots keep their own focus). Put into scripts. */
const DEEP_ACTIVE = String.raw`const deepActive = () => {
		let el = document.activeElement;
		while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
		return el;
	};`;

/**
 * Selects what the focused field holds, so typed text replaces it: "selected", "empty", "none" (not a field), or "keys"
 * for a field a script cannot select (email, number), which the editor's select-all shortcut selects instead.
 */
export const SELECT_ALL_SCRIPT = String.raw`(() => {
	${DEEP_ACTIVE}
	const el = deepActive();
	// The field, for KEPT_VALUE_SCRIPT to read after the insert (the page may move focus on as the text goes in).
	window.__piPocketTyped = el ?? undefined;
	if (!el) return "none";
	if (["INPUT", "TEXTAREA"].includes(el.tagName)) {
		if (el.value === "") return "empty";
		try { el.select(); return "selected"; } catch { return "keys"; }
	}
	if (el.isContentEditable) {
		if ((el.textContent ?? "") === "") return "empty";
		const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
		return "selected";
	}
	return "none";
})()`;

/**
 * Notes the focused field before typing, when it is a one-character box in a row of two or more (one-box-per-digit
 * code fields, which move focus box to box as keys arrive). Returns whether it is.
 *
 * The row is the run of boxes next to it in page order among the fields one can see and type into, however they are
 * wrapped (a code split 3 + 3, each box in its own wrapper): another field ends it, and an invisible one (an SMS
 * autofill input under the boxes), a button, or a hidden input does not; neither do words between two boxes, unless one
 * can see and read them (a label parts two codes; a dash, an icon, or a label for screen readers only does not).
 */
export const TYPING_FIELD_SCRIPT = String.raw`(() => {
	${DEEP_ACTIVE}
	const el = deepActive();
	const texts = ["text", "tel", "password", "search", "number", "email", "url"];
	// A read-only or disabled input showing a mark that is no letter or digit (a dash between the halves of a code)
	// is part of no row: neither a box nor a field that ends one. An empty one is a box a widget unlocks in its turn.
	const mark = (each) => (each.readOnly || each.disabled) && each.value !== "" && !/^[\p{L}\p{N}]$/u.test(each.value);
	// A box one types a character into: not a checkbox, button, or file input that happens to have a maxlength.
	const box = (each) => each.tagName === "INPUT" && each.maxLength === 1 && texts.includes(each.type) && !mark(each);
	window.__piPocketTyping = undefined;
	// A field one types in that is no box: no widget moves focus on from it, so typing needs no moment's wait.
	if (!el || !box(el)) return { box: false, field: !!el && (el.tagName === "TEXTAREA" || el.isContentEditable || (el.tagName === "INPUT" && texts.includes(el.type))) };
	const seen = (each) => {
		const style = getComputedStyle(each);
		return each.getClientRects().length > 0 && style.visibility !== "hidden" && style.opacity !== "0";
	};
	const typed = (each) => (each.tagName !== "INPUT" || texts.includes(each.type)) && !mark(each);
	// Every field in page order, into open shadow roots (a widget may give each box one of its own).
	const all = (root) => [...root.querySelectorAll("*")].flatMap((each) => [
		...(["INPUT", "TEXTAREA", "SELECT"].includes(each.tagName) ? [each] : []),
		...(each.shadowRoot ? all(each.shadowRoot) : []),
	]);
	// Two codes, not one: words one can see between the boxes ("Backup code"; a label for screen readers only parts
	// nothing); else, unless marks sit between them ("-", "•": they join the halves of one code), boxes laid out apart,
	// the second more than half a box below the first (a divider this cannot read sits between: drawn by CSS, or in a
	// web component), which a code wrapped onto a second line is not.
	const apart = (one, two) => {
		const a = one.getBoundingClientRect();
		const b = two.getBoundingClientRect();
		const gap = Math.max(a.height, b.height) / 2;
		const below = b.top > a.bottom + gap || a.top > b.bottom + gap;
		if (one.getRootNode() !== two.getRootNode()) return below;
		const between = document.createRange();
		between.setStartAfter(one);
		between.setEndBefore(two);
		const top = between.commonAncestorContainer;
		// Not words one reads, though in the page: in a box of 1 px or less that cuts it off, clipped, invisible, or
		// decoration, in the text's own element or any around it up to the two boxes' common one (text moved off the
		// page, left: -9999px, has no place on it: see shown).
		const hidden = (node) => {
			for (let el = node.parentElement; el && el !== top; el = el.parentElement) {
				const style = getComputedStyle(el);
				if (style.display === "contents") continue;
				const box = el.getBoundingClientRect();
				// A box too small to show what it holds hides it only when it cuts it off (a wrapper of no height,
				// floats inside, shows them); a box placed off the page only when taken out of the flow to be there.
				if ((box.width <= 1 || box.height <= 1) && style.overflow !== "visible") return true;
				// Decoration, not words: an icon font's name for its glyph ("remove" drawn as a dash), or what is hidden
				// from screen readers.
				// The font it is drawn in: the first of the list (a site's text font lists "Segoe UI Symbol" as a fallback).
				if (/icon|symbol/i.test(style.fontFamily.split(",")[0]) || el.getAttribute("aria-hidden") === "true") return true;
				if (el.matches('mat-icon, [class*="material-icons"], [class*="material-symbols"]')) return true;
				if (/^rect\(0/.test(style.clip) || /inset\(50%/.test(style.clipPath)) return true;
			}
			// Invisible or transparent, the text's element or any around it: the browser's own test, on the nearest with a
			// box of its own (one with display: contents has none, and the test says it is not visible).
			let holder = node.parentElement;
			while (holder && getComputedStyle(holder).display === "contents") holder = holder.parentElement;
			return holder?.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false;
		};
		// The text between the two boxes only: from the first on, until past the second.
		const walker = document.createTreeWalker(top, NodeFilter.SHOW_TEXT);
		walker.currentNode = one;
		let words = "";
		for (let node = walker.nextNode(); node && between.intersectsNode(node); node = walker.nextNode()) {
			if (node.textContent.trim() === "") continue;
			const range = document.createRange();
			range.selectNodeContents(node);
			// On the page: not moved off any of its edges (left: -9999px, or right: -9999px on a right-to-left page).
			const page = document.documentElement;
			const shown = [...range.getClientRects()].some((rect) => rect.width > 1 && rect.height > 1 && rect.right + scrollX > 0 && rect.bottom + scrollY > 0 && rect.left + scrollX < page.scrollWidth && rect.top + scrollY < page.scrollHeight);
			if (shown && !hidden(node)) words += node.textContent.replace(/\s+/g, "");
			// Words are letters and digits; marks ("-", "•", "|") join boxes, however many. Two settle it.
			if ([...words].filter((each) => /[\p{L}\p{N}]/u.test(each)).length > 1) return true;
		}
		return words.length === 0 && below;
	};
	// The run of boxes next to a box in page order: another field, or words between, ends it.
	// The page's fields, once for typing's start (a row found again after a redraw reads the page afresh).
	const pageFields = all(document);
	const rowOf = (box0, everything = all(document)) => {
		const fields = everything.filter((each) => each === box0 || (typed(each) && seen(each)));
		const at = fields.indexOf(box0);
		let start = at;
		let end = at;
		while (start > 0 && box(fields[start - 1]) && !apart(fields[start - 1], fields[start])) start--;
		while (end < fields.length - 1 && box(fields[end + 1]) && !apart(fields[end], fields[end + 1])) end++;
		return fields.slice(start, end + 1);
	};
	const row = rowOf(el, pageFields);
	// One box alone (a middle initial) is a field like any other: it takes one insert, as before.
	if (row.length < 2) return { box: false };
	const typing = { row, values: row.map((each) => each.value), submitted: false };
	// The row now: a widget that draws its boxes again, as new elements, is found again where it was (or around the
	// box with focus), its boxes in the same places, holding what they held (give or take the box a key just went to).
	// Another widget put in its place (other boxes, other digits) is not the row: null, as a row gone.
	// Where the row sits, to find it again: the elements around its first box, nearest first, and the first box's place
	// among the boxes in each (from one list of the page's boxes, and each box's own elements around it).
	const boxesIn = (holder) => all(holder).filter((each) => box(each) && seen(each));
	const chain = (el) => {
		const ups = [];
		for (let up = el.parentNode; up; up = up.parentNode ?? up.host) ups.push(up);
		return ups;
	};
	const pageBoxes = pageFields.filter((each) => box(each) && seen(each)).map((each) => ({ each, ups: new Set(chain(each)) }));
	const first = pageBoxes.findIndex((entry) => entry.each === row[0]);
	const before = pageBoxes.slice(0, Math.max(0, first));
	const around = chain(row[0]).map((holder) => ({ holder, place: first < 0 ? -1 : before.filter((entry) => entry.ups.has(holder)).length }));
	typing.current = () => {
		if (typing.row.every((each) => each.isConnected)) return typing.row;
		// The row now at the same place in the nearest of those still in the page, else around the box with focus.
		const near = around.find((each) => each.holder.isConnected);
		const focused = deepActive();
		const candidates = [
			...(near && near.place >= 0 ? [boxesIn(near.holder)[near.place]] : []),
			...(focused && box(focused) ? [focused] : []),
		].filter(Boolean);
		for (const candidate of candidates) {
			const again = rowOf(candidate);
			const differ = again.filter((each, index) => each.value !== typing.values[index]).length;
			if (again.length === typing.row.length && differ <= 1) {
				typing.row = again;
				return again;
			}
		}
		return null;
	};
	window.__piPocketTyping = typing;
	// A form submitted while the code goes in, by the widget itself (on the last digit, or a moment after it).
	// Only the latest typing listens: the one before lets go.
	window.__piPocketTypingOff?.();
	const submitted = () => { typing.submitted = true; };
	const roots = [...new Set([document, el.getRootNode()])];
	for (const root of roots) root.addEventListener("submit", submitted, { capture: true });
	window.__piPocketTypingOff = () => { for (const root of roots) root.removeEventListener("submit", submitted, { capture: true }); };
	// What the row held before: a box still holding it after typing did not take its key.
	return { box: true, before: row.map((each) => each.value), clicked: row.indexOf(el) };
})()`;

/**
 * Where typing a code stands (`TYPING_FIELD_SCRIPT`): which of the row's boxes has focus (-1 for none), what each box
 * holds (null once the row left the page, as a page that moved on does: a row drawn again is found again where it
 * was, focused or not), and whether a form was submitted since
 * typing began. With `select`, the focused box's text is selected first, so the next key replaces it.
 */
export const TYPING_STATE_SCRIPT = String.raw`((select) => {
	${DEEP_ACTIVE}
	const typing = window.__piPocketTyping;
	if (!typing) return { at: -1, values: null, submitted: false };
	const el = deepActive();
	// A row gone (and not drawn again: see current) is a page that moved on.
	const row = typing.current();
	if (row === null) return { at: -1, values: null, submitted: typing.submitted };
	const at = row.indexOf(el);
	if (at >= 0) typing.focused = el;
	if (select && at >= 0) el.select();
	typing.values = row.map((each) => each.value);
	// Nothing has focus because the widget drew its boxes again (the box that had it is gone), rather than another
	// element taking it, or the widget letting go of it on purpose (a blur, to hide a phone's keyboard).
	const idle = (!el || el === document.body || el === document.documentElement) && typing.focused?.isConnected === false;
	return { at, values: typing.values, submitted: typing.submitted, idle };
})`;

/**
 * Empties `count` boxes of the row typing began in (`TYPING_FIELD_SCRIPT`) from box `from` on, as edits would (the
 * page's own value setter and an input event for each box, so frameworks see it). A controlled widget may put a value
 * back: `#typeCode` reads the boxes after this.
 */
export const TYPING_CLEAR_SCRIPT = String.raw`((from, count) => {
	const typing = window.__piPocketTyping;
	if (!typing || typing.current() === null) return false;
	const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
	// Box by box, the row found again after each: a widget may draw its boxes again on every input event.
	for (let index = from; index < from + count; index++) {
		const box = typing.current()?.[index];
		if (!box) break;
		// Read-only boxes too: some are read-only until focused, against autofill, and hold an old code all the same.
		if (box.value === "") continue;
		set.call(box, "");
		box.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "deleteContentBackward" }));
		// What it holds now: a widget may put its value back (then Backspace clears it).
		typing.values[index] = typing.current()?.[index]?.value ?? "";
	}
	return true;
})`;

/**
 * Focuses box `index` of the row typing began in, as a person's click would: blurred first, so a widget that keeps its
 * own place in the row takes it from the focus event (a box that has focus already would not get one).
 */
export const TYPING_FOCUS_BOX_SCRIPT = String.raw`((index) => {
	${DEEP_ACTIVE}
	const box = window.__piPocketTyping?.current()?.[index];
	if (!box || !box.isConnected) return false;
	deepActive()?.blur();
	box.focus();
	// Selected, as a click into a box leaves it: Backspace deletes it, and a key replaces it.
	box.select?.();
	return true;
})`;

/**
 * What the field `SELECT_ALL_SCRIPT` noted keeps of an insert, when it may have dropped part of it: a number field (it
 * keeps what makes a number), or one with a length limit. Null for any other field.
 */
export const KEPT_VALUE_SCRIPT = String.raw`(() => {
	const el = window.__piPocketTyped;
	window.__piPocketTyped = undefined;
	if (!el?.isConnected || !["INPUT", "TEXTAREA"].includes(el.tagName)) return null;
	if (el.tagName === "INPUT" && el.type === "number") return { value: el.value, number: true };
	const text = el.tagName === "TEXTAREA" || ["text", "tel", "password", "search", "email", "url"].includes(el.type);
	if (text && el.maxLength > 0) return { value: el.value, number: false, limit: el.maxLength, password: el.type === "password", single: el.tagName === "INPUT" };
	// A one-line field with no limit, for one a script cuts (a box per character that keeps only the last).
	return text && el.tagName === "INPUT" ? { value: el.value, number: false, password: el.type === "password", single: true } : null;
})()`;

/** Picks an option of a select element by its value or text. */
export const SELECT_OPTION_SCRIPT = String.raw`((target, wanted) => {
	const el = target.ref ? window.__piPocketRefs?.get(target.ref)?.deref() : target.selector ? document.querySelector(target.selector) : document.activeElement;
	if (!el) throw new Error("No such element: take a new snapshot.");
	if (el.tagName !== "SELECT") throw new Error("That is a " + el.tagName.toLowerCase() + ", not a select element: click it instead.");
	const want = String(wanted).trim().toLowerCase();
	const option = [...el.options].find((each) => each.value === wanted) ?? [...el.options].find((each) => each.text.trim().toLowerCase() === want) ?? [...el.options].find((each) => each.text.toLowerCase().includes(want));
	if (!option) throw new Error('No option "' + wanted + '". Options: ' + [...el.options].map((each) => each.text.trim()).join(" | "));
	el.value = option.value;
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
	return option.text.trim();
})`;

/** A value as text for Pi: JSON, with elements as their opening tags. */
export const DESCRIBE_FUNCTION = String.raw`function () {
	const seen = new WeakSet();
	const node = (value) => value.nodeType === 1 ? value.outerHTML.slice(0, 200) + (value.outerHTML.length > 200 ? "…" : "") : String(value.textContent ?? value.nodeName);
	if (this instanceof Node) return node(this);
	try {
		return JSON.stringify(this, (key, value) => {
			if (value instanceof Node) return node(value);
			if (typeof value === "function") return "[function " + (value.name || "anonymous") + "]";
			if (typeof value === "bigint") return value.toString() + "n";
			if (value && typeof value === "object") { if (seen.has(value)) return "[circular]"; seen.add(value); }
			return value;
		}, 2) ?? String(this);
	} catch (error) {
		return String(this);
	}
}`;

/**
 * The file input a target stands for: the input itself, the one a label is for, or the one inside the element (a styled
 * upload button). Returns the element, for `DOM.setFileInputFiles`.
 */
export const FILE_INPUT_SCRIPT = String.raw`((target) => {
	let el = target.ref ? window.__piPocketRefs?.get(target.ref)?.deref() : target.selector ? document.querySelector(target.selector) : null;
	if (!el && target.label) {
		const want = target.label.replace(/\s+/g, " ").trim().toLowerCase();
		const text = (each) => (each.getAttribute("aria-label") || each.innerText || each.getAttribute("title") || "").replace(/\s+/g, " ").trim().toLowerCase();
		el = [...document.querySelectorAll("input[type=file], label, button, [role=button]")].find((each) => text(each) === want || (each.labels && [...each.labels].some((label) => text(label) === want))) ?? null;
	}
	if (!el || !el.isConnected) throw new Error("No such element: take a new snapshot.");
	const isFile = (each) => each?.tagName === "INPUT" && each.type === "file";
	const input = isFile(el) ? el : el.tagName === "LABEL" && isFile(el.control) ? el.control : el.querySelector?.("input[type=file]") ?? el.shadowRoot?.querySelector("input[type=file]") ?? null;
	if (!input) throw new Error("That is a " + el.tagName.toLowerCase() + ", not a file upload: use a ref listed under File uploads in the snapshot.");
	if (input.disabled) throw new Error("That file upload is disabled.");
	return input;
})`;
