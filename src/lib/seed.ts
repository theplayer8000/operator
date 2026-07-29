import type {
  ActivityItem,
  HomelabService,
  MissionRecord,
  QuickNote,
  RoutineSection,
  Streak,
  Task,
  CalendarEvent,
  UpdateEntry,
  WeeklyGoal,
} from "./types";
import { toDateKey } from "./time";

// First-run content only — every array below is fully editable/replaceable
// the moment the user touches it, since each is backed by useRemoteStorage.

export const seedTasks: Task[] = [
  { id: "t1", title: "Review Darams tenancies module HTML", done: false, priority: "high" },
  { id: "t2", title: "Rack-plan the EPYC server bay", done: false, priority: "medium" },
  { id: "t3", title: "30 min French — Duolingo streak", done: true, priority: "low" },
  { id: "t4", title: "Log today's forex observations", done: false, priority: "medium" },
];

export const seedWeeklyGoals: WeeklyGoal[] = [
  { id: "w1", label: "Study hours", target: 10, current: 6, unit: "h" },
  { id: "w2", label: "Gym sessions", target: 4, current: 3, unit: "" },
  { id: "w3", label: "Forex journal entries", target: 5, current: 2, unit: "" },
];

export const seedStreaks: Streak[] = [
  { id: "s1", label: "Learning", days: 12, alive: true },
  { id: "s2", label: "Gym", days: 5, alive: true },
  { id: "s3", label: "Forex journal", days: 0, alive: false },
];

export const seedEvents: CalendarEvent[] = [
  { id: "e1", title: "GEH NHS shift", date: nextDateKey(1), kind: "work", notes: "" },
  { id: "e2", title: "Darams UI review call", date: nextDateKey(3), time: "14:00", kind: "work", notes: "" },
  { id: "e3", title: "Breakin Science — Amsterdam", date: nextDateKey(21), kind: "personal", notes: "" },
];

export const seedNotes: QuickNote[] = [
  { id: "n1", text: "RustDesk port to double-check for Teo's setup", createdAt: new Date().toISOString() },
];

export const seedActivity: ActivityItem[] = [
  { id: "a1", label: "Completed \"30 min French\"", timestamp: hoursAgo(2), kind: "task" },
  { id: "a2", label: "Darams CRM moved to 78%", timestamp: hoursAgo(6), kind: "mission" },
  { id: "a3", label: "Learning streak hit 12 days", timestamp: hoursAgo(20), kind: "streak" },
];

export const seedRoutineSections: RoutineSection[] = [
  {
    key: "morning",
    startTime: "06:30",
    label: "Morning",
    notes: "",
    tasks: [
      { id: "r1", title: "Make bed", done: false, estimatedMinutes: 2, repeatDaily: true },
      { id: "r2", title: "Hydrate + supplements", done: false, estimatedMinutes: 5, repeatDaily: true },
      { id: "r3", title: "Review today's focus", done: false, estimatedMinutes: 5, repeatDaily: true },
    ],
  },
  {
    key: "work",
    startTime: "09:00",
    label: "Work",
    notes: "",
    tasks: [
      { id: "r4", title: "Check shift schedule", done: false, estimatedMinutes: 5, repeatDaily: true },
      { id: "r5", title: "Clear priority inbox", done: false, estimatedMinutes: 20, repeatDaily: true },
    ],
  },
  {
    key: "gym",
    startTime: "17:30",
    label: "Gym",
    notes: "",
    tasks: [
      { id: "r6", title: "Warm up", done: false, estimatedMinutes: 10, repeatDaily: true },
      { id: "r7", title: "Push / Pull / Legs session", done: false, estimatedMinutes: 60, repeatDaily: true },
      { id: "r8", title: "Log body weight", done: false, estimatedMinutes: 2, repeatDaily: true },
    ],
  },
  {
    key: "learning",
    startTime: "19:30",
    label: "Learning",
    notes: "",
    tasks: [
      { id: "r9", title: "Linux Journey — next module", done: false, estimatedMinutes: 30, repeatDaily: true },
      { id: "r10", title: "Log progress + next lesson", done: false, estimatedMinutes: 5, repeatDaily: true },
    ],
  },
  {
    key: "forex",
    startTime: "20:30",
    label: "Forex",
    notes: "",
    tasks: [
      { id: "r11", title: "Review overnight market", done: false, estimatedMinutes: 15, repeatDaily: true },
      { id: "r12", title: "Journal entry — observations", done: false, estimatedMinutes: 10, repeatDaily: true },
    ],
  },
  {
    key: "evening",
    startTime: "21:30",
    label: "Evening",
    notes: "",
    tasks: [
      { id: "r13", title: "Tidy workspace", done: false, estimatedMinutes: 10, repeatDaily: true },
      { id: "r14", title: "Plan tomorrow's focus", done: false, estimatedMinutes: 5, repeatDaily: true },
    ],
  },
  {
    key: "sleep",
    startTime: "23:00",
    label: "Sleep",
    notes: "",
    tasks: [
      { id: "r15", title: "Screens off", done: false, estimatedMinutes: 0, repeatDaily: true },
      { id: "r16", title: "Lights out by target time", done: false, estimatedMinutes: 0, repeatDaily: true },
    ],
  },
];

// First-run content only, same as everything else here. Written for the
// owner, not for the next engineer — plain terms, not commit-message jargon.
// Keep adding an entry here in spirit (i.e. via the Updates page, not this
// file) whenever something real ships; this array only seeds a fresh store.
export const seedUpdates: UpdateEntry[] = [
  {
    id: "u0",
    title: "Calendar: easier times, and fixed on mobile",
    detail:
      "Renamed Events to Calendar. Setting a time now means picking a start and finish instead of typing minutes. And on a phone, tapping a day opens a popup instead of making you scroll past every other month to reach the form.",
    status: "done",
    date: pastDateKey(0),
  },
  {
    id: "u1",
    title: "Events calendar synced into the Day Schedule",
    detail:
      "Timed events now show up on the routine timeline alongside your day, the clock on the Dashboard opens the calendar, and you can change an event's date instead of deleting and re-adding it.",
    status: "done",
    date: pastDateKey(0),
  },
  {
    id: "u2",
    title: "Fixed the daily reset rolling an hour late",
    detail:
      "It was comparing UTC time, not local — between midnight and 1am in summer it thought it was still yesterday. Also now catches up if a tab was left open overnight.",
    status: "done",
    date: pastDateKey(0),
  },
  {
    id: "u3",
    title: "Added the Events calendar",
    detail: "Year view, add/edit/delete on any day, and a upcoming list.",
    status: "done",
    date: pastDateKey(0),
  },
  {
    id: "u4",
    title: "Dashboard now shows your real missions",
    detail: "Current Missions, Mission Progress and the status chart all read the actual board instead of fixed demo numbers.",
    status: "done",
    date: pastDateKey(0),
  },
  {
    id: "u5",
    title: "Added Settings — backup and clear",
    detail: "Export downloads everything as one file; import merges one back in. Clearing empties a feature without restoring the old demo data.",
    status: "done",
    date: pastDateKey(0),
  },
  {
    id: "u6",
    title: "Added the Homelab page",
    detail: "A tile per service running on the box, with a live online/offline check.",
    status: "done",
    date: pastDateKey(0),
  },
  {
    id: "u7",
    title: "Edit and delete, everywhere",
    detail: "Tasks, notes, routine steps and missions can all be renamed or removed now, not just added.",
    status: "done",
    date: pastDateKey(0),
  },
  {
    id: "u8",
    title: "Gym",
    detail:
      "Parked until you send over a real plan from ChatGPT — the import needs to be built against your actual format, not a guess.",
    status: "pending",
  },
  {
    id: "u9",
    title: "Weekly Goals and Streaks still have no editor",
    detail: "Same fix as the missions widgets, one size down — they're still fixed demo numbers on the Dashboard.",
    status: "pending",
  },
  {
    id: "u10",
    title: "Automatic backups",
    detail: "Export works, but nothing runs on a schedule yet — a copy job to the NAS over SSH is the plan.",
    status: "pending",
  },
  {
    id: "u11",
    title: "Repeating events",
    detail: "Your NHS shifts are weekly — entering them one at a time will get old. Needs a real recurrence design, not a loop that writes 52 copies.",
    status: "pending",
  },
];

// Hosts are written as "localhost" because that is what they are from the box
// running the storage server. The client rewrites it to whatever hostname the
// browser used, so these same entries resolve correctly over Tailscale.
export const seedHomelabServices: HomelabService[] = [
  {
    id: "svc-darams-crm",
    name: "Darams CRM",
    description:
      "Lettings and sales CRM for the office — landlords, properties, tenants, tenancies, works.",
    host: "localhost",
    port: 5000,
    path: "/",
    protocol: "http",
    stack: "Flask · SQLite",
  },
  {
    id: "svc-operator-api",
    name: "Operator Storage API",
    description: "This dashboard's own JSON store. If this tile is down, you are reading a mirror.",
    host: "localhost",
    port: 5174,
    path: "/api/health",
    protocol: "http",
    stack: "Node · JSON file",
  },
];

export const seedMissionRecords: MissionRecord[] = [
  {
    id: "mb-homelab",
    name: "Home Lab",
    description:
      "A self-hosted network and services foundation — the base every other infrastructure mission builds on.",
    category: "homelab",
    difficulty: "moderate",
    status: "in_progress",
    progress: 40,
    estimatedCompletion: futureMonth(2),
    timeInvestedHours: 26,
    nextObjective: "Finish VLAN segmentation between homelab and personal network",
    objectivesNotes: "Get networking rock-solid before the EPYC box lands — no point racking hardware onto a shaky network.",
    notes: "2-bay NAS running, Windows Explorer access confirmed working.",
    milestones: [
      { id: "m1", title: "NAS provisioned", description: "2-bay NAS built and accessible over the network.", status: "complete", progress: 100, estimatedDuration: "1 week", completionDate: pastDays(40), notes: "" },
      { id: "m2", title: "VLAN segmentation", description: "Separate homelab traffic from personal devices.", status: "in_progress", progress: 55, estimatedDuration: "2 weeks", notes: "Router supports VLANs, still mapping ports." },
      { id: "m3", title: "Reverse proxy + internal DNS", description: "Clean internal URLs for every self-hosted service.", status: "pending", progress: 0, estimatedDuration: "1 week", notes: "" },
    ],
    dependsOn: [],
    relatedLearning: "Networking, Linux, Docker",
    relatedJourneyMilestone: "2025 — Complete Homelab",
    whyItMatters: "Everything else — the EPYC server, AI infra, Darams hosting — needs a network worth building on.",
    unlocks: "A stable base to rack the EPYC server and start self-hosting AI infrastructure.",
    knowledgeNeeded: "VLANs, reverse proxying, internal DNS",
    activity: [
      { id: "a1", label: "NAS provisioned", timestamp: pastDays(40) },
      { id: "a2", label: "Progress moved to 40%", timestamp: pastDays(3) },
    ],
    archived: false,
    createdAt: pastDays(50),
  },
  {
    id: "mb-epyc",
    name: "Build EPYC Server",
    description:
      "The core compute box for the homelab — Minisforum MS-A2, Ryzen 9 9955HX, 32GB RAM — built to actually run things, not just sit idle.",
    category: "server",
    difficulty: "hard",
    status: "in_progress",
    progress: 62,
    estimatedCompletion: futureMonth(3),
    timeInvestedHours: 34,
    nextObjective: "Rack-plan the server bay and finalise cooling",
    objectivesNotes: "Hardware is mostly sourced — remaining work is placement, cooling, and OS layer.",
    notes: "Target OS: Proxmox. Waiting on homelab networking before final placement.",
    milestones: [
      { id: "m1", title: "Hardware sourced", description: "MS-A2 + RAM confirmed and ordered.", status: "complete", progress: 100, estimatedDuration: "2 weeks", completionDate: pastDays(20), notes: "" },
      { id: "m2", title: "Proxmox installed", description: "Base hypervisor installed and reachable.", status: "in_progress", progress: 50, estimatedDuration: "1 week", notes: "" },
      { id: "m3", title: "Rack + cooling finalised", description: "Physical placement and thermals sorted.", status: "pending", progress: 0, estimatedDuration: "1 week", notes: "" },
    ],
    dependsOn: ["mb-homelab"],
    relatedLearning: "Proxmox, Docker, hardware planning",
    relatedJourneyMilestone: "2025 — Build EPYC Server",
    whyItMatters: "This is the compute backbone for AI infrastructure and self-hosted services — without it, Darams AI and AI Development stall.",
    unlocks: "Enough compute headroom to start AI Development and host Darams properly.",
    knowledgeNeeded: "Proxmox clustering, resource allocation for VMs/containers",
    activity: [
      { id: "a1", label: "Hardware sourced", timestamp: pastDays(20) },
      { id: "a2", label: "Progress moved to 62%", timestamp: pastDays(2) },
    ],
    archived: false,
    createdAt: pastDays(45),
  },
  {
    id: "mb-linux",
    name: "Learn Linux",
    description:
      "Structured Linux + networking fundamentals via Linux Journey, feeding directly into every infrastructure mission.",
    category: "learning",
    difficulty: "moderate",
    status: "in_progress",
    progress: 35,
    estimatedCompletion: futureMonth(4),
    timeInvestedHours: 18,
    nextObjective: "Finish Linux Journey networking module",
    objectivesNotes: "Prioritising networking and permissions over anything exotic — want it solid, not broad.",
    notes: "",
    milestones: [
      { id: "m1", title: "Shell + filesystem basics", description: "Comfortable navigating and scripting.", status: "complete", progress: 100, estimatedDuration: "2 weeks", completionDate: pastDays(60), notes: "" },
      { id: "m2", title: "Networking module", description: "Linux Journey networking track.", status: "in_progress", progress: 40, estimatedDuration: "3 weeks", notes: "" },
      { id: "m3", title: "Permissions + users", description: "File permissions, users, groups, sudoers.", status: "pending", progress: 0, estimatedDuration: "1 week", notes: "" },
    ],
    dependsOn: [],
    relatedLearning: "Linux Journey, networking fundamentals",
    relatedJourneyMilestone: "2025 — Build EPYC Server",
    whyItMatters: "Every homelab and server mission assumes Linux fluency — this closes that gap properly instead of learning on the fly under pressure.",
    unlocks: "Confidence to administer Proxmox, Docker, and the AI stack without guesswork.",
    knowledgeNeeded: "—",
    activity: [{ id: "a1", label: "Shell + filesystem basics completed", timestamp: pastDays(60) }],
    archived: false,
    createdAt: pastDays(70),
  },
  {
    id: "mb-ai",
    name: "AI Development",
    description:
      "Standing up a self-hosted AI stack — the layer between raw compute and anything Darams-facing.",
    category: "ai",
    difficulty: "epic",
    status: "not_started",
    progress: 25,
    estimatedCompletion: futureMonth(7),
    timeInvestedHours: 9,
    nextObjective: "Scope the Homelab AI Assistant permission layers (Observer → Administrator)",
    objectivesNotes: "Early scoping only — this waits on the EPYC server being fully racked.",
    notes: "Concept: layered permissions (Observer, Assistant, Operator, Administrator), Roblox VM sandbox for early autonomy testing.",
    milestones: [
      { id: "m1", title: "Architecture scoped", description: "Permission layers and integration points defined.", status: "in_progress", progress: 30, estimatedDuration: "3 weeks", notes: "" },
      { id: "m2", title: "Docker environment ready", description: "Containerised base for AI services.", status: "pending", progress: 0, estimatedDuration: "2 weeks", notes: "" },
    ],
    dependsOn: ["mb-epyc"],
    relatedLearning: "Docker, AI infrastructure, Brave Search API",
    relatedJourneyMilestone: "2026 — AI Platform",
    whyItMatters: "This is the bridge between homelab infrastructure and an actual assistant that can act on Darams and the rest of the setup.",
    unlocks: "The foundation for Darams AI and a genuine home-use AI assistant.",
    knowledgeNeeded: "Container orchestration, agent permission design, local model hosting",
    activity: [{ id: "a1", label: "Mission created", timestamp: pastDays(15) }],
    archived: false,
    createdAt: pastDays(15),
  },
  {
    id: "mb-darams",
    name: "Darams Platform",
    description:
      "The Darams CRM and, eventually, Darams AI — property and lettings tooling built from the ground up.",
    category: "darams",
    difficulty: "hard",
    status: "in_progress",
    progress: 78,
    estimatedCompletion: futureMonth(1),
    timeInvestedHours: 52,
    nextObjective: "Template the Tenancies module to match the new UI",
    objectivesNotes: "UI overhaul approved — remaining work is finishing the Tenancies module and the automated payments piece.",
    notes: "Landlords, Properties, Tenants, Tenancies, Works blueprints in place. Payment module still Python/Flask planning stage.",
    milestones: [
      { id: "m1", title: "Core CRM blueprints", description: "Landlords, Properties, Tenants, Works modules.", status: "complete", progress: 100, estimatedDuration: "6 weeks", completionDate: pastDays(30), notes: "" },
      { id: "m2", title: "UI overhaul", description: "Navy sidebar, stat cards, dark mode.", status: "complete", progress: 100, estimatedDuration: "2 weeks", completionDate: pastDays(10), notes: "" },
      { id: "m3", title: "Tenancies templating", description: "Move raw HTML tenancies module onto the new Jinja2 UI.", status: "in_progress", progress: 30, estimatedDuration: "2 weeks", notes: "" },
      { id: "m4", title: "Automated payments module", description: "Python/Flask payment automation.", status: "pending", progress: 0, estimatedDuration: "4 weeks", notes: "" },
    ],
    dependsOn: ["mb-ai"],
    relatedLearning: "Flask, SQLite, Jinja2",
    relatedJourneyMilestone: "2026 — Launch Darams",
    whyItMatters: "This is the actual business — every hour here compounds into something used daily, not just a lab exercise.",
    unlocks: "A production-ready CRM, and eventually an AI layer on top of it once AI Development lands.",
    knowledgeNeeded: "—",
    activity: [
      { id: "a1", label: "UI overhaul completed", timestamp: pastDays(10) },
      { id: "a2", label: "Progress moved to 78%", timestamp: pastDays(1) },
    ],
    archived: false,
    createdAt: pastDays(120),
  },
  {
    id: "mb-career",
    name: "Career Progression",
    description: "Building toward more senior, more autonomous work — inside NHS/Darams and beyond.",
    category: "career",
    difficulty: "moderate",
    status: "not_started",
    progress: 10,
    estimatedCompletion: futureMonth(10),
    timeInvestedHours: 4,
    nextObjective: "Map out what 'first employee' at Darams actually requires operationally",
    objectivesNotes: "",
    notes: "",
    milestones: [
      { id: "m1", title: "Define target role", description: "What does the next step actually look like.", status: "pending", progress: 0, estimatedDuration: "2 weeks", notes: "" },
    ],
    dependsOn: ["mb-darams"],
    relatedLearning: "—",
    relatedJourneyMilestone: "2027 — First Employee",
    whyItMatters: "Darams becoming self-sustaining depends on the business, not just the software, maturing.",
    unlocks: "The operational groundwork for hiring a first employee.",
    knowledgeNeeded: "Hiring, delegation, business operations",
    activity: [{ id: "a1", label: "Mission created", timestamp: pastDays(5) }],
    archived: false,
    createdAt: pastDays(5),
  },
  {
    id: "mb-gym",
    name: "Gym Transformation",
    description: "Long-term physical progress tracked like everything else — not a fad, a running stat sheet.",
    category: "gym",
    difficulty: "moderate",
    status: "in_progress",
    progress: 30,
    estimatedCompletion: futureMonth(9),
    timeInvestedHours: 40,
    nextObjective: "Hit next PR benchmark on push day",
    objectivesNotes: "",
    notes: "",
    milestones: [
      { id: "m1", title: "Consistent PPL routine", description: "3-4 sessions a week, sustained for a month.", status: "complete", progress: 100, estimatedDuration: "4 weeks", completionDate: pastDays(25), notes: "" },
      { id: "m2", title: "First strength PR block", description: "Measurable PR across major lifts.", status: "in_progress", progress: 40, estimatedDuration: "8 weeks", notes: "" },
    ],
    dependsOn: [],
    relatedLearning: "—",
    relatedJourneyMilestone: "—",
    whyItMatters: "Physical stats compound the same way technical ones do — this is the one mission that's about the operator, not the systems.",
    unlocks: "—",
    knowledgeNeeded: "—",
    activity: [{ id: "a1", label: "Consistent PPL routine completed", timestamp: pastDays(25) }],
    archived: false,
    createdAt: pastDays(90),
  },
  {
    id: "mb-forex",
    name: "Forex Education",
    description: "A learning journal, not a trading platform — building market literacy before ever risking capital.",
    category: "forex",
    difficulty: "easy",
    status: "in_progress",
    progress: 18,
    estimatedCompletion: futureMonth(6),
    timeInvestedHours: 14,
    nextObjective: "Finish current concept block and log this week's review",
    objectivesNotes: "",
    notes: "",
    milestones: [
      { id: "m1", title: "Core concepts covered", description: "Fundamentals of price action and risk.", status: "in_progress", progress: 45, estimatedDuration: "6 weeks", notes: "" },
    ],
    dependsOn: [],
    relatedLearning: "Stoic FX materials",
    relatedJourneyMilestone: "—",
    whyItMatters: "Getting the education right first means not paying for lessons with real capital later.",
    unlocks: "—",
    knowledgeNeeded: "Risk management, technical analysis fundamentals",
    activity: [{ id: "a1", label: "Mission created", timestamp: pastDays(35) }],
    archived: false,
    createdAt: pastDays(35),
  },
];

function futureMonth(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return d.toISOString();
}
function pastDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

/** A local calendar day n days out, as "YYYY-MM-DD" — not a timestamp. */
function nextDateKey(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return toDateKey(d);
}
/** A local calendar day n days ago, as "YYYY-MM-DD" — not a timestamp. */
function pastDateKey(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toDateKey(d);
}
function hoursAgo(n: number): string {
  const d = new Date();
  d.setHours(d.getHours() - n);
  return d.toISOString();
}
