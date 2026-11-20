/**
 * The orbit ring: a campus geofence drawn to scale.
 * The inner filled ring is the check-in zone; dots are people placed by their real distance
 * from the campus center (direction is decorative — we only know distance).
 */
const SIZE = 300;
const C = SIZE / 2;
const MAX_R = 128;

function angleFor(id = '') {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 360) * (Math.PI / 180);
}

export function formatDistance(m) {
  if (m == null) return '';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

export function Orbit({ radiusM, points = [], you, label, compact }) {
  const farthest = Math.max(radiusM, ...points.map((p) => p.distance ?? 0), you?.distance ?? 0);
  // Show the fence at ~62% of the drawing unless someone is farther out (then clamp at 2.2× radius).
  const extent = Math.min(Math.max(radiusM * 1.6, farthest * 1.08), radiusM * 2.2);
  const scale = MAX_R / extent;
  const fenceR = radiusM * scale;
  const place = (d, id, fixedAngle) => {
    const clamped = Math.min(d, extent);
    const a = fixedAngle ?? angleFor(id);
    return { x: C + Math.cos(a) * clamped * scale, y: C + Math.sin(a) * clamped * scale, outside: d > extent };
  };

  return (
    <figure className={`orbit${compact ? ' compact' : ''}`}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={label ?? `Campus geofence, ${radiusM} metre radius`}>
        <circle cx={C} cy={C} r={MAX_R} className="orbit-outer" />
        <circle cx={C} cy={C} r={MAX_R * 0.75} className="orbit-guide" />
        <circle cx={C} cy={C} r={fenceR} className="orbit-zone" />
        <circle cx={C} cy={C} r={fenceR} className="orbit-fence" />
        <rect x={C - 7} y={C - 7} width="14" height="14" rx="3" className="orbit-campus" />
        <text x={C} y={C - fenceR - 8} className="orbit-label" textAnchor="middle">
          {formatDistance(radiusM)}
        </text>
        {points.map((p) => {
          if (p.distance == null) return null;
          const pos = place(p.distance, p.id);
          return (
            <g key={p.id} className={`orbit-dot dot-${p.status ?? 'none'}`} transform={`translate(${pos.x} ${pos.y})`}>
              <circle r="7" />
              <title>{`${p.label} · ${formatDistance(p.distance)}`}</title>
            </g>
          );
        })}
        {you ? (
          (() => {
            const pos = place(you.distance, 'you', -Math.PI / 4);
            const inside = you.inside;
            return (
              <g className={`orbit-you ${inside ? 'inside' : 'outside'}`} transform={`translate(${pos.x} ${pos.y})`}>
                {you.accuracy ? <circle r={Math.max(6, Math.min(you.accuracy * scale, 60))} className="orbit-accuracy" /> : null}
                <circle r="9" className="orbit-you-dot" />
                <text y="-15" textAnchor="middle" className="orbit-you-label">
                  {pos.outside ? `${formatDistance(you.distance)} away` : 'You'}
                </text>
              </g>
            );
          })()
        ) : null}
      </svg>
    </figure>
  );
}
