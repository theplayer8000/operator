import { useCallback } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import Sidebar from "@/components/layout/Sidebar";
import Topbar from "@/components/layout/Topbar";
import CommandPalette from "@/components/command/CommandPalette";
import PullToSearch from "@/components/command/PullToSearch";
import UpdateBanner from "@/components/layout/UpdateBanner";
import JobToast from "@/components/layout/JobToast";
import { useJobAlerts } from "@/hooks/useJobAlerts";
import { useClapListener } from "@/hooks/useClapListener";
import { useMediaQuery } from "@/hooks/useMediaQuery";

export default function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  /*
    Job alerts live here rather than on the Orchestrator page, because the
    moment they matter is the moment you are somewhere else. A job outlives the
    page that started it, so a question could otherwise sit unanswered — holding
    the runner open — while you read the Dashboard.

    Whether you are already on that page is passed down so a finished job does
    not announce itself to someone watching it finish.
  */
  const alerts = useJobAlerts(location.pathname === "/orchestrator");

  /*
    Two claps brings Operator to the front.

    Lives here rather than on a page for the same reason job alerts do: the
    moment it matters is the moment you are somewhere else — and a listener
    that only works while you are already looking at the graph is a listener
    that has nothing to do.

    Desk only, per the device split in presence-layer-design.md. Not a taste
    call: a phone in a pocket with an open microphone is a different proposition
    to a desktop the owner is sitting at, and the graph it navigates to is not
    built for a phone anyway.
  */
  const bigScreen = useMediaQuery("(min-width: 1024px)");
  const onDoubleClap = useCallback(() => {
    /*
      Pause whatever is playing, on the way past. A page cannot do this — see
      the media_play_pause action — so it goes through the server, and it is
      fire-and-forget: failing to pause Spotify must not stop Operator coming
      to the front, which is the part that was actually asked for.
    */
    /*
      Both are fire-and-forget, and both are best-effort: failing to pause
      Spotify or to raise the window must not stop the navigation, which is the
      part that always works and the part actually asked for.

      Order matters slightly — pause first, because the window coming forward is
      what the eye follows and it should not arrive over the top of music still
      playing.
    */
    const act = (action: string) =>
      fetch("/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, params: {} }),
      }).catch(() => {});

    void act("media_play_pause");
    void act("focus_operator");
    navigate("/");
  }, [navigate]);

  const clap = useClapListener(onDoubleClap, !bigScreen);

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
      {/*
        The clap toggle sits on screen rather than in Settings, deliberately.
        Arming a microphone is the kind of state you should be able to see and
        end from wherever you are — burying it behind a settings page means the
        only way to know it is on is the browser's own recording indicator.

        Desk only, and hidden entirely where the browser cannot do it at all,
        which at a bare tailnet IP it cannot.
      */}
      {bigScreen && clap.supported && (
        <button
          onClick={() => clap.setEnabled(!clap.enabled)}
          title={
            clap.reason ??
            (clap.enabled
              ? "Listening for a double clap — click to stop"
              : "Clap twice to bring Operator to the front. Opens the microphone; no audio is recorded or sent.")
          }
          aria-label={clap.enabled ? "Stop listening for claps" : "Listen for a double clap"}
          className={`fixed bottom-4 right-4 z-30 flex items-center gap-2 h-10 px-3 rounded-badge border text-[11px] transition-colors ${
            clap.reason
              ? "border-vital-down/40 bg-vital-down/10 text-vital-down"
              : clap.listening
                ? "border-xp/40 bg-xp/10 text-xp"
                : "border-base-600 bg-base-800 text-ink-700 hover:text-ink-300"
          }`}
        >
          <span className="flex items-center gap-0.5" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={`w-1 rounded-full bg-current ${clap.listening ? "animate-breathe" : ""}`}
                style={{ height: 6 + i * 3, animationDelay: `${i * 0.2}s` }}
              />
            ))}
          </span>
          {clap.reason ? "mic unavailable" : clap.listening ? "listening" : "clap to summon"}
        </button>
      )}

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
