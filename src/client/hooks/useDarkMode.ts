import { useSyncExternalStore } from 'react';

// Shared, reactive dark-mode store. A module-level singleton (not per-hook useState) so EVERY
// consumer — App's toggle, ChatView — observes the same value and re-renders together.
// Without this, toggling in one component left the others stale.
function read(): boolean {
  const stored = localStorage.getItem('dark-mode');
  if (stored !== null) return stored === 'true';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

let dark = typeof window !== 'undefined' ? read() : true;
const listeners = new Set<() => void>();

function apply() {
  document.documentElement.classList.toggle('dark', dark);
  localStorage.setItem('dark-mode', String(dark));
  listeners.forEach((l) => l());
}

// Apply once at module load so the class reflects the initial value before any toggle.
if (typeof window !== 'undefined') apply();

function setDark(next: boolean) {
  if (next === dark) return;
  dark = next;
  apply();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  // Cross-tab sync: another tab toggling dark-mode writes localStorage.
  const onStorage = (e: StorageEvent) => {
    if (e.key === 'dark-mode') setDark(read());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

/** Non-reactive read of the current mode — for imperative call sites (e.g. an add-on spawning a themed widget) that need
 *  the value once, outside React. */
export function isDarkMode(): boolean {
  return dark;
}

/** Imperative toggle — for non-React call sites (e.g. the global keyboard shortcut). */
export function toggleDarkMode() {
  setDark(!dark);
}

export function useDarkMode() {
  const value = useSyncExternalStore(subscribe, () => dark, () => dark);
  return { dark: value, toggle: () => setDark(!dark) };
}
