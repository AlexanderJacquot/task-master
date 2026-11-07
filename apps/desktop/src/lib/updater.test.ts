import { describe, expect, it } from "vitest";
import { type AvailableUpdate, createUpdateStore, type UpdateSource } from "./updater";

function fakeUpdate(install: AvailableUpdate["install"]): AvailableUpdate {
  return { version: "0.3.0", notes: "Faster board", date: null, install };
}

function source(check: UpdateSource["check"]): UpdateSource & { relaunched: number } {
  const s = {
    relaunched: 0,
    check,
    relaunch: async () => {
      s.relaunched += 1;
    },
  };
  return s;
}

describe("update store", () => {
  it("leaves updates to the package manager that owns the install", async () => {
    let checks = 0;
    const src = source(async () => {
      checks += 1;
      return fakeUpdate(async () => {});
    });
    const store = createUpdateStore({
      ...src,
      managedBy: async () => "the AUR package task-master-bin",
    });
    await store.getState().check();
    await store.getState().check({ quiet: true });
    await store.getState().install();
    expect(store.getState().status).toEqual({
      kind: "managed",
      by: "the AUR package task-master-bin",
    });
    expect(checks).toBe(0);
  });

  it("checks GitHub when the managed lookup fails", async () => {
    const store = createUpdateStore({
      ...source(async () => null),
      managedBy: () => Promise.reject(new Error("no config")),
    });
    await store.getState().check();
    expect(store.getState().status.kind).toBe("current");
  });

  it("reports when this build is the latest", async () => {
    const store = createUpdateStore(source(async () => null));
    await store.getState().check();
    expect(store.getState().status.kind).toBe("current");
  });

  it("downloads with progress, then restarts on request", async () => {
    const seen: Array<number | null> = [];
    const update = fakeUpdate(async (progress) => {
      progress(null);
      progress(0.5);
      progress(1);
    });
    const src = source(async () => update);
    const store = createUpdateStore(src);
    store.subscribe((s) => {
      if (s.status.kind === "installing") seen.push(s.status.progress);
    });
    await store.getState().check();
    expect(store.getState().status).toMatchObject({
      kind: "available",
      update: { version: "0.3.0" },
    });
    await store.getState().install();
    expect(seen).toEqual([null, null, 0.5, 1]);
    expect(store.getState().status.kind).toBe("ready");
    await store.getState().restart();
    expect(src.relaunched).toBe(1);
  });

  it("shows check errors, except for the quiet startup check", async () => {
    const failing = () => Promise.reject(new Error("offline"));
    const store = createUpdateStore(source(failing));
    await store.getState().check({ quiet: true });
    expect(store.getState().status.kind).toBe("idle");
    await store.getState().check();
    expect(store.getState().status).toEqual({ kind: "error", message: "offline", during: "check" });
  });

  it("lets a failed install be retried", async () => {
    let attempts = 0;
    const update = fakeUpdate(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("bad signature")) : Promise.resolve();
    });
    const store = createUpdateStore(source(async () => update));
    await store.getState().check();
    await store.getState().install();
    expect(store.getState().status).toMatchObject({ kind: "error", during: "install" });
    await store.getState().install();
    expect(store.getState().status.kind).toBe("ready");
    expect(attempts).toBe(2);
  });
});
