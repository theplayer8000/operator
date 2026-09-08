import { useDashboardData } from "@/hooks/useDashboardData";
import TodayFocus from "@/components/dashboard/TodayFocus";
import TodayTasks from "@/components/dashboard/TodayTasks";
import CurrentMissions from "@/components/dashboard/CurrentMissions";
import WeeklyGoals from "@/components/dashboard/WeeklyGoals";
import ProjectProgress from "@/components/dashboard/ProjectProgress";
import CurrentStreaks from "@/components/dashboard/CurrentStreaks";
import UpcomingEvents from "@/components/dashboard/UpcomingEvents";
import QuickNotes from "@/components/dashboard/QuickNotes";
import RecentActivity from "@/components/dashboard/RecentActivity";
import MissionStatusChart from "@/components/dashboard/MissionStatusChart";
import HomelabStatus from "@/components/dashboard/HomelabStatus";
import CurrentTime from "@/components/dashboard/CurrentTime";
import MissionGraph from "@/components/dashboard/MissionGraph";
import { useMediaQuery } from "@/hooks/useMediaQuery";

export default function Dashboard() {
  const {
    focus,
    setFocus,
    tasks,
    toggleTask,
    addTask,
    editTask,
    deleteTask,
    weeklyGoals,
    streaks,
    notes,
    addNote,
    editNote,
    deleteNote,
    activity,
  } = useDashboardData();

  /*
    The graph is a second pane, and only on a big screen.

    The owner's decision, 2026-08-30: this is for the desk and eventually a wall
    display, not for a phone. `useMediaQuery` rather than a `hidden lg:block`
    class because the component must not MOUNT below the breakpoint — an SVG
    that is `display: none` still holds its nodes and still costs a phone
    something for a view nobody can see. See docs/dashboard-graph-design.md.
  */
  const bigScreen = useMediaQuery("(min-width: 1024px)");

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <HomelabStatus />

      <CurrentTime />
      <TodayFocus focus={focus} onChange={setFocus} />
      <TodayTasks
        tasks={tasks}
        onToggle={toggleTask}
        onAdd={addTask}
        onEdit={editTask}
        onDelete={deleteTask}
      />

      <CurrentMissions />
      <WeeklyGoals goals={weeklyGoals} />

      <ProjectProgress />
      <CurrentStreaks streaks={streaks} />
      <MissionStatusChart />

      <UpcomingEvents />
      <QuickNotes notes={notes} onAdd={addNote} onEdit={editNote} onDelete={deleteNote} />
      <RecentActivity activity={activity} />
      </div>

      {bigScreen && (
        <div className="mt-4">
          <MissionGraph />
        </div>
      )}
    </>
  );
}
