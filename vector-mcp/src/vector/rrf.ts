// @ts-nocheck
export interface ScoredItem {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export function reciprocalRankFusion(
  denseResults: ScoredItem[],
  sparseResults: ScoredItem[],
  k: number = 60
): ScoredItem[] {
  const rrfScores = new Map<string, number>();
  const payloadMap = new Map<string, Record<string, unknown>>();

  for (let rank = 0; rank < denseResults.length; rank++) {
    const item = denseResults[rank];
    const key = item.id;
    const contrib = 1 / (k + rank + 1);
    rrfScores.set(key, (rrfScores.get(key) ?? 0) + contrib);
    if (!payloadMap.has(key)) {
      payloadMap.set(key, item.payload);
    }
  }

  for (let rank = 0; rank < sparseResults.length; rank++) {
    const item = sparseResults[rank];
    const key = item.id;
    const contrib = 1 / (k + rank + 1);
    rrfScores.set(key, (rrfScores.get(key) ?? 0) + contrib);
    if (!payloadMap.has(key)) {
      payloadMap.set(key, item.payload);
    }
  }

  const fused: ScoredItem[] = [];
  for (const [id, score] of rrfScores) {
    fused.push({ id, score, payload: payloadMap.get(id)! });
  }

  fused.sort((a, b) => b.score - a.score);
  return fused;
}
