import {
  RoundelIcon as Circle,
  CrownIcon,
  LozengeIcon as Diamond,
  BezantIcon as Hexagon,
  PriorityIcon,
  ShieldIcon,
  BilletIcon as Square,
  MulletIcon as Star,
  PileIcon as Triangle,
} from "../../components/TaskIcons";
import type { Epic } from "../../lib/types";

export const EPIC_SHAPES = {
  diamond: Diamond,
  circle: Circle,
  square: Square,
  triangle: Triangle,
  hexagon: Hexagon,
  star: Star,
  flag: PriorityIcon,
  crown: CrownIcon,
  shield: ShieldIcon,
};

export function EpicMark({ epic, size = 13 }: { epic: Epic; size?: number }) {
  const Shape = EPIC_SHAPES[epic.icon as keyof typeof EPIC_SHAPES] ?? Diamond;
  return (
    <Shape
      aria-hidden
      size={size}
      className="shrink-0 text-violet-700 dark:text-violet-300"
      style={epic.color ? { color: epic.color } : undefined}
    />
  );
}
