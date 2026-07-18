import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { useWorkspace } from '@/lib/workspaceContext';

// `/uploads/*` is gated by requireAuth on the server, so a plain <img src>/<a href> GET 401s
// (no Authorization header). Fetch with a fresh bearer token and render/open a blob URL instead.
// Other srcs (data:, http(s):, blob:) need no auth.
const NEEDS_AUTH = /^\/uploads\//;

interface ImageProps {
  src: string;
  alt?: string;
  className?: string;
  /** Receives the resolved (blob) src so callers like a lightbox render it directly. */
  onClick?: (resolvedSrc: string) => void;
}

export function AuthedImage({ src, alt, className, onClick }: ImageProps) {
  const { getToken } = useWorkspace();
  const [resolved, setResolved] = useState<string | null>(NEEDS_AUTH.test(src) ? null : src);

  useEffect(() => {
    if (!NEEDS_AUTH.test(src)) {
      setResolved(src);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    setResolved(null);
    (async () => {
      try {
        const token = await getToken();
        const res = await fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        objectUrl = URL.createObjectURL(await res.blob());
        if (cancelled) URL.revokeObjectURL(objectUrl);
        else setResolved(objectUrl);
      } catch (err) {
        console.error('[authed-image] load failed:', src, err);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, getToken]);

  if (!resolved) return <div className={className} aria-busy="true" />;
  return <img src={resolved} alt={alt ?? ''} className={className} onClick={() => onClick?.(resolved)} />;
}

interface FileLinkProps {
  src: string;
  name: string;
  className?: string;
}

export function AuthedFileLink({ src, name, className }: FileLinkProps) {
  const { getToken } = useWorkspace();

  const open = async (e: React.MouseEvent) => {
    if (!NEEDS_AUTH.test(src)) return; // plain href handles non-upload urls
    e.preventDefault();
    try {
      const token = await getToken();
      const res = await fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      console.error('[authed-file] open failed:', src, err);
    }
  };

  return (
    <a href={src} onClick={open} target="_blank" rel="noopener noreferrer" className={className}>
      <FileText className="w-4 h-4 shrink-0" />
      <span className="truncate max-w-[200px]">{name}</span>
    </a>
  );
}
