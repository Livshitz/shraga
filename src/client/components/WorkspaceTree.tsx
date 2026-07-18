import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, FileText, Folder, RefreshCw, History, Maximize2, Minimize2, ScanSearch, Move, Download } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { cn } from '@/lib/utils';

export interface WorkspaceEntry {
  path: string;
  type: 'file' | 'dir';
  size?: number;
  oneLiner?: string;
}

interface Props {
  getToken: () => Promise<string | null>;
  onRefresh?: () => void;
  refreshKey?: number;
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);
const EMBED_EXTS = new Set(['pdf', 'mp4', 'webm', 'mp3', 'ogg', 'wav']);

async function fetchDir(dir: string, getToken: () => Promise<string | null>): Promise<WorkspaceEntry[]> {
  const token = await getToken();
  if (!token) return [];
  const res = await fetch(`/api/workspace/ls?path=${encodeURIComponent(dir)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.entries ?? [];
}

export function WorkspaceTree({ getToken, onRefresh, refreshKey }: Props) {
  const [dirEntries, setDirEntries] = useState<Map<string, WorkspaceEntry[]>>(new Map());
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set());
  const [preview, setPreview] = useState<{ path: string; content: string; binary: boolean; html?: boolean; image?: boolean } | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [fitMode, setFitMode] = useState<'fit' | 'scroll'>('fit');
  const [iframeScale, setIframeScale] = useState<{ scale: number; w: number; h: number } | null>(null);
  const [contentSize, setContentSize] = useState<{ w: number; h: number } | null>(null);
  const iframeContainerRef = useRef<HTMLDivElement>(null);
  const [cachedToken, setCachedToken] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [logEntries, setLogEntries] = useState<{ hash: string; date: string; author: string; message: string; files: string[] }[]>([]);

  const loadDir = useCallback(async (dir: string) => {
    const entries = await fetchDir(dir, getToken);
    setDirEntries(prev => new Map(prev).set(dir, entries));
  }, [getToken]);

  useEffect(() => {
    loadDir('');
    openDirs.forEach(d => loadDir(d));
  }, [loadDir, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const rootEntries = dirEntries.get('') ?? [];

  const detectContentSize = useCallback((iframe: HTMLIFrameElement) => {
    try {
      const doc = iframe.contentDocument;
      if (!doc?.body) return;
      const contentW = Math.max(doc.body.offsetWidth, doc.body.scrollWidth);
      const contentH = Math.max(doc.body.offsetHeight, doc.body.scrollHeight);
      if (contentW && contentH) setContentSize({ w: contentW, h: contentH });
    } catch { /* cross-origin */ }
  }, []);

  const recalcIframeScale = useCallback(() => {
    const container = iframeContainerRef.current;
    const size = contentSize;
    if (!container || !size) return;
    const pad = 16;
    const availW = container.clientWidth - pad;
    const availH = container.clientHeight - pad;
    const scale = Math.min(availW / size.w, availH / size.h, 1);
    setIframeScale({ scale, w: size.w, h: size.h });
  }, [contentSize]);

  useEffect(() => {
    if (!preview?.html || fitMode !== 'fit') { setIframeScale(null); return; }
    const container = iframeContainerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => requestAnimationFrame(recalcIframeScale));
    ro.observe(container);
    return () => ro.disconnect();
  }, [preview?.html, maximized, fitMode, recalcIframeScale]);

  useEffect(() => {
    if (!showLog) return;
    getToken().then(token => {
      if (!token) return;
      fetch('/api/data-sync/log', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(setLogEntries)
        .catch(() => {});
    });
  }, [showLog]);

  const toggleDir = (p: string) => {
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (next.has(p)) { next.delete(p); } else {
        next.add(p);
        if (!dirEntries.has(p)) loadDir(p);
      }
      return next;
    });
  };

  const rawUrl = (filePath: string, dl?: boolean) => {
    const q = new URLSearchParams({ path: filePath });
    if (cachedToken) q.set('token', cachedToken);
    if (dl) q.set('dl', '1');
    return `/api/workspace/raw?${q}`;
  };

  const openFile = async (p: string) => {
    const token = await getToken();
    if (!token) return;
    setCachedToken(token);
    const ext = p.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'html' || ext === 'htm') {
      setPreview({ path: p, content: '', binary: false, html: true });
      return;
    }
    if (IMAGE_EXTS.has(ext)) {
      setPreview({ path: p, content: '', binary: false, image: true });
      return;
    }
    if (EMBED_EXTS.has(ext)) {
      setPreview({ path: p, content: '', binary: false, html: true });
      return;
    }
    try {
      const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(p)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setPreview({ path: p, content: data.content, binary: !!data.binary });
    } catch {}
  };

  const renderEntries = (entries: WorkspaceEntry[], depth: number) => (
    <>
      {entries.map((e) => {
        const name = e.path.split('/').pop()!;
        return (
          <div key={e.path}>
            {e.type === 'dir' ? (
              <button
                onClick={() => toggleDir(e.path)}
                className="w-full flex items-center gap-1 px-2 py-1 rounded hover:bg-accent/50 text-left text-sm"
                style={{ paddingLeft: 8 + depth * 12 }}
              >
                <ChevronRight className={cn('w-3 h-3 shrink-0 transition-transform', openDirs.has(e.path) && 'rotate-90')} />
                <Folder className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{name}</span>
              </button>
            ) : (
              <button
                onClick={() => openFile(e.path)}
                className="w-full flex items-center gap-1 px-2 py-1 rounded hover:bg-accent/50 text-left text-sm"
                style={{ paddingLeft: 8 + depth * 12 + 12 }}
                title={e.oneLiner || e.path}
              >
                <FileText className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{name}</span>
              </button>
            )}
            {e.type === 'dir' && openDirs.has(e.path) && renderEntries(dirEntries.get(e.path) ?? [], depth + 1)}
          </div>
        );
      })}
    </>
  );

  return (
    <>
      <div className="flex items-center justify-between px-3 pt-2 pb-1 shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Workspace</span>
        <div className="flex items-center gap-0.5">
          <button onClick={() => setShowLog(true)} className="p-0.5 rounded hover:bg-accent text-muted-foreground" title="Activity log">
            <History className="w-3 h-3" />
          </button>
          <button onClick={() => { loadDir(''); openDirs.forEach(d => loadDir(d)); onRefresh?.(); }} className="p-0.5 rounded hover:bg-accent text-muted-foreground" title="Refresh">
            <RefreshCw className="w-3 h-3" />
          </button>
        </div>
      </div>
      <div className="px-1 pb-2 overflow-y-auto min-h-0">
        {rootEntries.length === 0 ? (
          <p className="text-xs text-muted-foreground px-3 py-2">Empty. Drop .md files into data/workspace/ or ask the agent to create some.</p>
        ) : renderEntries(rootEntries, 0)}
      </div>

      <Dialog open={!!preview} onOpenChange={(o) => { if (!o) { setPreview(null); setMaximized(false); setFitMode('fit'); setContentSize(null); } }}>
        <DialogContent className={cn(
          preview?.html
            ? cn('!flex !flex-col !p-0 !gap-0 overflow-hidden', maximized ? 'max-w-none w-[100vw] h-[100vh] rounded-none border-0' : 'max-w-[90vw] w-[90vw] h-[85vh]')
            : 'max-w-3xl max-h-[80vh] !flex !flex-col overflow-hidden',
        )}>
          <div className="absolute right-12 top-4 flex items-center gap-1.5 z-10">
            {preview?.html && (
              <>
                <button onClick={() => setFitMode(m => m === 'fit' ? 'scroll' : 'fit')} className="rounded-sm opacity-70 hover:opacity-100 text-muted-foreground" title={fitMode === 'fit' ? 'Switch to scrollable (1:1)' : 'Switch to scale-to-fit'}>
                  {fitMode === 'fit' ? <Move className="w-4 h-4" /> : <ScanSearch className="w-4 h-4" />}
                </button>
                <button onClick={() => setMaximized(m => !m)} className="rounded-sm opacity-70 hover:opacity-100 text-muted-foreground" title={maximized ? 'Restore' : 'Maximize'}>
                  {maximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                </button>
              </>
            )}
            {preview && (
              <a href={rawUrl(preview.path, true)} download className="rounded-sm opacity-70 hover:opacity-100 text-muted-foreground" title="Download">
                <Download className="w-4 h-4" />
              </a>
            )}
          </div>
          <DialogHeader className={cn(preview?.html && 'px-4 py-3 shrink-0 border-b')}>
            <DialogTitle className="font-mono text-sm truncate pr-16">{preview?.path}</DialogTitle>
          </DialogHeader>
          <div ref={preview?.html ? iframeContainerRef : undefined} className={cn(preview?.html ? cn('flex-1 min-h-0 bg-muted/10', fitMode === 'fit' ? 'overflow-hidden flex items-center justify-center' : 'overflow-auto') : 'flex-1 min-h-0 overflow-y-auto')}>
            {preview?.html ? (
              fitMode === 'fit' ? (
                <div style={iframeScale ? { width: iframeScale.w * iframeScale.scale, height: iframeScale.h * iframeScale.scale } : { width: '100%', height: '100%' }}>
                  <iframe
                    src={rawUrl(preview.path)}
                    className="border-0 bg-white origin-top-left"
                    title={preview.path}
                    onLoad={(e) => { detectContentSize(e.currentTarget); recalcIframeScale(); }}
                    style={iframeScale
                      ? { width: iframeScale.w, height: iframeScale.h, transform: `scale(${iframeScale.scale})` }
                      : { width: '100%', height: '100%' }
                    }
                  />
                </div>
              ) : (
                <iframe
                  src={rawUrl(preview.path)}
                  className="border-0 bg-white mx-auto block"
                  title={preview.path}
                  onLoad={(e) => detectContentSize(e.currentTarget)}
                  style={{ width: contentSize?.w || '100%', height: contentSize?.h || '100%' }}
                />
              )
            ) : preview?.image ? (
              <div className="flex items-center justify-center p-4">
                <img
                  src={rawUrl(preview.path)}
                  alt={preview.path}
                  className="max-w-full max-h-[70vh] object-contain"
                />
              </div>
            ) : preview?.binary ? (
              <p className="text-sm text-muted-foreground">(binary file — preview unavailable)</p>
            ) : preview?.path.toLowerCase().endsWith('.md') || preview?.path.toLowerCase().endsWith('.markdown') ? (
              <div className="text-sm">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  className="prose prose-sm max-w-none dark:prose-invert prose-pre:bg-muted prose-pre:border prose-code:before:content-none prose-code:after:content-none"
                >
                  {preview.content}
                </ReactMarkdown>
              </div>
            ) : (
              <pre className="text-xs whitespace-pre-wrap break-all">{preview?.content}</pre>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showLog} onOpenChange={setShowLog}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-sm">Activity Log</DialogTitle>
          </DialogHeader>
          <div className="overflow-y-auto flex-1 space-y-2">
            {logEntries.map(e => (
              <div key={e.hash} className="border-b border-border/50 pb-2 last:border-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm text-foreground">{e.message}</span>
                  <span className="text-[10px] text-muted-foreground shrink-0">{formatDate(e.date)}</span>
                </div>
                {e.files.length > 0 && (
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {e.files.map(f => <span key={f} className="inline-block mr-2 font-mono">{f}</span>)}
                  </div>
                )}
              </div>
            ))}
            {logEntries.length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">No activity yet</p>}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
