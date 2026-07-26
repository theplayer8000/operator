import { useEffect, useState } from "react";

const COLORS = ["#E8B04D", "#8D7FE0", "#4FB477", "#F5C567"];

interface Piece {
  id: number;
  left: number;
  rotate: number;
  color: string;
  delay: number;
}

/** Fires a short-lived confetti burst. Mount with a `key` change to re-trigger. */
export default function Confetti() {
  const [pieces] = useState<Piece[]>(() =>
    Array.from({ length: 18 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      rotate: Math.random() * 360,
      color: COLORS[i % COLORS.length],
      delay: Math.random() * 0.15,
    }))
  );

  return (
    <div className="pointer-events-none fixed inset-0 z-[60] overflow-hidden">
      {pieces.map((p) => (
        <span
          key={p.id}
          className="absolute top-1/3 w-1.5 h-3 rounded-sm animate-[confetti-fall_0.9s_ease-in_forwards]"
          style={{
            left: `${p.left}%`,
            backgroundColor: p.color,
            transform: `rotate(${p.rotate}deg)`,
            animationDelay: `${p.delay}s`,
          }}
        />
      ))}
      <style>{`
        @keyframes confetti-fall {
          0% { transform: translateY(0) rotate(0deg); opacity: 1; }
          100% { transform: translateY(220px) rotate(340deg); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
