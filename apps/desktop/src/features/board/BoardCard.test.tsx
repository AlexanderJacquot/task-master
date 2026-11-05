// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { STATUS, statuses, task } from "../../test/fixtures";
import { CardFace } from "./BoardCard";

afterEach(cleanup);

it("marks open cards stale at 30 days and clears the indicator after an update", () => {
  const props = {
    task: task({ updated_at: new Date(2026, 9, 6, 12).getTime() }),
    statuses,
    projects: {},
    epics: {},
    tags: {},
    today: "2026-11-05",
    showProject: true,
    childCount: 0,
    childDone: 0,
  };
  const { rerender } = render(<CardFace {...props} />);
  expect(screen.getByTitle("Not updated for 30 days").title).toBe("Not updated for 30 days");
  rerender(
    <CardFace {...props} task={{ ...props.task, updated_at: new Date(2026, 9, 7).getTime() }} />,
  );
  expect(screen.queryByText("Stale")).toBeNull();
  for (const status_id of [STATUS.done, STATUS.cancelled]) {
    rerender(<CardFace {...props} task={{ ...props.task, status_id }} />);
    expect(screen.queryByText("Stale")).toBeNull();
  }
});
