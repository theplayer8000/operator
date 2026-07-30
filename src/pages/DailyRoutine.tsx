import { useState } from "react";
import { useRoutineData } from "@/hooks/useRoutineData";
import RoutineSummary from "@/components/routine/RoutineSummary";
import RoutineTimeline from "@/components/routine/RoutineTimeline";
import RoutineSectionCard from "@/components/routine/RoutineSectionCard";

/**
 * The whole page is scoped to one date (v16), not just the schedule card.
 *
 * The date lives here rather than inside `RoutineTimeline` because it is no
 * longer only the timeline's business: now that `routine.completions` is keyed
 * by date, the summary and every section card are date-scoped too. Stepping to
 * Tuesday while the cards below still showed today's ticks would be two
 * different days on one screen.
 *
 * Components underneath stay date-unaware on purpose — they receive
 * already-bound `isDone` / `onToggleTask` closures, so no component has to
 * remember to thread a date through and none of them can read the wrong day.
 */
export default function DailyRoutine() {
  const {
    sections,
    todayKey,
    isDoneOn,
    scheduleFor,
    statsFor,
    toggleTask,
    addTask,
    editTask,
    deleteTask,
    toggleRepeat,
    setStartTime,
    setNotes,
  } = useRoutineData();

  const [dateKey, setDateKey] = useState(todayKey);

  const schedule = scheduleFor(dateKey);
  const stats = statsFor(dateKey);

  return (
    <div className="max-w-2xl mx-auto lg:mx-0">
      <RoutineSummary
        overallPercent={stats.overallPercent}
        doneTasks={stats.doneTasks}
        totalTasks={stats.totalTasks}
        doneMinutes={stats.doneMinutes}
        totalMinutes={stats.totalMinutes}
      />

      <RoutineTimeline
        schedule={schedule}
        sections={sections}
        dateKey={dateKey}
        todayKey={todayKey}
        onDateChange={setDateKey}
        isDone={(task) => isDoneOn(dateKey, task)}
        onToggleTask={(sectionKey, task) => toggleTask(dateKey, sectionKey, task)}
      />

      <div>
        {sections.map((section, i) => (
          <RoutineSectionCard
            key={section.key}
            section={section}
            isLast={i === sections.length - 1}
            isDone={(task) => isDoneOn(dateKey, task)}
            onToggleTask={(sectionKey, task) => toggleTask(dateKey, sectionKey, task)}
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
