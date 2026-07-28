import { useRoutineData } from "@/hooks/useRoutineData";
import RoutineSummary from "@/components/routine/RoutineSummary";
import RoutineTimeline from "@/components/routine/RoutineTimeline";
import RoutineSectionCard from "@/components/routine/RoutineSectionCard";

export default function DailyRoutine() {
  const {
    sections,
    schedule,
    toggleTask,
    addTask,
    editTask,
    deleteTask,
    toggleRepeat,
    setStartTime,
    setNotes,
    overallPercent,
    doneTasks,
    totalTasks,
    doneMinutes,
    totalMinutes,
  } = useRoutineData();

  return (
    <div className="max-w-2xl mx-auto lg:mx-0">
      <RoutineSummary
        overallPercent={overallPercent}
        doneTasks={doneTasks}
        totalTasks={totalTasks}
        doneMinutes={doneMinutes}
        totalMinutes={totalMinutes}
      />

      <RoutineTimeline schedule={schedule} />

      <div>
        {sections.map((section, i) => (
          <RoutineSectionCard
            key={section.key}
            section={section}
            isLast={i === sections.length - 1}
            onToggleTask={toggleTask}
            onAddTask={addTask}
            onEditTask={editTask}
            onDeleteTask={deleteTask}
            onToggleRepeat={toggleRepeat}
            onStartTimeChange={setStartTime}
            onNotesChange={setNotes}
          />
        ))}
      </div>
    </div>
  );
}
