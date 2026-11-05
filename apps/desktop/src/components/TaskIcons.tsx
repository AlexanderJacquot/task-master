import type { ComponentProps } from "react";
import paths from "../assets/icons/paths.json";

type IconProps = ComponentProps<"svg"> & { size?: number | string };
function TaskIcon({ name, size = 24, ...props }: IconProps & { name: keyof typeof paths }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function AddIcon(props: IconProps) {
  return <TaskIcon {...props} name="add" />;
}
export function InboxIcon(props: IconProps) {
  return <TaskIcon {...props} name="inbox" />;
}
export function ProjectsIcon(props: IconProps) {
  return <TaskIcon {...props} name="projects" />;
}
export function DueDateIcon(props: IconProps) {
  return <TaskIcon {...props} name="due-date" />;
}
export function SettingsIcon(props: IconProps) {
  return <TaskIcon {...props} name="settings" />;
}
