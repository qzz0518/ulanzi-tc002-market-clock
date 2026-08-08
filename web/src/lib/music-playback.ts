export function clampPlaybackPositionMs(positionMs: number, durationMs: number): number {
  if (!Number.isFinite(positionMs) || positionMs <= 0) return 0;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return Math.round(positionMs);
  return Math.round(Math.min(positionMs, durationMs));
}
