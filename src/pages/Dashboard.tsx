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
import ProductivityScore from "@/components/dashboard/ProductivityScore";

export default function Dashboard() {
  const {
    focus,
    setFocus,
    tasks,
    toggleTask,
    addTask,
    missions,
    weeklyGoals,
    streaks,
    events,
    notes,
    addNote,
    activity,
    productivityHistory,
    productivityScore,
  } = useDashboardData();

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <TodayFocus focus={focus} onChange={setFocus} />
      <TodayTasks tasks={tasks} onToggle={toggleTask} onAdd={addTask} />

      <CurrentMissions missions={missions} />
      <WeeklyGoals goals={weeklyGoals} />

      <ProjectProgress missions={missions} />
      <CurrentStreaks streaks={streaks} />
      <ProductivityScore score={productivityScore} history={productivityHistory} />

      <UpcomingEvents events={events} />
      <QuickNotes notes={notes} onAdd={addNote} />
      <RecentActivity activity={activity} />
    </div>
  );
}
