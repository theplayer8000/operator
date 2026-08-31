import { useEffect, useRef, useState } from "react";
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
  Orbit,
  Terminal,
  ClipboardList,
  Settings,
  ChevronsLeft,
  ChevronsRight,
  X,
  MessageSquare,
} from "lucide-react";
import { useTheme } from "@/context/ThemeContext";

/**
 * Ordered by build state, not by category: everything built comes first, in
 * rough order of how often it's opened, then everything unbuilt in the order
 * it's planned to be built. So the nav doubles as a roadmap — the first
 * `ComingSoon` you hit is the next thing being made.
 *
 * Keep this in step with the status table in CLAUDE.md and `/contents`. When a
 * feature ships, move it up into the built group rather than leaving it in
 * place.
 */
const NAV_ITEMS = [
  { to: "/contents", label: "Contents", icon: Compass },

  // Built — daily use first
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  /*
    The only route to /map used to be a link inside the Dashboard's graph card,
    which is gated to screens 1024px and wider — so on a phone there was no way
    to reach it at all, and the owner reported exactly that. It needs a nav
    entry like everything else.
  */
  { to: "/", label: "Operator", icon: Orbit },
  { to: "/orchestrator", label: "Orchestrator", icon: MessageSquare },
  { to: "/routine", label: "Daily Routine", icon: Repeat },
  { to: "/calendar", label: "Calendar", icon: CalendarDays },
  { to: "/gym", label: "Gym", icon: Dumbbell },
  { to: "/missions", label: "Mission Board", icon: Swords },
  { to: "/homelab", label: "Homelab", icon: Server },
  { to: "/log", label: "Activity Log", icon: ScrollText },

  // Not built — in planned build order
  { to: "/learning", label: "Learning", icon: GraduationCap },
  { to: "/forex", label: "Forex", icon: LineChart },
  { to: "/work", label: "Work", icon: Briefcase },
  { to: "/journey", label: "Journey", icon: Map },
  { to: "/statistics", label: "Statistics", icon: BarChart3 },
];

const DRAWER_W = 264; // must match the w-[264px] on the <aside> below

/**
 * Where an opening swipe may start — a band, not "the edge".
 *
 * **It deliberately does not touch the screen edge, and that is the fix for a
 * real bug.** iOS Safari owns roughly the first 20px for its back-navigation
 * gesture, so an open-zone starting at 0 raced the OS: sometimes the drawer
 * opened, sometimes the page navigated back, and when iOS won it swallowed the
 * gesture entirely — no `touchend` ever reached this component, `drag` stayed
 * non-null, and the scrim (which renders while `drag !== null`) stuck on screen
 * until the app was reloaded. Both reported symptoms, one cause.
 *
 * Starting at `EDGE_SKIP` cedes that band to the browser and takes the next
 * one. The hamburger button remains the primary way in, so a slightly less
 * reachable swipe costs little; fighting the OS for a gesture it will
 * sometimes win costs a stuck UI.
 */
const EDGE_SKIP = 24; // leave iOS's back-swipe band alone
const EDGE_ZONE = 80; // …and accept an opening swipe up to here
const COMMIT = 0.4; // how far across before letting go counts as "meant it"
const FLICK = 0.5; // px/ms — a fast flick commits regardless of distance

/**
 * Drag the drawer with a finger: swipe in from the left edge to open, swipe
 * left anywhere to close.
 *
 * Returns the drawer's live `translateX` in px while a drag is in progress
 * (`-DRAWER_W` closed → `0` open), or `null` when it isn't — in which case the
 * component's own classes and CSS transition take over for the snap.
 *
 * The fiddly parts, both of which are why this follows the finger rather than
 * just detecting a swipe at the end:
 *
 * - **The axis is decided once, after 8px.** A drawer that grabs every touch
 *   makes the page impossible to scroll. If the first movement is mostly
 *   vertical the gesture is abandoned outright and never reconsidered.
 * - **`touchmove` is registered non-passive** so it can `preventDefault`. That
 *   is the only way to stop iOS rubber-banding the page sideways underneath a
 *   horizontal drag, and it must be paired with the axis check above or it
 *   would also cancel legitimate vertical scrolling.
 *
 * Opening is edge-only on purpose: the drawer covers content that has its own
 * horizontal scrollers (the Gym day stepper, the routine timeline), and a
 * swipe-anywhere-to-open would fight them.
 */
function useDrawerSwipe(open: boolean, setOpen: (v: boolean) => void, pathname: string) {
  const [drag, setDrag] = useState<number | null>(null);
  const from = useRef<{ x: number; y: number; t: number; axis: "?" | "x" } | null>(null);

  /*
    Navigating mid-drag clears it.

    The drawer already closes on a route change, but that only resets
    `mobileNavOpen` — the scrim also renders while `drag !== null`, so a
    navigation that happened during a gesture (an accidental back-swipe, or a
    tap on a nav link as the finger lifted) left the overlay behind on a page
    that had already changed.
  */
  useEffect(() => {
    from.current = null;
    setDrag(null);
  }, [pathname]);

  useEffect(() => {
    function onStart(e: TouchEvent) {
      // Desktop keeps a permanent rail — there is no drawer to drag.
      if (window.innerWidth >= 1024) return;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (!open && (t.clientX < EDGE_SKIP || t.clientX > EDGE_ZONE)) return;
      from.current = { x: t.clientX, y: t.clientY, t: e.timeStamp, axis: "?" };
    }

    function onMove(e: TouchEvent) {
      const f = from.current;
      if (!f) return;
      const t = e.touches[0];
      const dx = t.clientX - f.x;
      const dy = t.clientY - f.y;

      if (f.axis === "?") {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (Math.abs(dy) >= Math.abs(dx)) {
          from.current = null; // vertical — hand it back to the page
          return;
        }
        f.axis = "x";
      }

      e.preventDefault();
      setDrag(Math.max(-DRAWER_W, Math.min(0, (open ? 0 : -DRAWER_W) + dx)));
    }

    function onEnd(e: TouchEvent) {
      const f = from.current;
      from.current = null;
      if (!f || f.axis !== "x") return;

      const dx = (e.changedTouches[0]?.clientX ?? f.x) - f.x;
      const velocity = dx / Math.max(1, e.timeStamp - f.t);
      const offset = Math.max(-DRAWER_W, Math.min(0, (open ? 0 : -DRAWER_W) + dx));
      const progress = 1 + offset / DRAWER_W; // 0 closed → 1 open

      setDrag(null);
      if (velocity > FLICK) setOpen(true);
      else if (velocity < -FLICK) setOpen(false);
      else setOpen(progress > COMMIT);
    }

    /*
      A gesture can end without `touchend` ever reaching us — iOS taking over
      for back-navigation is the case that actually happened. `touchcancel`
      covers some of it and is not guaranteed, so anything that means "the
      gesture is over, however it ended" clears the drag too. Without this a
      stolen gesture leaves the scrim on screen until the app is reloaded.
    */
    function abandon() {
      from.current = null;
      setDrag(null);
    }

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });
    window.addEventListener("pagehide", abandon);
    window.addEventListener("blur", abandon);
    document.addEventListener("visibilitychange", abandon);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
      window.removeEventListener("pagehide", abandon);
      window.removeEventListener("blur", abandon);
      document.removeEventListener("visibilitychange", abandon);
    };
  }, [open, setOpen]);

  return drag;
}

/**
 * Desktop: a persistent rail, collapsible to icons.
 * Mobile (<lg): a drawer over the content, opened from the Topbar or by
 * swiping in from the left edge.
 *
 * Two different behaviours behind one component because the nav is the same
 * nav — what changes is whether the viewport can afford 232px of permanent
 * chrome. On a 390px phone it cannot.
 */
export default function Sidebar({ alertCount = 0 }: { alertCount?: number }) {
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

  const drag = useDrawerSwipe(mobileNavOpen, setMobileNavOpen, location.pathname);

  // `relative` so the alert badge can pin itself to the corner when the rail
  // is collapsed to icons and there is no label to sit beside.
  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `group relative flex items-center gap-3 px-3 min-h-[44px] rounded-badge text-sm transition-colors ${
      isActive ? "bg-base-800 text-ink-100" : "text-ink-500 hover:text-ink-300 hover:bg-base-800/60"
    }`;

  return (
    <>
      {/* Scrim — mobile only */}
      {(mobileNavOpen || drag !== null) && (
        <div
          onClick={() => setMobileNavOpen(false)}
          aria-hidden
          className="lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          // Fades with the drag so the scrim tracks the finger rather than
          // snapping to full black the moment a swipe starts.
          style={
            drag !== null
              ? { opacity: 1 + drag / DRAWER_W, transition: "none" }
              : undefined
          }
        />
      )}

      <aside
        className={`
          bg-base-950 border-r border-base-600 flex flex-col
          fixed inset-y-0 left-0 z-50 w-[264px] transition-transform duration-200
          pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]
          ${mobileNavOpen ? "translate-x-0" : "-translate-x-full"}
          lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:translate-x-0 lg:shrink-0
          lg:transition-all ${sidebarCollapsed ? "lg:w-[72px]" : "lg:w-[232px]"}
        `}
        // While dragging, the finger owns the position — the class-based
        // transform and its 200ms transition would fight it. Both come back on
        // release, which is what animates the snap.
        style={
          drag !== null
            ? { transform: `translateX(${drag}px)`, transition: "none" }
            : undefined
        }
      >
        <div className="h-16 flex items-center px-4 border-b border-base-600 shrink-0">
          <img
            src="/icon-192.png"
            alt=""
            aria-hidden
            className="w-7 h-7 rounded-badge shrink-0 object-cover"
          />
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
                  {/*
                    A question waiting on the Orchestrator, visible from every
                    page. Driven by the server's own `asking` count rather than
                    anything this session remembers, so it is still right after
                    a reload and on a second device.

                    Rendered even when the rail is collapsed to icons — that is
                    exactly when the label is gone and the dot is the only way
                    to know.
                  */}
                  {to === "/orchestrator" && alertCount > 0 && (
                    <span
                      title={`${alertCount} waiting on you`}
                      className={`ml-auto shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-xp text-base-950 text-[10px] font-mono font-medium flex items-center justify-center ${
                        sidebarCollapsed ? "lg:absolute lg:top-1 lg:right-1 lg:ml-0" : ""
                      }`}
                    >
                      {alertCount}
                    </span>
                  )}
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
          <NavLink to="/updates" className={navLinkClass}>
            <ClipboardList size={17} className="shrink-0" />
            <span className={sidebarCollapsed ? "lg:hidden" : ""}>Updates</span>
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
