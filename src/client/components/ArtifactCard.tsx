import { Image } from 'lucide-react';
import type { ArtifactMeta } from '@/hooks/useArtifacts';

interface Props {
  artifact: ArtifactMeta;
  onClick: () => void;
}

export function ArtifactCard({ artifact, onClick }: Props) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-card hover:bg-accent/50 transition-colors text-left w-full max-w-xs"
    >
      <div className="flex items-center justify-center w-8 h-8 rounded bg-muted shrink-0">
        <Image className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{artifact.title}</p>
        <p className="text-[10px] text-muted-foreground">
          {artifact.dimensions[0]}×{artifact.dimensions[1]} · v{artifact.version}
        </p>
      </div>
    </button>
  );
}
