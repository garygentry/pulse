import * as React from "react";
import { cn } from "@/ui/lib/utils";
import { Icon } from "@/ui/patterns/icon";

export interface SearchInputProps
  extends Omit<React.ComponentProps<"input">, "type" | "value" | "defaultValue" | "onChange"> {
  /** Accessible name; also the visible label when `showLabel`. */
  label: string;
  /** Render `label` visibly above the field (default: screen-reader only). */
  showLabel?: boolean;
  value?: string;
  defaultValue?: string;
  /** Raised with the new text, after `debounceMs` of quiet (clearing is immediate). */
  onValueChange?: (value: string) => void;
  /** Debounce for `onValueChange`, in ms. 0 (default) = on every keystroke. */
  debounceMs?: number;
  /** Focus the field when "/" is pressed outside an editable element. */
  shortcut?: boolean;
  /** Extra classes for the root wrapper (`className` goes to the input). */
  rootClassName?: string;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * A labelled search field (`role="searchbox"`) with a leading icon, a clear
 * button, Escape-to-clear and an optional "/" focus shortcut.
 */
export function SearchInput({
  label,
  showLabel = false,
  value,
  defaultValue = "",
  onValueChange,
  debounceMs = 0,
  shortcut = false,
  placeholder,
  className,
  rootClassName,
  id,
  onKeyDown,
  ...props
}: SearchInputProps) {
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [draft, setDraft] = React.useState(value ?? defaultValue);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onValueChangeRef = React.useRef(onValueChange);
  onValueChangeRef.current = onValueChange;

  // Follow the controlled value when the owner changes it (e.g. "Clear all").
  React.useEffect(() => {
    if (value !== undefined) setDraft(value);
  }, [value]);

  React.useEffect(() => () => clearTimeout(timer.current), []);

  const emit = React.useCallback(
    (next: string, immediate: boolean) => {
      clearTimeout(timer.current);
      if (immediate || debounceMs <= 0) onValueChangeRef.current?.(next);
      else timer.current = setTimeout(() => onValueChangeRef.current?.(next), debounceMs);
    },
    [debounceMs],
  );

  const change = (next: string, immediate = false) => {
    setDraft(next);
    emit(next, immediate);
  };

  React.useEffect(() => {
    if (!shortcut) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.defaultPrevented || isEditable(event.target)) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut]);

  return (
    <div data-slot="search-input" className={cn("flex min-w-0 flex-col gap-1.5", rootClassName)}>
      <label
        htmlFor={inputId}
        className={cn(showLabel ? "text-sm font-medium" : "sr-only")}
      >
        {label}
      </label>
      <div className="relative flex min-w-0 items-center">
        <Icon
          name="search"
          className="pointer-events-none absolute left-2.5 text-muted-foreground"
        />
        <input
          {...props}
          ref={inputRef}
          id={inputId}
          type="search"
          value={draft}
          placeholder={placeholder}
          aria-keyshortcuts={shortcut ? "/" : undefined}
          onChange={(event) => change(event.currentTarget.value)}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (event.key === "Escape" && draft !== "" && !event.defaultPrevented) {
              event.preventDefault();
              change("", true);
            }
          }}
          className={cn(
            "h-9 w-full min-w-0 rounded-md border border-input bg-transparent py-1 pr-9 pl-8 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
            "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
            "[&::-webkit-search-cancel-button]:appearance-none",
            className,
          )}
        />
        {draft !== "" ? (
          <button
            type="button"
            aria-label={`Clear ${label}`}
            onClick={() => {
              change("", true);
              inputRef.current?.focus();
            }}
            className="absolute right-1.5 inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <Icon name="x" size={14} />
          </button>
        ) : shortcut ? (
          <kbd
            aria-hidden="true"
            className="pointer-events-none absolute right-2 rounded border border-border bg-muted px-1.5 font-mono text-xs text-muted-foreground"
          >
            /
          </kbd>
        ) : null}
      </div>
    </div>
  );
}
