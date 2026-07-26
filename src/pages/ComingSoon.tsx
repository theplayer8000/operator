import { Construction } from "lucide-react";

export default function ComingSoon({ title }: { title: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-[70vh] text-center animate-fade-up">
      <div className="w-14 h-14 rounded-badge bg-base-800 border border-base-600 flex items-center justify-center mb-4">
        <Construction size={22} className="text-ink-500" />
      </div>
      <h2 className="font-display text-xl text-ink-100 mb-1">{title}</h2>
      <p className="text-ink-500 text-sm max-w-xs">
        This mission board isn't built yet — it lands in the next version.
      </p>
    </div>
  );
}
