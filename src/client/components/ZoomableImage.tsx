import { useCallback, useRef, useState } from 'react';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';

const MIN_SCALE = 1;
const MAX_SCALE = 10;

type View = { scale: number; tx: number; ty: number };
const RESET: View = { scale: 1, tx: 0, ty: 0 };

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/**
 * A pan/zoom viewer for a single image. Wheel/pinch zooms toward the cursor,
 * drag pans when zoomed in, double-click toggles a 2.5x zoom at the point.
 * Used by the chat lightbox so large images (e.g. dense diagrams) can be
 * inspected at full resolution instead of being fit-to-viewport.
 */
export function ZoomableImage({ src, alt = '' }: { src: string; alt?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const [view, setView] = useState<View>(RESET);
  const [panning, setPanning] = useState(false);

  // cursor position relative to the container's center (screen px)
  const relToCenter = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { cx: 0, cy: 0 };
    return { cx: clientX - rect.left - rect.width / 2, cy: clientY - rect.top - rect.height / 2 };
  };

  // Zoom to an absolute scale while keeping the point under (cx, cy) fixed.
  const zoomTo = useCallback((nextScale: number, cx: number, cy: number) => {
    setView((prev) => {
      const s2 = clampScale(nextScale);
      if (s2 === prev.scale) return prev;
      if (s2 <= MIN_SCALE) return RESET;
      const k = s2 / prev.scale;
      return { scale: s2, tx: cx - k * (cx - prev.tx), ty: cy - k * (cy - prev.ty) };
    });
  }, []);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const { cx, cy } = relToCenter(e.clientX, e.clientY);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setView((prev) => {
      const s2 = clampScale(prev.scale * factor);
      if (s2 === prev.scale) return prev;
      if (s2 <= MIN_SCALE) return RESET;
      const k = s2 / prev.scale;
      return { scale: s2, tx: cx - k * (cx - prev.tx), ty: cy - k * (cy - prev.ty) };
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (view.scale <= 1) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    setPanning(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setView((prev) => ({ ...prev, tx: d.tx + (e.clientX - d.x), ty: d.ty + (e.clientY - d.y) }));
  };
  const endDrag = () => { drag.current = null; setPanning(false); };

  const onDoubleClick = (e: React.MouseEvent) => {
    const { cx, cy } = relToCenter(e.clientX, e.clientY);
    if (view.scale > 1) setView(RESET);
    else zoomTo(2.5, cx, cy);
  };

  const step = (factor: number) => zoomTo(view.scale * factor, 0, 0);
  const zoomed = view.scale > 1;

  return (
    <div className="relative w-full h-full flex items-center justify-center">
      <div
        ref={containerRef}
        className="w-full h-full overflow-hidden flex items-center justify-center"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onDoubleClick}
        style={{ cursor: zoomed ? (panning ? 'grabbing' : 'grab') : 'zoom-in', touchAction: 'none' }}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="max-w-full max-h-[85vh] object-contain rounded-lg select-none"
          style={{
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
            transition: panning ? 'none' : 'transform 0.08s ease-out',
            transformOrigin: 'center center',
          }}
        />
      </div>

      {/* Controls */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full bg-background/90 border shadow-sm px-1.5 py-1 backdrop-blur">
        <button type="button" onClick={() => step(1 / 1.4)} title="Zoom out"
          className="p-1.5 rounded-full hover:bg-muted transition-colors disabled:opacity-40" disabled={!zoomed}>
          <ZoomOut className="w-4 h-4" />
        </button>
        <span className="text-xs tabular-nums w-11 text-center text-muted-foreground select-none">
          {Math.round(view.scale * 100)}%
        </span>
        <button type="button" onClick={() => step(1.4)} title="Zoom in"
          className="p-1.5 rounded-full hover:bg-muted transition-colors disabled:opacity-40" disabled={view.scale >= MAX_SCALE}>
          <ZoomIn className="w-4 h-4" />
        </button>
        <button type="button" onClick={() => setView(RESET)} title="Reset"
          className="p-1.5 rounded-full hover:bg-muted transition-colors disabled:opacity-40" disabled={!zoomed}>
          <Maximize2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
