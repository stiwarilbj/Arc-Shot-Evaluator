import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface ArcSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface ArcSelectProps {
  value: string;
  options: ArcSelectOption[];
  onValueChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

interface PopupPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

function firstEnabled(options: ArcSelectOption[], start = 0, direction: 1 | -1 = 1) {
  if (!options.length) return -1;
  for (let offset = 0; offset < options.length; offset += 1) {
    const index = (start + direction * offset + options.length) % options.length;
    if (!options[index].disabled) return index;
  }
  return -1;
}

export function ArcSelect({ value, options, onValueChange, ariaLabel, placeholder, className = "", disabled = false }: ArcSelectProps) {
  const generatedId = useId().replaceAll(":", "");
  const listboxId = `arc-select-listbox-${generatedId}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef("");
  const typeaheadAtRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<PopupPosition | null>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex < 0 ? null : options[selectedIndex];

  useLayoutEffect(() => {
    if (!open) return;
    const positionPopup = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight;
      const estimatedHeight = Math.min(340, Math.max(46, options.length * (options.some((option) => option.description) ? 62 : 40) + 8));
      const below = Math.max(0, viewportHeight - anchor.bottom - 10);
      const above = Math.max(0, anchor.top - 10);
      const openAbove = below < Math.min(estimatedHeight, 190) && above > below;
      const available = Math.max(100, openAbove ? above : below);
      const maxHeight = Math.min(estimatedHeight, available);
      const contentWidth = options.reduce((width, option) => Math.max(width, option.label.length * 7 + (option.description ? Math.min(option.description.length * 5.4, 210) : 0) + 62), 0);
      const width = Math.min(Math.max(anchor.width, Math.min(contentWidth, 340)), Math.max(180, viewportWidth - 16));
      const left = Math.max(8, Math.min(anchor.left, viewportWidth - width - 8));
      const top = openAbove
        ? Math.max(8, anchor.top - maxHeight - 6)
        : Math.min(viewportHeight - maxHeight - 8, anchor.bottom + 6);
      setPosition({ left, top, width, maxHeight });
    };
    positionPopup();
    window.addEventListener("resize", positionPopup);
    window.addEventListener("scroll", positionPopup, true);
    return () => {
      window.removeEventListener("resize", positionPopup);
      window.removeEventListener("scroll", positionPopup, true);
    };
  }, [open, options]);

  useLayoutEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!triggerRef.current?.contains(target) && !listboxRef.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  function openAt(index: number) {
    const next = options[index] && !options[index].disabled ? index : firstEnabled(options, Math.max(0, index));
    setActiveIndex(next);
    setOpen(true);
  }

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function moveActive(direction: 1 | -1) {
    const start = activeIndex < 0 ? (direction > 0 ? 0 : options.length - 1) : (activeIndex + direction + options.length) % options.length;
    const next = firstEnabled(options, start, direction);
    if (next >= 0) setActiveIndex(next);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onValueChange(option.value);
    close(true);
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) openAt(selectedIndex >= 0 ? selectedIndex : (event.key === "ArrowDown" ? 0 : options.length - 1));
      else moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? firstEnabled(options) : firstEnabled(options, options.length - 1, -1);
      setActiveIndex(next);
      setOpen(true);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(activeIndex);
      else openAt(selectedIndex >= 0 ? selectedIndex : 0);
      return;
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      typeaheadRef.current = now - typeaheadAtRef.current < 700 ? `${typeaheadRef.current}${event.key}` : event.key;
      typeaheadAtRef.current = now;
      const query = typeaheadRef.current.toLocaleLowerCase();
      const start = Math.max(0, activeIndex + 1);
      const ordered = [...options.slice(start), ...options.slice(0, start)];
      const match = ordered.find((option) => !option.disabled && option.label.toLocaleLowerCase().startsWith(query));
      if (match) {
        const index = options.indexOf(match);
        setActiveIndex(index);
        if (!open) setOpen(true);
      }
    }
  }

  const popup = open && position && typeof document !== "undefined" ? createPortal(
    <div
      ref={listboxRef}
      id={listboxId}
      className="arc-select-popup"
      role="listbox"
      aria-label={ariaLabel}
      style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}
    >
      {options.map((option, index) => (
        <div
          id={`${listboxId}-option-${index}`}
          key={`${option.value}-${index}`}
          className={`arc-select-option ${index === activeIndex ? "is-active" : ""}`}
          role="option"
          aria-selected={option.value === value}
          aria-disabled={option.disabled || undefined}
          onMouseEnter={() => !option.disabled && setActiveIndex(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(index)}
        >
          <span className="arc-select-option-copy">
            <span className="arc-select-option-label">{option.label}</span>
            {option.description ? <span className="arc-select-option-description">{option.description}</span> : null}
          </span>
          {option.value === value ? <Check size={15} aria-hidden="true" /> : null}
        </div>
      ))}
    </div>,
    document.body,
  ) : null;

  return (
    <div className={`arc-select ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className={`arc-select-trigger ${open ? "is-open" : ""}`}
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
        disabled={disabled}
        onClick={() => open ? close() : openAt(selectedIndex >= 0 ? selectedIndex : 0)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={`arc-select-value ${selected ? "" : "is-placeholder"}`}>{selected?.label ?? placeholder ?? "Choose an option"}</span>
        <ChevronDown size={14} className="arc-select-chevron" aria-hidden="true" />
      </button>
      {popup}
    </div>
  );
}
