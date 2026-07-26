/**
 * The dashboard's signature element.
 * Missions/Projects are framed as quests, so progress is shown as a
 * filling badge/shield rather than a generic circular ring — it reads
 * like a game achievement icon that fills in as the mission advances.
 */
export default function ShieldProgress({
  progress,
  size = 44,
  color = "var(--accent, #E8B04D)",
}: {
  progress: number;
  size?: number;
  color?: string;
}) {
  const clamped = Math.max(0, Math.min(100, progress));
  const gradientId = `shield-fill-${Math.round(clamped)}-${size}`;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 40 44" width={size} height={size}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="1" x2="0" y2="0">
            <stop offset={`${clamped}%`} stopColor={color} />
            <stop offset={`${clamped}%`} stopColor="transparent" />
          </linearGradient>
        </defs>
        {/* track */}
        <path
          d="M20 1 L37 8 V21 C37 32 30 39.5 20 43 C10 39.5 3 32 3 21 V8 Z"
          fill="rgba(255,255,255,0.04)"
          stroke="rgba(255,255,255,0.12)"
          strokeWidth="1.2"
        />
        {/* fill */}
        <path
          d="M20 1 L37 8 V21 C37 32 30 39.5 20 43 C10 39.5 3 32 3 21 V8 Z"
          fill={`url(#${gradientId})`}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-mono text-[11px] font-medium text-ink-100">
        {Math.round(clamped)}
      </span>
    </div>
  );
}
