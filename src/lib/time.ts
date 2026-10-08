import type { GcodeResult, JobProgress } from "./ipc";

/** `1h 02m 05s`, `4m 05s` or `42s`. Mirrors fmt_duration in the Rust sender. */
export function formatDuration(secs: number): string {
  if (!Number.isFinite(secs)) return "–";
  const total = Math.max(0, Math.round(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/**
 * Estimated seconds needed to get through the first `line` lines, read off
 * the cumulative profile the CAM returns (sampled at evenly spaced lines,
 * linearly interpolated between samples).
 */
export function estimatedAt(profile: number[], totalLines: number, line: number): number {
  if (profile.length < 2 || totalLines <= 0) return 0;
  const k = profile.length - 1;
  const pos = Math.min(Math.max(line / totalLines, 0), 1) * k;
  const i = Math.min(Math.floor(pos), k - 1);
  return profile[i] + (profile[i + 1] - profile[i]) * (pos - i);
}

/**
 * Seconds left in a running job, or null when there is nothing to go on.
 *
 * The model's per-line profile says how much work is left; the ratio of
 * real elapsed time to the model's time for the lines already acked says how
 * far off the model is on this machine (wrong acceleration, slow firmware),
 * and scales the remainder. That ratio is noisy at the start, because the
 * sender fills GRBL's buffer before anything moves, so it is blended in as
 * the job progresses and clamped so a few odd seconds can't produce a
 * nonsense number.
 */
export function remainingSeconds(
  p: JobProgress,
  est: Pick<GcodeResult, "estProfile"> | null,
): number | null {
  if (p.total <= 0) return null;
  if (p.sent >= p.total) return 0;
  const profile = est?.estProfile ?? [];
  if (profile.length >= 2) {
    const done = estimatedAt(profile, p.total, p.sent);
    const left = Math.max(0, profile[profile.length - 1] - done);
    const ratio = done > 0 ? Math.min(Math.max(p.elapsed / done, 0.25), 4) : 1;
    const w = Math.min(1, done / 20);
    return left * (w * ratio + (1 - w));
  }
  // No profile (the scene changed after generating): assume lines take
  // roughly equal time and extrapolate from the observed pace.
  if (p.sent === 0 || p.elapsed <= 0) return null;
  return (p.elapsed / p.sent) * (p.total - p.sent);
}
