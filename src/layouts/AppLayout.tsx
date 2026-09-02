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
      Summon, and NOTHING else.

      Three stale comments used to sit here describing a version that also
      pressed the media play/pause key, first as a second call and then folded
      into the summon script. Both are gone — `focusOperator` in actions.mjs
      states plainly that summoning never touches what is playing, after the
      owner's verdict: "remove the media play thing i'll just pause it myself."
      A gesture that does two things when you asked for one is surprising, and
      the surprising half was reaching into whatever held the media session.

      Left as a note rather than deleted because the comments outlived the code
      by two revisions and sent a later session hunting for a media key press
      that was not there.

      Fire-and-forget: failing to raise the window must not stop the navigation,
      which is the part that always works.
    */
    void fetch("/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "focus_operator", params: {} }),
    }).catch(() => {});
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
      {bigScreen && (
        <button
          onClick={() => clap.supported && clap.setEnabled(!clap.enabled)}
          disabled={!clap.supported}
          title={
            clap.reason ??
            (clap.enabled
              ? "Listening for a double clap — click to stop"
              : "Clap twice to bring Operator to the front. Opens the microphone; no audio is recorded or sent.")
          }
          aria-label={clap.enabled ? "Stop listening for claps" : "Listen for a double clap"}
          className={`fixed bottom-4 right-4 z-30 flex items-center gap-2 h-10 px-3 rounded-badge border text-[11px] transition-colors max-w-[280px] ${
            clap.reason
              ? "border-vital-down/40 bg-vital-down/10 text-vital-down cursor-help"
              : clap.listening
                ? "border-xp/40 bg-xp/10 text-xp"
                : "border-base-600 bg-base-800 text-ink-700 hover:text-ink-300"
          }`}
        >
          {/*
            A live level meter, not a decorative pulse.

            "Clapping does nothing" has three causes that look identical from
            outside: the mic is not open, the mic is open and hears nothing, or
            it hears you and the threshold is too high. Only the last is a
            number anyone can change, and without a meter there is no way to
            tell which one you have — which is exactly how this got debugged by
            guessing a threshold.

            The notch is the bar a clap has to beat. If the meter moves when you
            clap but never reaches the notch, the number is wrong; if it does
            not move at all, the microphone is.
          */}
          {clap.listening ? (
            <span className="relative flex items-end gap-[2px] h-4 w-8 shrink-0" aria-hidden>
              {[0, 1, 2, 3, 4].map((i) => {
                const lit = clap.level > (i + 1) / 6;
                return (
                  <span
                    key={i}
                    className={`w-1 rounded-full transition-all duration-100 ${
                      lit ? "bg-current" : "bg-current/20"
                    }`}
                    style={{ height: `${30 + i * 17}%` }}
                  />
                );
              })}
              <span
                className="absolute inset-y-0 w-px bg-current/60"
                style={{ left: `${Math.min(100, clap.threshold * 100)}%` }}
              />
            </span>
          ) : (
            <span className="flex items-center gap-0.5" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="w-1 rounded-full bg-current"
                  style={{ height: 6 + i * 3 }}
                />
              ))}
            </span>
          )}
          {/*
            The reason IS the label when there is one. A generic "unavailable"
            with the detail hidden in a tooltip is how this went undiagnosed:
            the three causes — no https, no permission, no microphone — need
            three different fixes and look identical from outside.
          */}
          <span className="truncate">
            {clap.reason ??
              (clap.listening
                ? clap.claps > 0
                  ? `heard ${clap.claps}`
                  : "listening"
                : "clap to summon")}
          </span>
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
