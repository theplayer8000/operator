import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Clock,
  Target,
  CalendarClock,
  History,
  BookOpen,
  Scale,
  Map as MapIcon,
  Sparkles,
  Paperclip,
  Archive,
  ArchiveRestore,
} from "lucide-react";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { useMissionBoard } from "@/hooks/useMissionBoard";
import type { MissionDifficulty, MissionStatus } from "@/lib/types";
import { STATUS_OPTIONS, DIFFICULTY_OPTIONS, STATUS_META, DIFFICULTY_META } from "@/components/missions/MissionBadges";
import EditableField from "@/components/missions/EditableField";
import DependencyChain from "@/components/missions/DependencyChain";
import DependencyEditor from "@/components/missions/DependencyEditor";
import MilestoneList from "@/components/missions/MilestoneList";
import MilestoneTimeline from "@/components/missions/MilestoneTimeline";
import ReservedSection from "@/components/missions/ReservedSection";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "objectives", label: "Objectives" },
  { id: "milestones", label: "Milestones" },
  { id: "timeline", label: "Timeline" },
  { id: "notes", label: "Notes" },
  { id: "activity", label: "Activity" },
  { id: "knowledge", label: "Related Knowledge" },
  { id: "decisions", label: "Related Decisions" },
  { id: "journey", label: "Related Journey" },
  { id: "ai", label: "AI Summary" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function MissionDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const {
    missions,
    getMission,
    updateMission,
    setStatus,
    setProgress,
    toggleDependency,
    addMilestone,
    updateMilestone,
    deleteMilestone,
    setNotes,
    setArchived,
    deleteMission,
  } = useMissionBoard();

  const [tab, setTab] = useState<TabId>("overview");

  const mission = getMission(id);
  const predecessors = useMemo(
    () => missions.filter((m) => mission?.dependsOn.includes(m.id)),
    [missions, mission]
  );
  const dependents = useMemo(
    () => missions.filter((m) => m.dependsOn.includes(id)),
    [missions, id]
  );

  if (!mission) {
    return (
      <div className="text-center py-16">
        <p className="text-ink-500 mb-4">Mission not found.</p>
        <Link to="/missions" className="text-xp text-sm hover:underline">
          Back to Mission Board
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto lg:mx-0">
      <Link
        to="/missions"
        className="inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-300 mb-4 transition-colors"
      >
        <ArrowLeft size={14} /> Mission Board
      </Link>

      {/* Header */}
      <div className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="min-w-0 flex-1">
            <EditableField
              value={mission.name}
              onChange={(v) => updateMission(mission.id, { name: v })}
            />
          </div>
          <span className="font-mono text-xl sm:text-2xl text-ink-100 shrink-0 mt-1">{mission.progress}%</span>
        </div>

        <div className="h-1.5 bg-base-700 rounded-full overflow-hidden mb-4">
          <div
            className="h-full bg-xp rounded-full transition-all duration-500"
            style={{ width: `${mission.progress}%` }}
          />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div>
            <p className="text-ink-700 mb-1">Status</p>
            <select
              value={mission.status}
              onChange={(e) => setStatus(mission.id, e.target.value as MissionStatus)}
              className="w-full bg-base-700/40 border border-base-600 rounded-badge px-2 min-h-[40px] text-base sm:text-xs text-ink-300 outline-none focus:border-xp/50"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {STATUS_META[s].label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <p className="text-ink-700 mb-1">Difficulty</p>
            <select
              value={mission.difficulty}
              onChange={(e) => updateMission(mission.id, { difficulty: e.target.value as MissionDifficulty })}
              className="w-full bg-base-700/40 border border-base-600 rounded-badge px-2 min-h-[40px] text-base sm:text-xs text-ink-300 outline-none focus:border-xp/50"
            >
              {DIFFICULTY_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {DIFFICULTY_META[d].label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <p className="text-ink-700 mb-1 flex items-center gap-1">
              <Clock size={11} /> Time invested
            </p>
            <input
              type="number"
              min={0}
              value={mission.timeInvestedHours}
              onChange={(e) => updateMission(mission.id, { timeInvestedHours: Number(e.target.value) })}
              className="w-full bg-base-700/40 border border-base-600 rounded-badge px-2 min-h-[40px] text-base sm:text-xs text-ink-300 outline-none focus:border-xp/50 font-mono"
            />
          </div>
          <div>
            <p className="text-ink-700 mb-1 flex items-center gap-1">
              <CalendarClock size={11} /> Est. completion
            </p>
            <input
              type="date"
              value={mission.estimatedCompletion?.slice(0, 10) ?? ""}
              onChange={(e) =>
                updateMission(mission.id, {
                  estimatedCompletion: e.target.value ? new Date(e.target.value).toISOString() : undefined,
                })
              }
              className="w-full bg-base-700/40 border border-base-600 rounded-badge px-2 min-h-[40px] text-base sm:text-xs text-ink-300 outline-none focus:border-xp/50 font-mono"
            />
          </div>
        </div>

        <div className="mt-3">
          <input
            type="range"
            min={0}
            max={100}
            value={mission.progress}
            onChange={(e) => setProgress(mission.id, Number(e.target.value))}
            className="w-full h-6 accent-xp cursor-pointer"
          />
        </div>
      </div>

      {/* Tabs */}
      {/*
        Ten tabs wrap into a wall on a narrow screen. One scrollable strip
        keeps the row a single line on a phone and unchanged on desktop.
      */}
      <div className="flex gap-1 mb-5 border-b border-base-600 pb-1 overflow-x-auto scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 min-h-[44px] shrink-0 text-xs whitespace-nowrap border-b-2 transition-colors ${
              tab === t.id
                ? "border-xp text-ink-100"
                : "border-transparent text-ink-500 hover:text-ink-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="card-base p-4 sm:p-5 animate-fade-up">
        {tab === "overview" && (
          <div className="space-y-5">
            <EditableField
              label="Description"
              value={mission.description}
              multiline
              onChange={(v) => updateMission(mission.id, { description: v })}
            />
            <EditableField
              label="Why it matters"
              value={mission.whyItMatters}
              multiline
              rows={2}
              onChange={(v) => updateMission(mission.id, { whyItMatters: v })}
            />
            <EditableField
              label="What completing this unlocks"
              value={mission.unlocks}
              multiline
              rows={2}
              onChange={(v) => updateMission(mission.id, { unlocks: v })}
            />
            <EditableField
              label="Knowledge still needed"
              value={mission.knowledgeNeeded}
              multiline
              rows={2}
              onChange={(v) => updateMission(mission.id, { knowledgeNeeded: v })}
            />
            <div>
              <p className="text-xs font-mono uppercase tracking-wide text-ink-700 mb-2 flex items-center gap-1.5">
                <Scale size={12} /> Dependencies
              </p>
              <DependencyChain current={mission} predecessors={predecessors} successors={dependents} />
              <div className="mt-3">
                <p className="text-xs text-ink-700 mb-1.5">Depends on:</p>
                <DependencyEditor
                  current={mission}
                  allMissions={missions}
                  onToggle={(depId) => toggleDependency(mission.id, depId)}
                />
              </div>
            </div>
            <div>
              <p className="text-xs font-mono uppercase tracking-wide text-ink-700 mb-2 flex items-center gap-1.5">
                <Paperclip size={12} /> Files & Attachments
              </p>
              <ReservedSection message="Reserved for a future version — this will hold linked files and attachments." />
            </div>
          </div>
        )}

        {tab === "objectives" && (
          <div className="space-y-5">
            <EditableField
              label="Next Objective"
              value={mission.nextObjective}
              onChange={(v) => updateMission(mission.id, { nextObjective: v })}
              placeholder="What's the very next concrete step?"
            />
            <EditableField
              label="Notes"
              value={mission.objectivesNotes}
              multiline
              rows={5}
              onChange={(v) => updateMission(mission.id, { objectivesNotes: v })}
              placeholder="Context on the current objective..."
            />
          </div>
        )}

        {tab === "milestones" && (
          <MilestoneList
            milestones={mission.milestones}
            onAdd={(m) => addMilestone(mission.id, m)}
            onUpdate={(msId, patch) => updateMilestone(mission.id, msId, patch)}
            onDelete={(msId) => deleteMilestone(mission.id, msId)}
          />
        )}

        {tab === "timeline" && <MilestoneTimeline milestones={mission.milestones} />}

        {tab === "notes" && (
          <EditableField
            value={mission.notes}
            multiline
            rows={8}
            onChange={(v) => setNotes(mission.id, v)}
            placeholder="Freeform notes on this mission..."
          />
        )}

        {tab === "activity" && (
          <div>
            {mission.activity.length === 0 ? (
              <p className="text-sm text-ink-700">No activity logged yet.</p>
            ) : (
              <ul className="space-y-3">
                {mission.activity.map((a) => (
                  <li key={a.id} className="flex items-start gap-2.5">
                    <History size={13} className="text-ink-700 mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm text-ink-300">{a.label}</p>
                      <p className="text-xs text-ink-700">
                        {new Date(a.timestamp).toLocaleString("en-GB", {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {tab === "knowledge" && (
          <div className="space-y-3">
            <EditableField
              label="Related Learning"
              value={mission.relatedLearning}
              onChange={(v) => updateMission(mission.id, { relatedLearning: v })}
              placeholder="Topics, skills, resources this mission draws on..."
            />
            <ReservedSection
              icon={<BookOpen size={15} />}
              message="Will link directly to Knowledge Vault entries once that page is built."
            />
          </div>
        )}

        {tab === "decisions" && (
          <ReservedSection message="Decision Log isn't built yet — this will show linked decisions once it exists." />
        )}

        {tab === "journey" && (
          <div className="space-y-3">
            <EditableField
              label="Related Journey Milestone"
              value={mission.relatedJourneyMilestone}
              onChange={(v) => updateMission(mission.id, { relatedJourneyMilestone: v })}
              placeholder="e.g. 2026 — Launch Darams"
            />
            <ReservedSection
              icon={<MapIcon size={15} />}
              message="Will deep-link to the Journey roadmap once that page is built."
            />
          </div>
        )}

        {tab === "ai" && (
          <ReservedSection
            icon={<Sparkles size={15} />}
            message="Reserved for a future AI-generated summary of this mission's progress and context."
          />
        )}
      </div>

      {/*
        Below the tabs, not inside one. Archive and delete act on the whole
        record, so they don't belong to Overview any more than to Notes —
        and keeping them at the far bottom means you scroll past everything
        you'd lose before you reach the control that loses it.
      */}
      <div className="card-base p-4 sm:p-5 mt-5 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-ink-300">
            {mission.archived ? "This mission is archived" : "Archive this mission"}
          </p>
          <p className="text-xs text-ink-700">
            {mission.archived
              ? "Hidden from the board. Restoring puts it back with everything intact."
              : "Hides it from the board without losing anything. Reversible."}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setArchived(mission.id, !mission.archived)}
            className="inline-flex items-center gap-1.5 px-3 min-h-[44px] rounded-badge border border-base-600 text-sm text-ink-300 hover:text-ink-100 hover:border-base-500 transition-colors"
          >
            {mission.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            {mission.archived ? "Restore" : "Archive"}
          </button>
          <ConfirmButton
            label={`Delete "${mission.name}"`}
            onConfirm={() => {
              deleteMission(mission.id);
              navigate("/missions");
            }}
          />
        </div>
      </div>
    </div>
  );
}
