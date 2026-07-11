import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkforceState, type ApplicationState, type StateStore } from "./state";

const SAMPLE_STATE: ApplicationState = {
  characters: {
    alice: { status: "作業中", currentTask: "テスト", progress: 50, updatedAt: "2024-01-01T00:00:00.000Z" },
  },
  tasks: { task1: { id: "task1", title: "Test task" } },
  history: [],
  updatedAt: "2024-01-01T00:00:00.000Z",
};

describe("state CRUD (memory)", () => {
  let ws: WorkforceState;
  beforeEach(() => {
    ws = new WorkforceState();
  });

  it("readState returns null with no cache and no store", () => {
    expect(ws.readState()).toBeNull();
  });

  it("writeState updates cache and returns via readState", () => {
    ws.writeState(SAMPLE_STATE);
    expect(ws.readState()).toEqual(SAMPLE_STATE);
    expect(ws.getStateCache()).toEqual(SAMPLE_STATE);
  });

  it("setStateCache(null) clears cache", () => {
    ws.setStateCache(SAMPLE_STATE);
    ws.setStateCache(null);
    expect(ws.getStateCache()).toBeNull();
  });
});

describe("state store injection", () => {
  it("loadState hydrates the cache on first read", () => {
    const store: StateStore = { loadState: () => SAMPLE_STATE };
    const ws = new WorkforceState(store);
    expect(ws.readState()).toEqual(SAMPLE_STATE);
  });

  it("writeState calls saveState hook", () => {
    const saveState = vi.fn();
    const ws = new WorkforceState({ saveState });
    ws.writeState(SAMPLE_STATE);
    expect(saveState).toHaveBeenCalledWith(SAMPLE_STATE);
  });
});

describe("activity", () => {
  let ws: WorkforceState;
  beforeEach(() => {
    ws = new WorkforceState();
  });

  it("addActivity stamps receivedAt and prepends", () => {
    ws.addActivity({ type: "event-a" });
    ws.addActivity({ type: "event-b" });
    const activities = ws.readActivity();
    expect(activities[0]!.type).toBe("event-b");
    expect(activities[0]!).toHaveProperty("receivedAt");
  });

  it("caps activity list at 50 entries", () => {
    for (let i = 0; i < 60; i++) ws.addActivity({ type: `event-${i}` });
    expect(ws.readActivity().length).toBeLessThanOrEqual(50);
  });
});

describe("commands", () => {
  it("saveCommand prepends and caps at 100 via injected store", () => {
    let stored: Record<string, unknown>[] = Array.from({ length: 100 }, (_, i) => ({ cmd: `/cmd-${i}` }));
    const store: StateStore = {
      loadCommands: () => stored,
      saveCommands: (c) => {
        stored = c;
      },
    };
    const ws = new WorkforceState(store);
    ws.saveCommand({ cmd: "/new" });
    expect(stored[0]!.cmd).toBe("/new");
    expect(stored.length).toBe(100);
  });
});

describe("broadcastNotification / broadcastStateChange (SSE, verbatim)", () => {
  it("enqueues data to all SSE clients", () => {
    const ws = new WorkforceState();
    const enqueue = vi.fn();
    ws.sseClients.set("client-1", { enqueue } as never);
    ws.broadcastNotification({
      id: "notif-1",
      type: "info",
      title: "Test",
      message: "Hello",
      read: false,
      user_id: "user-1",
      created_at: new Date().toISOString(),
    });
    expect(enqueue).toHaveBeenCalled();
  });

  it("removes failing clients from the sseClients map", () => {
    const ws = new WorkforceState();
    ws.sseClients.set("bad", {
      enqueue: vi.fn().mockImplementation(() => {
        throw new Error("closed");
      }),
    } as never);
    ws.broadcastNotification({
      id: "n",
      type: "info",
      title: "T",
      message: "M",
      read: false,
      user_id: "u",
      created_at: new Date().toISOString(),
    });
    expect(ws.sseClients.has("bad")).toBe(false);
  });

  it("broadcastStateChange emits a state-change event", () => {
    const ws = new WorkforceState();
    const enqueue = vi.fn();
    ws.sseClients.set("client-x", { enqueue } as never);
    ws.broadcastStateChange();
    const encoded = enqueue.mock.calls[0]![0] as Uint8Array;
    const text = new TextDecoder().decode(encoded);
    expect(text).toContain("state-change");
  });
});

describe("sessions", () => {
  it("tracks AI社員 sessions", () => {
    const ws = new WorkforceState();
    ws.sessions.set("sess-1", {
      sessionId: "sess-1",
      state: "working",
      message: "coding",
      characterId: "alice",
      workingDir: "/workspace",
      updatedAt: new Date().toISOString(),
    });
    expect(ws.sessions.get("sess-1")?.characterId).toBe("alice");
  });
});

describe("initializeState", () => {
  it("starts every provided AI社員 at 完了/100%", () => {
    const ws = new WorkforceState();
    const state = ws.initializeState(["alice", "bob"]);
    expect(Object.keys(state.characters)).toEqual(["alice", "bob"]);
    expect(state.characters.alice!.status).toBe("完了");
    expect(state.characters.bob!.progress).toBe(100);
  });
});
