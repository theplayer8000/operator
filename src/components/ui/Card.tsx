import type { ReactNode } from "react";

interface CardProps {
  title?: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  span?: 1 | 2 | 3;
}

const SPAN_CLASS: Record<number, string> = {
  1: "lg:col-span-1",
  2: "lg:col-span-2",
  3: "lg:col-span-3",
};

export default function Card({ title, icon, action, children, className = "", span = 1 }: CardProps) {
  return (
    <section
      className={`card-base p-4 sm:p-5 flex flex-col min-w-0 animate-fade-up ${SPAN_CLASS[span]} ${className}`}
    >
      {title && (
        <header className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            {icon && <span className="text-ink-500">{icon}</span>}
            <h3 className="font-display text-sm font-medium text-ink-300 tracking-wide">
              {title}
            </h3>
          </div>
          {action}
        </header>
      )}
      <div className="flex-1 min-h-0">{children}</div>
    </section>
  );
}
