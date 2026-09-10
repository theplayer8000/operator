import { Navigate, Route, Routes } from "react-router-dom";
import AppLayout from "@/layouts/AppLayout";
import { useShellControls } from "@/hooks/useShellControls";
import Dashboard from "@/pages/Dashboard";
import DailyRoutine from "@/pages/DailyRoutine";
import MissionBoard from "@/pages/MissionBoard";
import MissionDetail from "@/pages/MissionDetail";
import ActivityLog from "@/pages/ActivityLog";
import Homelab from "@/pages/Homelab";
import Settings from "@/pages/Settings";
import Events from "@/pages/Events";
import Updates from "@/pages/Updates";
import Contents from "@/pages/Contents";
import Dev from "@/pages/Dev";
import Health from "@/pages/Health";
import Orchestrator from "@/pages/Orchestrator";
import ComingSoon from "@/pages/ComingSoon";
import NotFound from "@/pages/NotFound";
import Gym from "@/pages/Gym";
import Knowledge from "@/pages/Knowledge";
import DecisionLog from "@/pages/DecisionLog";
import MissionMap from "@/pages/MissionMap";
import Statistics from "@/pages/Statistics";
import OperatorMobile from "@/pages/OperatorMobile";
import { useMediaQuery } from "@/hooks/useMediaQuery";

/**
 * `/map` is two different things depending on what is holding it.
 *
 * Chosen over rendering both and hiding one with CSS: the graph runs a physics
 * simulation every frame, and `display: none` would keep paying for it on a
 * phone that never shows it. Mounting one or the other means the cost follows
 * what is actually on screen.
 */
function MapSurface() {
  const bigScreen = useMediaQuery("(min-width: 1024px)");
  return bigScreen ? <MissionMap /> : <OperatorMobile />;
}

export default function App() {
  /*
    The desktop shell's tray toggles and Ctrl+Alt+M, wired up here rather than
    in AppLayout — the map surface is deliberately outside that layout, so
    putting them there would fix eleven routes by breaking the two that already
    worked. See `useShellControls`.
  */
  useShellControls();

  return (
    <Routes>
      {/*
        Outside AppLayout on purpose — no sidebar, no topbar.

        This is the wall display, and full bleed is not a style preference: a
        sidebar is what makes a room-scale map look like a web page. Escape
        returns to the Dashboard.

        `/map` resolves to a DIFFERENT surface on a phone — the core alone,
        plus chat. Not a shrunken graph: the owner has twice said the graph is
        big-screen only, and nine labelled nodes on a 390px screen is unreadable
        whatever you do to it. Same URL either way, so a link, a notification
        or a bookmark lands on whichever is right for the device holding it.
      */}
      <Route path="/" element={<MapSurface />} />
      {/* The old address keeps working, so bookmarks and links do not break. */}
      <Route path="/map" element={<MapSurface />} />

      <Route element={<AppLayout />}>
        {/*
          The Dashboard moved off "/" on 2026-08-31 — the map is the landing
          page now. It keeps everything else: sidebar, widgets, the lot.
        */}
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/routine" element={<DailyRoutine />} />
        {/*
          Two routes, ONE page. The parameter only decides which note is open,
          so "one page per feature" holds while a note still gets a real URL —
          which matters because the Mission Board links straight at one.
        */}
        <Route path="/knowledge" element={<Knowledge />} />
        <Route path="/knowledge/:id" element={<Knowledge />} />
        {/* Same one-page-two-routes shape as Knowledge — the id only decides
            which decision is open. Linked at from a mission's Related Decisions
            tab. */}
        <Route path="/decisions" element={<DecisionLog />} />
        <Route path="/decisions/:id" element={<DecisionLog />} />
        <Route path="/missions" element={<MissionBoard />} />
        <Route path="/missions/:id" element={<MissionDetail />} />
        <Route path="/calendar" element={<Events />} />
        <Route path="/homelab" element={<Homelab />} />
        <Route path="/log" element={<ActivityLog />} />
        <Route path="/contents" element={<Contents />} />
        <Route path="/orchestrator" element={<Orchestrator />} />
        <Route path="/dev" element={<Dev />} />
        {/*
          Beside /dev rather than inside it. The Dev page is where you go to
          look at something; this is where you go to be TOLD something, and a
          card at the bottom of a page nobody opens is the same as no check.
        */}
        <Route path="/health" element={<Health />} />
        <Route path="/learning" element={<ComingSoon title="Learning" />} />
        <Route path="/gym" element={<Gym />} />
        <Route path="/forex" element={<ComingSoon title="Forex Journal" />} />
        <Route path="/work" element={<ComingSoon title="Work" />} />
        <Route path="/journey" element={<ComingSoon title="Journey" />} />
        <Route path="/statistics" element={<Statistics />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/updates" element={<Updates />} />

        {/*
          Renamed routes keep working. A phone left open on /events after the
          v12 rename rendered a blank page — no matched route, nothing drawn,
          indistinguishable from the server being down. Redirect rather than
          404 so an old bookmark or a backgrounded tab just lands correctly.
        */}
        <Route path="/events" element={<Navigate to="/calendar" replace />} />
        <Route path="/chat" element={<Navigate to="/orchestrator" replace />} />

        {/*
          Catch-all. Without this, any unmatched path renders an empty page —
          which is what made the rename look like an outage. Never remove it.
        */}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
