import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Maximize2, Minimize2, Image, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ArtifactMeta } from '@/hooks/useArtifacts';
import { DIMENSION_PRESETS } from './artifact-presets';

interface Props {
  artifacts: ArtifactMeta[];
  selectedId: string | null;
  sessionId: string;
  getToken: () => Promise<string | null>;
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function ArtifactPanel({ artifacts, selectedId, sessionId, getToken, onSelect, onClose }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [pngExport, setPngExport] = useState(false); // PNG export is an EE overlay capability; hidden in CE
  const [scale, setScale] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const selected = artifacts.find(a => a.id === selectedId);

  const recalcScale = useCallback(() => {
    if (!containerRef.current || !selected) return;
    const { clientWidth, clientHeight } = containerRef.current;
    const pad = 32;
    const availW = clientWidth - pad;
    const availH = clientHeight - pad;
    const [w, h] = selected.dimensions;
    setScale(Math.min(availW / w, availH / h, 1));
  }, [selected]);

  useEffect(() => {
    let alive = true;
    getToken()
      .then(t => fetch('/api/features', { headers: t ? { Authorization: `Bearer ${t}` } : {} }))
      .then(r => r.json())
      .then((f: { artifactPngExport?: boolean }) => { if (alive) setPngExport(!!f.artifactPngExport); })
      .catch(err => console.error('[artifact] features fetch failed:', err));
    return () => { alive = false; };
  }, [getToken]);

  useEffect(() => {
    recalcScale();
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(recalcScale);
    ro.observe(el);
    return () => ro.disconnect();
  }, [recalcScale]);

  const handleExport = async () => {
    if (!selected) return;
    setExporting(true);
    try {
      const token = await getToken();
      const res = await fetch(`/api/artifacts/${sessionId}/${selected.id}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ dimensions: selected.dimensions }),
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${selected.title.replace(/\s+/g, '-').toLowerCase()}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[artifact] export failed:', err);
    } finally {
      setExporting(false);
    }
  };

  const presetLabel = selected
    ? Object.entries(DIMENSION_PRESETS).find(([, d]) => d[0] === selected.dimensions[0] && d[1] === selected.dimensions[1])?.[0]
    : null;

  const [w, h] = selected?.dimensions ?? [0, 0];
  const scaledW = w * scale;
  const scaledH = h * scale;

  return (
    <div className={cn(
      'flex flex-col border-l bg-background transition-all',
      expanded
        ? 'fixed inset-0 z-50'
        : 'fixed inset-0 z-50 sm:relative sm:inset-auto sm:z-auto sm:w-[480px] sm:shrink-0',
    )}>
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b bg-muted/30">
        <Button variant="ghost" size="icon" className="h-7 w-7 sm:hidden shrink-0" onClick={onClose} title="Back to chat">
          <ArrowLeft className="w-4 h-4" />
        </Button>
        {artifacts.length > 1 && (
          <select
            className="text-xs bg-transparent border rounded px-1 py-0.5 max-w-[160px] truncate"
            value={selectedId ?? ''}
            onChange={e => onSelect(e.target.value)}
          >
            {artifacts.map(a => (
              <option key={a.id} value={a.id}>{a.title}</option>
            ))}
          </select>
        )}
        {artifacts.length <= 1 && selected && (
          <span className="text-xs font-medium truncate max-w-[160px]">{selected.title}</span>
        )}
        {selected && (
          <span className="text-[10px] text-muted-foreground">
            {presetLabel ?? `${w}×${h}`}
            {scale < 1 && ` · ${Math.round(scale * 100)}%`}
          </span>
        )}
        <div className="flex-1" />
        {pngExport && (
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleExport} disabled={!selected || exporting} title="Export PNG">
            {exporting ? <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" /> : <Image className="w-3.5 h-3.5" />}
          </Button>
        )}
        <Button variant="ghost" size="icon" className="h-6 w-6 hidden sm:inline-flex" onClick={() => setExpanded(!expanded)} title={expanded ? 'Minimize' : 'Maximize'}>
          {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6 hidden sm:inline-flex" onClick={onClose} title="Close">
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Iframe container — scaled to fit */}
      <div ref={containerRef} className="flex-1 overflow-hidden flex items-center justify-center bg-muted/10">
        {selected ? (
          <div style={{ width: scaledW, height: scaledH }}>
            <iframe
              src={`/api/artifacts/${sessionId}/${selected.id}`}
              sandbox="allow-scripts"
              className="border shadow-sm bg-white origin-top-left"
              style={{ width: w, height: h, transform: `scale(${scale})` }}
              title={selected.title}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No artifact selected</p>
        )}
      </div>
    </div>
  );
}
