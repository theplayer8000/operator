import { Link, useLocation } from "react-router-dom";
import { Compass, Home } from "lucide-react";

/**
 * The catch-all. Its absence is what made the v12 `/events` → `/calendar`
 * rename look like the server was down: an unmatched route rendered nothing
 * at all, which on a phone is indistinguishable from a failed load.
 *
 * So this page's first job is to *look like the app* — if it's showing, the
 * app is fine and only the address is wrong.
 */
export default function NotFound() {
  const { pathname } = useLocation();

  return (
    <div className="max-w-lg mx-auto lg:mx-0 py-10">
      <div className="card-base p-5 sm:p-6 animate-fade-up">
        <p className="font-mono text-xs text-ink-700 mb-2">404</p>
        <h1 className="font-display text-lg text-ink-100 mb-2">Nothing at this address</h1>
        <p className="text-sm text-ink-500 leading-relaxed mb-1">
          Operator is running fine — there's just no page at{" "}
          <span className="font-mono text-ink-300 break-all">{pathname}</span>.
        </p>
        <p className="text-xs text-ink-700 leading-relaxed mb-5">
          If you got here from a bookmark, the page may have been renamed.
        </p>

        <div className="flex flex-wrap gap-2">
          <Link
            to="/dashboard"
            className="inline-flex items-center gap-2 px-4 min-h-[44px] rounded-badge bg-xp text-base-950 text-sm font-medium hover:bg-xp-bright transition-colors"
          >
            <Home size={15} /> Dashboard
          </Link>
          <Link
            to="/contents"
            className="inline-flex items-center gap-2 px-4 min-h-[44px] rounded-badge border border-base-600 text-sm text-ink-300 hover:text-ink-100 hover:border-base-500 transition-colors"
          >
            <Compass size={15} /> Everything in Operator
          </Link>
        </div>
      </div>
    </div>
  );
}
