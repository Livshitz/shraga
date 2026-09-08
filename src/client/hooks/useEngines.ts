import { useEffect, useState } from 'react';
import { setModelResolver } from '../../server/directives.ts';
import { makeModelResolver } from '../../server/engine/model-resolver.ts';

export interface EngineModel {
  value: string;
  label: string;
  provider?: string;
}

export interface EngineInfo {
  name: string;
  models: EngineModel[];
}

/**
 * The live engine registry (`GET /api/engines`) — so a picker can never offer an engine or model
 * this server doesn't actually have.
 *
 * It also installs the model resolver the directive parser uses, seeded from the same response.
 * Without it the client reads `[composer-2.5]` as prose while the server reads it as a model on
 * the agentx engine — and an editor that disagrees with the parser corrupts what it rewrites.
 */
// One process-wide registry cache behind one resolver installed at import time. Per-hook install/
// teardown would let one component's unmount clear the resolver another is still parsing with.
let registry: EngineInfo[] = [];
setModelResolver(makeModelResolver(() => registry));

export function useEngines(getToken: () => Promise<string | null>, enabled = true) {
  const [engines, setEngines] = useState<EngineInfo[]>(registry);
  const [multiEngine, setMultiEngine] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    getToken().then((token) => {
      if (!token || !alive) return;
      fetch('/api/engines', { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((data) => {
          if (!alive) return;
          registry = data.engines ?? [];
          setEngines(registry);
          setMultiEngine(data.multiEngine ?? false);
        })
        .catch((e) => console.warn('[engines] load failed', e));
    });
    return () => { alive = false; };
  }, [enabled, getToken]);

  return { engines, multiEngine };
}
