/** Small DOM helpers shared by the interaction hooks. */

/** Elements whose keystrokes belong to the control, not to page-level shortcuts. */
const EDITABLE_ELEMENTS: ReadonlySet<string> = new Set([
  "input",
  "select",
  "textarea",
  "button",
  "summary",
]);

const CONTENTEDITABLE_SELECTOR =
  '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/** Composite widgets that handle their own arrow/letter/Escape keys. */
const COMPOSITE_WIDGET_SELECTOR = '[role="listbox"], [role="menu"]';

/**
 * True when a keystroke's target is a form control or editable content, so
 * page-level keyboard shortcuts must stand aside. That keeps typing, Space,
 * arrow selection and Tab working inside the control.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== "object") return false;
  const el = target as Partial<Element> & { isContentEditable?: boolean };
  const name = (el.localName ?? el.tagName ?? "").toLowerCase();
  if (EDITABLE_ELEMENTS.has(name)) return true;
  if (el.isContentEditable === true) return true;
  if (typeof el.closest !== "function") return false;
  // A listbox or menu (e.g. an open FacetFilter popover) owns its own keys.
  if (el.closest(COMPOSITE_WIDGET_SELECTOR) !== null) return true;
  // jsdom does not implement isContentEditable, so check the attribute too.
  return el.closest(CONTENTEDITABLE_SELECTOR) !== null;
}

/** `<input>` types that take no typed text: a chord pressed on one is not text entry. */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/**
 * True when a keystroke's target takes typed text (a text-like `<input>`, a
 * `<textarea>`, a `<select>` with its type-ahead, or contenteditable). Narrower
 * than {@link isEditableTarget}: buttons, links and composite widgets are not
 * text entry, so global chords such as Ctrl/Cmd-B still work from them, while a
 * chord typed into a field (Ctrl/Cmd-B for bold, a bracket in a search box) is
 * left to the field.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== "object") return false;
  const el = target as Partial<Element> & { isContentEditable?: boolean; type?: string };
  const name = (el.localName ?? el.tagName ?? "").toLowerCase();
  if (name === "textarea" || name === "select") return true;
  if (name === "input") return !NON_TEXT_INPUT_TYPES.has((el.type ?? "text").toLowerCase());
  if (el.isContentEditable === true) return true;
  if (typeof el.closest !== "function") return false;
  // jsdom/happy-dom may not implement isContentEditable, so check the attribute too.
  return el.closest(CONTENTEDITABLE_SELECTOR) !== null;
}

/** `CSS.escape`, with a minimal fallback, for using an id inside a selector. */
export function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

/**
 * True when focus has fallen out of the page: nothing, `<body>`, or an element
 * that has since unmounted. Focus recovery should run only then, never when the
 * user has moved focus somewhere on purpose (search, a filter popover, a checkbox).
 */
export function focusIsLost(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}
