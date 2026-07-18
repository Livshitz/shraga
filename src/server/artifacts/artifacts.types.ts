export interface Artifact {
  id: string;
  sessionId: string;
  title: string;
  dimensions: [number, number];
  version: number;
  createdAt: number;
  updatedAt: number;
  /** Original file path the agent wrote to (for Edit detection) */
  filePath?: string;
}

export interface ArtifactIndex {
  artifacts: Artifact[];
}

export const DIMENSION_PRESETS: Record<string, [number, number]> = {
  'fb-feed': [1080, 1080],
  'fb-story': [1080, 1920],
  'fb-landscape': [1200, 628],
  'ig-square': [1080, 1080],
  'ig-story': [1080, 1920],
  'ig-landscape': [1080, 566],
  'banner-leaderboard': [728, 90],
  'banner-medium': [300, 250],
};

export class ArtifactOptions {
  tailwindVersion = '3.4';
  defaultDimensions: [number, number] = [1080, 1080];
}
