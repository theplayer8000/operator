import { useRemoteStorage } from "./useRemoteStorage";
import { generateId } from "@/lib/id";
import { seedMissionRecords } from "@/lib/seed";
import type {
  Milestone,
  MissionCategory,
  MissionDifficulty,
  MissionRecord,
  MissionStatus,
} from "@/lib/types";

/**
 * Everything the Mission Board (list) and Mission Detail (single record)
 * pages read and write through. One localStorage key: "missions.records".
 */
export function useMissionBoard() {
  const [missions, setMissions] = useRemoteStorage<MissionRecord[]>(
    "missions.records",
    seedMissionRecords
  );

  function logActivity(id: string, label: string) {
    setMissions((prev) =>
      prev.map((m) =>
        m.id !== id
          ? m
          : {
              ...m,
              activity: [
                { id: generateId(), label, timestamp: new Date().toISOString() },
                ...m.activity,
              ].slice(0, 30),
            }
      )
    );
  }

  function updateMission(id: string, patch: Partial<MissionRecord>) {
    setMissions((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  function addMission(input: {
    name: string;
    description: string;
    category: MissionCategory;
    difficulty: MissionDifficulty;
  }) {
    const record: MissionRecord = {
      id: generateId(),
      name: input.name,
      description: input.description,
      category: input.category,
      difficulty: input.difficulty,
      status: "not_started",
      progress: 0,
      timeInvestedHours: 0,
      nextObjective: "",
      objectivesNotes: "",
      notes: "",
      milestones: [],
      dependsOn: [],
      relatedLearning: "",
      relatedJourneyMilestone: "",
      whyItMatters: "",
      unlocks: "",
      knowledgeNeeded: "",
      activity: [{ id: generateId(), label: "Mission created", timestamp: new Date().toISOString() }],
      archived: false,
      createdAt: new Date().toISOString(),
    };
    setMissions((prev) => [record, ...prev]);
    return record.id;
  }

  function setStatus(id: string, status: MissionStatus) {
    updateMission(id, { status });
    logActivity(id, `Status changed to "${status.replace("_", " ")}"`);
  }

  function setProgress(id: string, progress: number) {
    updateMission(id, { progress });
    logActivity(id, `Progress moved to ${progress}%`);
  }

  function toggleDependency(id: string, dependsOnId: string) {
    setMissions((prev) =>
      prev.map((m) =>
        m.id !== id
          ? m
          : {
              ...m,
              dependsOn: m.dependsOn.includes(dependsOnId)
                ? m.dependsOn.filter((d) => d !== dependsOnId)
                : [...m.dependsOn, dependsOnId],
            }
      )
    );
  }

  function addMilestone(id: string, milestone: Omit<Milestone, "id">) {
    const record: Milestone = { ...milestone, id: generateId() };
    setMissions((prev) =>
      prev.map((m) => (m.id === id ? { ...m, milestones: [...m.milestones, record] } : m))
    );
    logActivity(id, `Milestone "${milestone.title}" added`);
  }

  function updateMilestone(id: string, milestoneId: string, patch: Partial<Milestone>) {
    setMissions((prev) =>
      prev.map((m) =>
        m.id !== id
          ? m
          : {
              ...m,
              milestones: m.milestones.map((ms) =>
                ms.id === milestoneId ? { ...ms, ...patch } : ms
              ),
            }
      )
    );
    if (patch.status === "complete") {
      const mission = missions.find((m) => m.id === id);
      const ms = mission?.milestones.find((x) => x.id === milestoneId);
      if (ms) logActivity(id, `Milestone "${ms.title}" completed`);
    }
  }

  function setNotes(id: string, notes: string) {
    updateMission(id, { notes });
  }

  function getMission(id: string) {
    return missions.find((m) => m.id === id);
  }

  function getDependents(id: string) {
    return missions.filter((m) => m.dependsOn.includes(id));
  }

  const active = missions.filter((m) => !m.archived);

  return {
    missions,
    active,
    getMission,
    getDependents,
    addMission,
    updateMission,
    setStatus,
    setProgress,
    toggleDependency,
    addMilestone,
    updateMilestone,
    setNotes,
    logActivity,
  };
}
