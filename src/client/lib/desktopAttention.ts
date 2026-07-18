// Desktop-attention facade over the native capability seam (nativeProvider.ts). Draws the user's
// attention in the appwrap DESKTOP shell (Dock bounce + badge) when a response finishes or input is
// needed while the window is unfocused. CE ships the web no-op provider, so every path is silent on
// web/mobile; an EE/native build registers the @livx.cc/native-kit-backed provider that implements it.
import { getNativeProvider } from './nativeProvider';

/** One-time detection: are we inside the appwrap desktop shell? Idempotent; never rejects. */
export function initDesktopAttention(): Promise<boolean> {
  return getNativeProvider().initDesktopAttention();
}

/** True only when running in the desktop shell. */
export function isDesktopShell(): boolean {
  return getNativeProvider().isDesktopShell();
}

/**
 * Bounce the Dock icon to draw attention — desktop shell only, and only when the window is unfocused.
 * `blocking` = a question/approval waiting on the user → critical bounce; otherwise a single bounce.
 */
export function requestDesktopAttention(blocking = false): void {
  getNativeProvider().requestDesktopAttention(blocking);
}

/** Reflect the pending/unread count on the Dock-icon badge. `count <= 0` clears it. No-op off desktop. */
export function setDesktopBadge(count: number): void {
  getNativeProvider().setDesktopBadge(count);
}
