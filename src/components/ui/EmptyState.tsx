import type { ReactNode } from "react";

export default function EmptyState({
  icon,
  message,
}: {
  icon?: ReactNode;
  message: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-6 text-ink-700">
      {icon && <div className="mb-2 opacity-60">{icon}</div>}
      <p className="text-sm">{message}</p>
    </div>
  );
}
