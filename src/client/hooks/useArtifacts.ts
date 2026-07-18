import { useState, useCallback, useEffect } from 'react';
import type { ServerEvent } from '@/lib/ws';

export interface ArtifactMeta {
  id: string;
  sessionId: string;
  title: string;
  dimensions: [number, number];
  version: number;
}

interface ArtifactsState {
  artifacts: ArtifactMeta[];
  selectedId: string | null;
  panelOpen: boolean;
}

const PANEL_KEY = 'shraga:artifactPanel';
const SELECTED_KEY = 'shraga:artifactSelected';
const isMobile = () => window.innerWidth < 640; // matches Tailwind sm: breakpoint

export function useArtifacts(sessionId: string | undefined, getToken?: () => Promise<string | null>, token?: string | null) {
  const [state, setState] = useState<ArtifactsState>({
    artifacts: [],
    selectedId: null,
    panelOpen: isMobile() ? false : localStorage.getItem(PANEL_KEY) === 'true',
  });

  const reset = useCallback(() => {
    setState(s => ({ ...s, artifacts: [], selectedId: null }));
    localStorage.removeItem(SELECTED_KEY);
  }, []);

  const handleArtifactEvent = useCallback((event: ServerEvent) => {
    if (event.type !== 'artifact') return;
    const e = event as any;
    setState(s => {
      const existing = s.artifacts.findIndex(a => a.id === e.id);
      const meta: ArtifactMeta = { id: e.id, sessionId: e.sessionId, title: e.title, dimensions: e.dimensions, version: e.version };
      const artifacts = existing >= 0
        ? s.artifacts.map((a, i) => i === existing ? meta : a)
        : [...s.artifacts, meta];
      localStorage.setItem(SELECTED_KEY, e.id);
      return { artifacts, selectedId: e.id, panelOpen: true };
    });
  }, []);

  const selectArtifact = useCallback((id: string) => {
    setState(s => ({ ...s, selectedId: id, panelOpen: true }));
    localStorage.setItem(SELECTED_KEY, id);
  }, []);

  const togglePanel = useCallback(() => {
    setState(s => {
      const next = !s.panelOpen;
      localStorage.setItem(PANEL_KEY, String(next));
      return { ...s, panelOpen: next };
    });
  }, []);

  const closePanel = useCallback(() => {
    setState(s => ({ ...s, panelOpen: false }));
    localStorage.setItem(PANEL_KEY, 'false');
  }, []);

  // Load artifacts when session changes
  useEffect(() => {
    if (!sessionId) { reset(); return; }
    (async () => {
      const token = await getToken?.();
      if (!token) return;
      const res = await fetch(`/api/artifacts/${sessionId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const artifacts: ArtifactMeta[] = await res.json();
      const savedId = localStorage.getItem(SELECTED_KEY);
      const restoredId = artifacts.find(a => a.id === savedId)?.id ?? artifacts[artifacts.length - 1]?.id ?? null;
      setState(s => ({ ...s, artifacts, selectedId: restoredId }));
    })().catch(() => {});
  }, [sessionId, reset, getToken, token]);

  return {
    ...state,
    handleArtifactEvent,
    selectArtifact,
    togglePanel,
    closePanel,
    reset,
  };
}
