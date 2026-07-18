import { useEffect, useState } from 'react';

/** Tailwind `sm` breakpoint — below this we present tabs only (no split panes). */
const MOBILE_MAX = 639;

// Narrow viewport OR a touch phone held in landscape (short side under the breakpoint). The second
// clause keeps a phone classified as "mobile" in BOTH orientations, so rotating it never crosses the
// breakpoint — which would rebuild the workspace model, remount panes, and drop any live pane session.
const MOBILE_QUERY = `(max-width: ${MOBILE_MAX}px), (pointer: coarse) and (max-height: ${MOBILE_MAX}px)`;

/** True on narrow viewports and touch phones (either orientation). Reacts to resize/rotate. */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
