import { Outlet } from "react-router-dom";
import Sidebar from "@/components/layout/Sidebar";
import Topbar from "@/components/layout/Topbar";
import CommandPalette from "@/components/command/CommandPalette";

export default function AppLayout() {
  return (
    <div className="flex min-h-screen bg-base-900">
      <Sidebar />
      <div className="flex-1 min-w-0">
        <Topbar />
        <main className="px-4 sm:px-6 py-5 sm:py-6 max-w-[1400px] mx-auto">
          <Outlet />
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}
