import type { ReactNode } from "react";
import { Lock } from "lucide-react";

export default function ReservedSection({
  message,
  icon,
}: {
  message: string;
  icon?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 p-4 rounded-badge border border-dashed border-base-600 text-ink-700">
      <span className="shrink-0">{icon ?? <Lock size={15} />}</span>
      <p className="text-sm">{message}</p>
    </div>
  );
}
