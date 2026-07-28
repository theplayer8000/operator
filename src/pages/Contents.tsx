import { Link } from "react-router-dom";
import {
  LayoutDashboard,
  Repeat,
  Swords,
  Server,
  GraduationCap,
  Dumbbell,
  LineChart,
  Briefcase,
  Map as MapIcon,
  BarChart3,
  ScrollText,
  Settings,
  BookOpen,
  Scale,
  Compass,
  type LucideIcon,
} from "lucide-react";

type Status = "built" | "planned" | "concept";

interface Section {
  to?: string;
  label: string;
  icon: LucideIcon;
  status: Status;
  blurb: string;
}

/**
 * The index of Operator — what exists, what is coming, and what each part is
 * for. Deliberately hand-written rather than derived from the route table:
 * routes know paths, not purpose, and the purpose is the point of this page.
 * Keep it in step with docs/roadmap.md.
 */
const SECTIONS: Section[] = [
  {
    to: "/",
    label: "Dashboard",
    icon: LayoutDashboard,
    status: "built",
    blurb: "The daily glance — focus, tasks, streaks, goals and recent activity.",
  },
  {
    to: "/routine",
    label: "Daily Routine",
    icon: Repeat,
    status: "built",
    blurb: "The shape of a day, morning through sleep. Repeating steps reset each day.",
  },
  {
    to: "/missions",
    label: "Mission Board",
    icon: Swords,
    status: "built",
    blurb: "Long-running efforts with milestones, dependencies and their own history.",
  },
  {
    to: "/homelab",
    label: "Homelab",
    icon: Server,
    status: "built",
    blurb: "Every service running on the box, with a live up/down check and a way in.",
  },
  {
    to: "/log",
    label: "Activity Log",
    icon: ScrollText,
    status: "built",
    blurb: "Everything that has happened, merged from every feature and grouped by day.",
  },
  {
    to: "/learning",
    label: "Learning",
    icon: GraduationCap,
    status: "planned",
    blurb: "Skill and topic progress over time. Missions already point here.",
  },
  {
    to: "/gym",
    label: "Gym",
    icon: Dumbbell,
    status: "planned",
    blurb: "Training log — separate from the routine's daily gym checklist.",
  },
  {
    to: "/forex",
    label: "Forex",
    icon: LineChart,
    status: "planned",
    blurb: "A study and observation journal. Learning the market, not trading it.",
  },
  {
    to: "/work",
    label: "Work",
    icon: Briefcase,
    status: "planned",
    blurb: "GEH NHS and Darams work tracking.",
  },
  {
    to: "/journey",
    label: "Journey",
    icon: MapIcon,
    status: "planned",
    blurb: "The long-term roadmap missions ladder up to. The top of the hierarchy.",
  },
  {
    to: "/statistics",
    label: "Statistics",
    icon: BarChart3,
    status: "planned",
    blurb: "Aggregate view across every feature.",
  },
  {
    to: "/settings",
    label: "Settings",
    icon: Settings,
    status: "built",
    blurb: "Export, import, reset and storage location. The route to a backup.",
  },
  {
    label: "Knowledge Vault",
    icon: BookOpen,
    status: "concept",
    blurb: "A personal wiki — notes, commands and resources per topic.",
  },
  {
    label: "Decision Log",
    icon: Scale,
    status: "concept",
    blurb: "Decisions, their reasoning, and how they actually turned out.",
  },
];

const STATUS_META: Record<Status, { label: string; dot: string; text: string }> = {
  built: { label: "Built", dot: "bg-vital-up", text: "text-ink-300" },
  planned: { label: "Planned", dot: "bg-rank", text: "text-ink-500" },
  concept: { label: "Concept", dot: "bg-ink-700", text: "text-ink-700" },
};

function SectionRow({ section }: { section: Section }) {
  const { icon: Icon, status } = section;
  const meta = STATUS_META[status];

  const inner = (
    <>
      <span
        className={`w-9 h-9 shrink-0 rounded-badge border flex items-center justify-center ${
          status === "built"
            ? "bg-xp/10 border-xp/25 text-xp"
            : "bg-base-700/40 border-base-600 text-ink-700"
        }`}
      >
        <Icon size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className={`text-sm ${status === "concept" ? "text-ink-500" : "text-ink-100"}`}>
            {section.label}
          </span>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${meta.dot}`} />
          <span className="text-[11px] font-mono text-ink-700">{meta.label}</span>
        </span>
        <span className={`block text-xs mt-0.5 ${meta.text}`}>{section.blurb}</span>
      </span>
    </>
  );

  const shared = "flex items-start gap-3 p-3 min-h-[44px] rounded-badge transition-colors";

  return section.to ? (
    <Link to={section.to} className={`${shared} hover:bg-base-700/50`}>
      {inner}
    </Link>
  ) : (
    <div className={`${shared} opacity-70`}>{inner}</div>
  );
}

export default function Contents() {
  const built = SECTIONS.filter((s) => s.status === "built");
  const planned = SECTIONS.filter((s) => s.status === "planned");
  const concept = SECTIONS.filter((s) => s.status === "concept");

  return (
    <div className="max-w-2xl mx-auto lg:mx-0">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 shrink-0 rounded-badge bg-xp/10 border border-xp/25 flex items-center justify-center text-xp">
          <Compass size={18} />
        </div>
        <div className="min-w-0">
          <h1 className="font-display text-lg text-ink-100 leading-tight">Contents</h1>
          <p className="text-xs text-ink-500">
            {built.length} built · {planned.length} planned · {concept.length} concept
          </p>
        </div>
      </div>

      <p className="text-sm text-ink-500 mb-5 leading-relaxed">
        Tasks contribute to missions. Missions contribute to a long-term roadmap. Every section
        below is a view onto that at a different time horizon.
      </p>

      <div className="space-y-5">
        {[
          { title: "Built", items: built },
          { title: "Planned", items: planned },
          { title: "Concept", items: concept },
        ].map(({ title, items }) => (
          <section key={title} className="card-base p-4 sm:p-5 animate-fade-up">
            <header className="flex items-baseline justify-between mb-2 pb-2 border-b border-base-600">
              <h2 className="font-display text-sm text-ink-100">{title}</h2>
              <span className="text-xs font-mono text-ink-700">{items.length}</span>
            </header>
            <div className="space-y-0.5">
              {items.map((s) => (
                <SectionRow key={s.label} section={s} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
