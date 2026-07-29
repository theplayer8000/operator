import { Navigate, Route, Routes } from "react-router-dom";
import AppLayout from "@/layouts/AppLayout";
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
import ComingSoon from "@/pages/ComingSoon";
import NotFound from "@/pages/NotFound";
import Gym from "@/pages/Gym";

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/routine" element={<DailyRoutine />} />
        <Route path="/missions" element={<MissionBoard />} />
        <Route path="/missions/:id" element={<MissionDetail />} />
        <Route path="/calendar" element={<Events />} />
        <Route path="/homelab" element={<Homelab />} />
        <Route path="/log" element={<ActivityLog />} />
        <Route path="/contents" element={<Contents />} />
        <Route path="/dev" element={<Dev />} />
        <Route path="/learning" element={<ComingSoon title="Learning" />} />
        <Route path="/gym" element={<Gym />} />
        <Route path="/forex" element={<ComingSoon title="Forex Journal" />} />
        <Route path="/work" element={<ComingSoon title="Work" />} />
        <Route path="/journey" element={<ComingSoon title="Journey" />} />
        <Route path="/statistics" element={<ComingSoon title="Statistics" />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/updates" element={<Updates />} />

        {/*
          Renamed routes keep working. A phone left open on /events after the
          v12 rename rendered a blank page — no matched route, nothing drawn,
          indistinguishable from the server being down. Redirect rather than
          404 so an old bookmark or a backgrounded tab just lands correctly.
        */}
        <Route path="/events" element={<Navigate to="/calendar" replace />} />

        {/*
          Catch-all. Without this, any unmatched path renders an empty page —
          which is what made the rename look like an outage. Never remove it.
        */}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
