import { useSyncExternalStore } from "react";
import { ARROW_VISIBILITY_OPTIONS, normalizeArrowVisibility, type ArrowVisibility } from "./arrowVisibility";
const KEY = "arc-arrow-visibility-v1";
let value: ArrowVisibility = "main-on-ball", initialized = false;
const listeners = new Set<() => void>();
function notify() { listeners.forEach((listener) => listener()); }
function initialize() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  try { value = normalizeArrowVisibility(localStorage.getItem(KEY)); } catch { value = "main-on-ball"; }
  window.addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === null) { value = normalizeArrowVisibility(event.newValue); notify(); }
  });
}
function subscribe(listener: () => void) { initialize(); listeners.add(listener); return () => { listeners.delete(listener); }; }
function snapshot() { initialize(); return value; }
export function setArrowVisibility(next: ArrowVisibility) {
  value = normalizeArrowVisibility(next);
  try { localStorage.setItem(KEY, value); } catch { /* Keep the session preference usable without storage. */ }
  notify();
}
export function useArrowVisibility() { return useSyncExternalStore(subscribe, snapshot, () => "main-on-ball" as ArrowVisibility); }
export function ArrowVisibilityControl() {
  const visibility = useArrowVisibility();
  return <label className="arrow-visibility-control"><span>Arrows</span><select aria-label="Arrows" value={visibility} onChange={(event) => setArrowVisibility(normalizeArrowVisibility(event.currentTarget.value))}>{ARROW_VISIBILITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}
