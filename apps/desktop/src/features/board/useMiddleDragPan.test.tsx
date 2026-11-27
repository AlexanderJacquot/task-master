// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useMiddleDragPan } from "./useMiddleDragPan";

function Board() {
  const ref = useMiddleDragPan<HTMLDivElement>();
  return (
    <div ref={ref} data-testid="board">
      <div data-testid="column" style={{ overflowY: "auto" }}>
        <span data-testid="card">card</span>
      </div>
    </div>
  );
}

/** jsdom has no layout: give the element writable scroll offsets and a scrollable height. */
function scrollable(el: HTMLElement, overflowing: boolean) {
  for (const prop of ["scrollLeft", "scrollTop"]) {
    Object.defineProperty(el, prop, { configurable: true, writable: true, value: 100 });
  }
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: overflowing ? 2000 : 0 });
}

afterEach(cleanup);

describe("useMiddleDragPan", () => {
  it("drags the board with the middle button, panning the column under the pointer", () => {
    render(<Board />);
    const board = screen.getByTestId("board");
    const column = screen.getByTestId("column");
    scrollable(board, false);
    scrollable(column, true);

    const down = fireEvent.pointerDown(screen.getByTestId("card"), {
      button: 1,
      pointerId: 1,
      clientX: 300,
      clientY: 300,
    });
    expect(down).toBe(false); // autoscroll cancelled
    expect(board.dataset.panning).toBe("");

    fireEvent.pointerMove(board, { pointerId: 1, clientX: 260, clientY: 330 });
    expect(board.scrollLeft).toBe(140); // dragged left: content follows, view moves right
    expect(column.scrollTop).toBe(70); // dragged down: view moves up
    expect(board.scrollTop).toBe(100);

    fireEvent.pointerUp(board, { pointerId: 1 });
    expect(board.dataset.panning).toBeUndefined();
    fireEvent.pointerMove(board, { pointerId: 1, clientX: 0, clientY: 0 });
    expect(board.scrollLeft).toBe(140);
  });

  it("leaves the primary button alone for card dragging", () => {
    render(<Board />);
    const board = screen.getByTestId("board");
    scrollable(board, false);
    const down = fireEvent.pointerDown(board, { button: 0, pointerId: 1, clientX: 300 });
    expect(down).toBe(true);
    fireEvent.pointerMove(board, { pointerId: 1, clientX: 200 });
    expect(board.scrollLeft).toBe(100);
    expect(fireEvent.mouseDown(board, { button: 1 })).toBe(false);
  });
});
