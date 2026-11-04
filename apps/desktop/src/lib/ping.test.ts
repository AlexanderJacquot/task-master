import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { pingCore } = await import("./ping");

describe("pingCore", () => {
  beforeEach(() => invoke.mockReset());

  it("invokes the core ping command and returns its reply", async () => {
    invoke.mockResolvedValue("pong from taskmaster-core v0.1.0");

    await expect(pingCore()).resolves.toBe("pong from taskmaster-core v0.1.0");
    expect(invoke).toHaveBeenCalledWith("ping");
  });
});
