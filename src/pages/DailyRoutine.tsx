import { useRoutineData } from "@/hooks/useRoutineData";
import RoutineSummary from "@/components/routine/RoutineSummary";
import RoutineSectionCard from "@/components/routine/RoutineSectionCard";

export default function DailyRoutine() {
  const {
    sections,
    toggleTask,
    addTask,
    toggleRepeat,
    setNotes,
    overallPercent,
    doneTasks,
    totalTasks,
    doneMinutes,
    totalMinutes,
  } = useRoutineData();

  return (
    <div className="max-w-2xl">
      <RoutineSummary
        overallPercent={overallPercent}
        doneTasks={doneTasks}
        totalTasks={totalTasks}
        doneMinutes={doneMinutes}
        totalMinutes={totalMinutes}
      />

      <div>
        {sections.map((section, i) => (
          <RoutineSectionCard
            key={section.key}
            section={section}
            isLast={i === sections.length - 1}
            onToggleTask={toggleTask}
            onAddTask={addTask}
            onToggleRepeat={toggleRepeat}
            onNotesChange={setNotes}
          />
        ))}
      </div>
    </div>
  );
}
