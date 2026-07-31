/**
 * A short haptic tick, where the platform allows one.
 *
 * **This is best-effort and silently does nothing on most setups.** Read that
 * before wiring it to anything whose feedback matters — it is a garnish on top
 * of a visual state change, never the only signal that something happened.
 *
 * Two mechanisms, because no single one covers the devices Operator runs on:
 *
 * - **`navigator.vibrate`** — the actual standard. Android and desktop Chrome
 *   implement it. Safari does not, on any platform, which means it is exactly
 *   useless on the owner's iPhone.
 * - **A hidden `<input type="checkbox" switch>`** — iOS 17.4+ gives that
 *   control a real haptic tick when it is toggled, and toggling one off-screen
 *   is the only way anybody has found to reach the Taptic engine from a web
 *   page. It is undocumented, unsupported, and Apple may remove it without
 *   noting anything; if it stops working the failure is simply silence.
 *
 * The switch is created once and reused — appending and removing an element per
 * tap is more DOM churn than a haptic is worth.
 */

let toggle: HTMLInputElement | null = null;

function iosSwitch(): HTMLInputElement | null {
  if (typeof document === "undefined") return null;
  if (toggle) return toggle;

  const el = document.createElement("input");
  el.type = "checkbox";
  el.setAttribute("switch", ""); // the attribute is what makes iOS treat it as a switch
  // Kept in the layout but invisible and untouchable. `display: none` and
  // `visibility: hidden` both stop iOS running the control's haptic, so it has
  // to remain rendered — just nowhere anyone can see or reach it.
  el.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0;padding:0;margin:0;";
  el.setAttribute("aria-hidden", "true");
  el.tabIndex = -1;
  document.body.appendChild(el);
  toggle = el;
  return el;
}

/**
 * Fire a tick. Safe to call anywhere, including on devices with no haptics at
 * all — every path is guarded and failure is a no-op, never a throw.
 */
export function tick() {
  try {
    const vibrate = typeof navigator !== "undefined" && navigator.vibrate?.bind(navigator);
    if (vibrate) {
      vibrate(8);
      return;
    }
    iosSwitch()?.click();
  } catch {
    /* No haptics here. Nothing about that is worth interrupting a gesture for. */
  }
}
