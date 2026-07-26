import {
  Sunrise,
  Briefcase,
  Dumbbell,
  GraduationCap,
  LineChart,
  Sunset,
  BedDouble,
  type LucideIcon,
} from "lucide-react";
import type { RoutineSectionKey } from "@/lib/types";

export const ROUTINE_META: Record<RoutineSectionKey, { icon: LucideIcon; caption: string }> = {
  morning: { icon: Sunrise, caption: "Set the tone" },
  work: { icon: Briefcase, caption: "GEH NHS / Darams" },
  gym: { icon: Dumbbell, caption: "Build the stats" },
  learning: { icon: GraduationCap, caption: "Compound skill" },
  forex: { icon: LineChart, caption: "Study, don't trade" },
  evening: { icon: Sunset, caption: "Wind down" },
  sleep: { icon: BedDouble, caption: "Protect recovery" },
};
