import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Repeat,
  Swords,
  GraduationCap,
  Dumbbell,
  LineChart,
  Briefcase,
  Map,
  BarChart3,
  Settings,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { useTheme } from "@/context/ThemeContext";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/routine", label: "Daily Routine", icon: Repeat },
  { to: "/projects", label: "Projects", icon: Swords },
  { to: "/learning", label: "Learning", icon: GraduationCap },
  { to: "/gym", label: "Gym", icon: Dumbbell },
  { to: "/forex", label: "Forex", icon: LineChart },
  { to: "/work", label: "Work", icon: Briefcase },
  { to: "/journey", label: "Journey", icon: Map },
  { to: "/statistics", label: "Statistics", icon: BarChart3 },
];

export default function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useTheme();

  return (
    <aside
      className={`shrink-0 h-screen sticky top-0 border-r border-base-600 bg-base-950 flex flex-col transition-all duration-200 ${
        sidebarCollapsed ? "w-[72px]" : "w-[232px]"
      }`}
    >
      <div className="h-16 flex items-center px-4 border-b border-base-600">
        <div className="w-7 h-7 rounded-badge bg-xp/15 border border-xp/30 flex items-center justify-center text-xp font-display font-semibold text-sm">
          Ω
        </div>
        {!sidebarCollapsed && (
          <span className="ml-2.5 font-display font-semibold text-ink-100 tracking-tight">
            Operator
          </span>
        )}
      </div>

      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto scrollbar-none">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              `group flex items-center gap-3 px-3 py-2 rounded-badge text-sm transition-colors ${
                isActive
                  ? "bg-base-800 text-ink-100"
                  : "text-ink-500 hover:text-ink-300 hover:bg-base-800/60"
              }`
            }
            title={sidebarCollapsed ? label : undefined}
          >
            {({ isActive }) => (
              <>
                <Icon
                  size={17}
                  strokeWidth={2}
                  className={isActive ? "text-xp" : "text-ink-500 group-hover:text-ink-300"}
                />
                {!sidebarCollapsed && <span className="truncate">{label}</span>}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="p-2 border-t border-base-600 space-y-0.5">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2 rounded-badge text-sm transition-colors ${
              isActive ? "bg-base-800 text-ink-100" : "text-ink-500 hover:text-ink-300 hover:bg-base-800/60"
            }`
          }
        >
          <Settings size={17} />
          {!sidebarCollapsed && <span>Settings</span>}
        </NavLink>
        <button
          onClick={toggleSidebar}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-badge text-sm text-ink-700 hover:text-ink-300 hover:bg-base-800/60 transition-colors"
        >
          {sidebarCollapsed ? <ChevronsRight size={17} /> : <ChevronsLeft size={17} />}
          {!sidebarCollapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
