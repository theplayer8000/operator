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

  return (
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
  );
}
