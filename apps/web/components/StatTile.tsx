import type { ReactNode } from 'react';

interface Props {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Signed change. Direction is carried by the glyph and sign, not by color. */
  delta?: { text: string; direction: 'up' | 'down' | 'flat' } | undefined;
  hero?: boolean;
}

export function StatTile({ label, value, sub, delta, hero = false }: Props) {
  return (
    <div className="card">
      <div className="tile-label">{label}</div>
      <div className={hero ? 'tile-value tile-value--hero' : 'tile-value'}>{value}</div>
      {delta && (
        <div className={`delta delta--${delta.direction}`}>
          {/* The arrow is the non-color channel; red/green only reinforces it. */}
          <span aria-hidden="true">
            {delta.direction === 'up' ? '▲ ' : delta.direction === 'down' ? '▼ ' : '– '}
          </span>
          {delta.text}
        </div>
      )}
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}
