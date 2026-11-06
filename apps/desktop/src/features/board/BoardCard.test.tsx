// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { STATUS, statuses, task } from "../../test/fixtures";
import { CardFace } from "./BoardCard";

// The card reads its Claude session from the store.
const api = {} as Api;
const store = createTaskStore(api);
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <StoreProvider store={store} api={api}>
    {children}
  </StoreProvider>
);

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
  const { rerender } = render(<CardFace {...props} />, { wrapper });
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
