import { useEffect } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Repeat,
  Swords,
  CalendarDays,
  Server,
  GraduationCap,
  Dumbbell,
  LineChart,
  Briefcase,
  Map,
  BarChart3,
  ScrollText,
  Compass,
  Terminal,
  Settings,
  ChevronsLeft,
  ChevronsRight,
  X,
} from "lucide-react";
import { useTheme } from "@/context/ThemeContext";

const NAV_ITEMS = [
  { to: "/contents", label: "Contents", icon: Compass },
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/routine", label: "Daily Routine", icon: Repeat },
  { to: "/missions", label: "Mission Board", icon: Swords },
  { to: "/events", label: "Events", icon: CalendarDays },
  { to: "/homelab", label: "Homelab", icon: Server },
  { to: "/learning", label: "Learning", icon: GraduationCap },
  { to: "/gym", label: "Gym", icon: Dumbbell },
  { to: "/forex", label: "Forex", icon: LineChart },
  { to: "/work", label: "Work", icon: Briefcase },
  { to: "/journey", label: "Journey", icon: Map },
  { to: "/statistics", label: "Statistics", icon: BarChart3 },
  { to: "/log", label: "Activity Log", icon: ScrollText },
];

/**
 * Desktop: a persistent rail, collapsible to icons.
 * Mobile (<lg): a drawer over the content, opened from the Topbar.
 *
 * Two different behaviours behind one component because the nav is the same
 * nav — what changes is whether the viewport can afford 232px of permanent
 * chrome. On a 390px phone it cannot.
 */
export default function Sidebar() {
  const { sidebarCollapsed, toggleSidebar, mobileNavOpen, setMobileNavOpen } = useTheme();
  const location = useLocation();

  // Navigating should always dismiss the drawer, or the user lands on a page
  // they can't see.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname, setMobileNavOpen]);

  // Escape closes it, and a locked body stops the page scrolling underneath.
  useEffect(() => {
    if (!mobileNavOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMobileNavOpen(false);
    }
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [mobileNavOpen, setMobileNavOpen]);

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `group flex items-center gap-3 px-3 min-h-[44px] rounded-badge text-sm transition-colors ${
      isActive ? "bg-base-800 text-ink-100" : "text-ink-500 hover:text-ink-300 hover:bg-base-800/60"
    }`;

  return (
    <>
      {/* Scrim — mobile only */}
      {mobileNavOpen && (
        <div
          onClick={() => setMobileNavOpen(false)}
          aria-hidden
          className="lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        />
      )}

      <aside
        className={`
          bg-base-950 border-r border-base-600 flex flex-col
          fixed inset-y-0 left-0 z-50 w-[264px] transition-transform duration-200
          ${mobileNavOpen ? "translate-x-0" : "-translate-x-full"}
          lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:translate-x-0 lg:shrink-0
          lg:transition-all ${sidebarCollapsed ? "lg:w-[72px]" : "lg:w-[232px]"}
        `}
      >
        <div className="h-16 flex items-center px-4 border-b border-base-600 shrink-0">
          <div className="w-7 h-7 rounded-badge bg-xp/15 border border-xp/30 flex items-center justify-center text-xp font-display font-semibold text-sm shrink-0">
            Ω
          </div>
          <span
            className={`ml-2.5 font-display font-semibold text-ink-100 tracking-tight ${
              sidebarCollapsed ? "lg:hidden" : ""
            }`}
          >
            Operator
          </span>
          <button
            onClick={() => setMobileNavOpen(false)}
            aria-label="Close navigation"
            className="lg:hidden ml-auto w-11 h-11 -mr-2 flex items-center justify-center text-ink-500 hover:text-ink-100 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto scrollbar-none">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={navLinkClass}
              title={sidebarCollapsed ? label : undefined}
            >
              {({ isActive }) => (
                <>
                  <Icon
                    size={17}
                    strokeWidth={2}
                    className={`shrink-0 ${
                      isActive ? "text-xp" : "text-ink-500 group-hover:text-ink-300"
                    }`}
                  />
                  <span className={`truncate ${sidebarCollapsed ? "lg:hidden" : ""}`}>{label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="p-2 border-t border-base-600 space-y-0.5 shrink-0">
          <NavLink to="/dev" className={navLinkClass}>
            <Terminal size={17} className="shrink-0" />
            <span className={sidebarCollapsed ? "lg:hidden" : ""}>Dev</span>
          </NavLink>
          <NavLink to="/settings" className={navLinkClass}>
            <Settings size={17} className="shrink-0" />
            <span className={sidebarCollapsed ? "lg:hidden" : ""}>Settings</span>
          </NavLink>
          <button
            onClick={toggleSidebar}
            className="hidden lg:flex w-full items-center gap-3 px-3 min-h-[44px] rounded-badge text-sm text-ink-700 hover:text-ink-300 hover:bg-base-800/60 transition-colors"
          >
            {sidebarCollapsed ? (
              <ChevronsRight size={17} className="shrink-0" />
            ) : (
              <ChevronsLeft size={17} className="shrink-0" />
            )}
            <span className={sidebarCollapsed ? "lg:hidden" : ""}>Collapse</span>
          </button>
        </div>
      </aside>
    </>
  );
}
