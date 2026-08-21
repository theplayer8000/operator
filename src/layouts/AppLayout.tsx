import { Outlet, useLocation } from "react-router-dom";
import Sidebar from "@/components/layout/Sidebar";
import Topbar from "@/components/layout/Topbar";
import CommandPalette from "@/components/command/CommandPalette";
import PullToSearch from "@/components/command/PullToSearch";
import UpdateBanner from "@/components/layout/UpdateBanner";
import JobToast from "@/components/layout/JobToast";
import { useJobAlerts } from "@/hooks/useJobAlerts";

export default function AppLayout() {
  const location = useLocation();
  /*
    Job alerts live here rather than on the Orchestrator page, because the
    moment they matter is the moment you are somewhere else. A job outlives the
    page that started it, so a question could otherwise sit unanswered — holding
    the runner open — while you read the Dashboard.

    Whether you are already on that page is passed down so a finished job does
    not announce itself to someone watching it finish.
  */
  const alerts = useJobAlerts(location.pathname === "/orchestrator");

  return (
    <div className="flex min-h-screen bg-base-900">
      <Sidebar alertCount={alerts.asking} />
      <div className="flex-1 min-w-0">
        <Topbar />
        {/*
          The bottom padding is deliberately larger than the top and carries the
          home-indicator inset. On a long page — Daily Routine, Calendar — the
          last row otherwise ends flush with the bottom of the display, half
          under the indicator, and reads as content that has been cut off.
        */}
        <main className="px-4 sm:px-6 pt-5 sm:pt-6 pb-[calc(3rem+env(safe-area-inset-bottom))] max-w-[1400px] mx-auto">
          <Outlet />
        </main>
      </div>
      <PullToSearch />
      <CommandPalette />
      {/* Offers a reload when dist/ is newer than this bundle — see the file. */}
      <UpdateBanner />
      {alerts.toast && (
        <JobToast
          alert={alerts.toast}
          onDismiss={alerts.dismiss}
          canAsk={alerts.canAsk}
          onEnableNotifications={() => void alerts.enableNotifications()}
        />
      )}
    </div>
  );
}
