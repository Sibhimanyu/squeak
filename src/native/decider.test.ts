import { describe, expect, it } from "vitest";

import {
  Decider,
  haikuDecider,
  LocalSimilarity,
  parseModelChoice,
  type DeciderDuck,
  type DeciderModelPort,
  type ModelChoice,
  type SimilarityPort,
} from "./decider.js";

/** Fixed similarity per Duck text: the Duck's first task text is its key. */
function fixed(by: Record<string, number>): SimilarityPort {
  return { similarities: async (_t, texts) => texts.map((t) => by[t] ?? 0) };
}

function fakeModel(answer: ModelChoice | null | Error) {
  const asked: Array<{ ids: string[] }> = [];
  const port: DeciderModelPort = {
    async choose(input) {
      asked.push({ ids: input.ducks.map((d) => d.duckId) });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { port, asked };
}

const duck = (id: string, over: Partial<DeciderDuck> = {}): DeciderDuck => ({
  id,
  name: id,
  open: true,
  busy: false,
  contextPercent: 10,
  tasks: [`${id} work`],
  touched: [],
  ...over,
});

const SMALL = "tweak the icon";
const LARGE = Array.from({ length: 90 }, (_, i) => `word${i}`).join(" ");

describe("decider scoring", () => {
  it("gives a related Task to the Duck, hatches an unrelated one", async () => {
    const d = new Decider({ similarity: fixed({ "a work": 0.8, "b work": 0.05 }) });
    expect(await d.decide(SMALL, [duck("a"), duck("b")])).toMatchObject({ kind: "duck", duckId: "a" });
    const none = new Decider({ similarity: fixed({ "a work": 0.05 }) });
    expect(await none.decide(SMALL, [duck("a")])).toMatchObject({ kind: "hatch" });
  });

  it("hatches when the Pond has no Duck, waits on an empty Task", async () => {
    const d = new Decider();
    expect(await d.decide(SMALL, [])).toMatchObject({ kind: "hatch" });
    expect(await d.decide("   ", [duck("a")])).toMatchObject({ kind: "wait" });
  });

  it("a Duck past half full is penalised heavily, one under half barely", async () => {
    const d = new Decider({ similarity: fixed({ "a work": 0.6, "b work": 0.6 }) });
    const ranked = await d.rank(LARGE, [duck("a", { contextPercent: 85 }), duck("b", { contextPercent: 30 })]);
    expect(ranked[0]!.duckId).toBe("b");
    const a = ranked.find((r) => r.duckId === "a")!;
    const b = ranked.find((r) => r.duckId === "b")!;
    expect(b.contextPenalty).toBeLessThan(0.1);
    expect(a.contextPenalty).toBeGreaterThan(0.4);
    // The same Duck goes from a clear yes to hatching a new one.
    expect((await d.decide(LARGE, [duck("b", { contextPercent: 30 })])).kind).toBe("duck");
    expect((await d.decide(LARGE, [duck("a", { contextPercent: 95 })])).kind).toBe("hatch");
  });

  it("a small, closely related Task still goes to a fairly full Duck", async () => {
    const d = new Decider({ similarity: fixed({ "a work": 0.92 }) });
    const full = duck("a", { contextPercent: 75 });
    expect(await d.decide(SMALL, [full])).toMatchObject({ kind: "duck", duckId: "a" });
    // A large Task with the same similarity does not spare it.
    const big = await d.rank(LARGE, [full]);
    const small = await d.rank(SMALL, [full]);
    expect(big[0]!.contextPenalty).toBeGreaterThan(small[0]!.contextPenalty * 2);
    // And a small Task that is only loosely related is not spared.
    const loose = new Decider({ similarity: fixed({ "a work": 0.3 }) });
    expect((await loose.decide(SMALL, [full])).kind).not.toBe("duck");
  });

  it("busy counts only a little: the better-fitting busy Duck still wins", async () => {
    const d = new Decider({ similarity: fixed({ "a work": 0.75, "b work": 0.7 }) });
    const ranked = await d.rank(SMALL, [duck("a", { busy: true }), duck("b")]);
    expect(ranked.map((r) => r.duckId)).toEqual(["a", "b"]);
    expect(ranked[0]!.busyPenalty).toBeLessThan(0.1);
    expect(await d.decide(SMALL, [duck("a", { busy: true })])).toMatchObject({ kind: "duck", duckId: "a" });
  });

  it("A Closed Duck is as eligible as an open one", async () => {
    const d = new Decider({ similarity: fixed({ "a work": 0.8, "b work": 0.8 }) });
    const [on, off] = await Promise.all([d.rank(SMALL, [duck("a")]), d.rank(SMALL, [duck("b", { open: false })])]);
    expect(off[0]!.score).toBe(on[0]!.score);
    expect(await d.decide(SMALL, [duck("b", { open: false })])).toMatchObject({ kind: "duck", duckId: "b" });
  });

  it("files the Duck touched add to a modest text match", async () => {
    const d = new Decider({ similarity: fixed({ "a work": 0.3, "b work": 0.3 }) });
    const files = ["/app/Sources/IconBadge.swift", "/app/Sources/Toolbar.swift"];
    const ranked = await d.rank("fix the icon badge toolbar", [duck("a", { touched: files }), duck("b")]);
    expect(ranked[0]).toMatchObject({ duckId: "a" });
    expect(ranked[0]!.overlap).toBeGreaterThan(0);
    expect(ranked[0]!.reason).toMatch(/^knows /);
    expect(ranked[1]!.overlap).toBe(0);
  });

  it("the reason names what the Task shares with the Duck's work", async () => {
    const d = new Decider({ similarity: fixed({ "make the icon pixel perfect": 0.9 }) });
    const r = await d.decide("fix the icon", [duck("a", { tasks: ["make the icon pixel perfect"] })]);
    expect(r).toMatchObject({ kind: "duck", reason: "related to icon work" });
  });
});

describe("decider model", () => {
  const unsure = { "a work": 0.35 };

  it("an unsure score asks the model, which may pick a Duck, hatch or wait", async () => {
    const pick = fakeModel({ kind: "duck", duckId: "a" });
    const d = new Decider({ similarity: fixed(unsure), model: pick.port });
    expect(await d.decide(SMALL, [duck("a")])).toMatchObject({ kind: "duck", duckId: "a" });
    expect(pick.asked).toEqual([{ ids: ["a"] }]);

    const hatch = new Decider({ similarity: fixed(unsure), model: fakeModel({ kind: "hatch" }).port });
    expect((await hatch.decide(SMALL, [duck("a")])).kind).toBe("hatch");
    const wait = new Decider({ similarity: fixed(unsure), model: fakeModel({ kind: "wait" }).port });
    expect((await wait.decide(SMALL, [duck("a")])).kind).toBe("wait");
  });

  it("never asks the model for a clear yes or a clear no", async () => {
    const m = fakeModel({ kind: "hatch" });
    const d = new Decider({ similarity: fixed({ "a work": 0.9, "b work": 0.01 }), model: m.port });
    await d.decide(SMALL, [duck("a")]);
    await d.decide(SMALL, [duck("b")]);
    expect(m.asked).toEqual([]);
  });

  it("when the model is unsure, errors, names a Duck it was not shown, or is absent, it hatches", async () => {
    const ports = [
      fakeModel(null).port,
      fakeModel(new Error("down")).port,
      fakeModel({ kind: "duck", duckId: "zz" }).port,
    ];
    for (const port of ports) {
      const d = new Decider({ similarity: fixed(unsure), model: port });
      expect((await d.decide(SMALL, [duck("a")])).kind).toBe("hatch");
    }
    expect((await new Decider({ similarity: fixed(unsure) }).decide(SMALL, [duck("a")])).kind).toBe("hatch");
  });

  it("shows the model only the nearest Ducks, with what they did", async () => {
    let seen: Parameters<DeciderModelPort["choose"]>[0] | undefined;
    const d = new Decider({
      similarity: fixed({ "a work": 0.4, "b work": 0.38, "c work": 0.36, "d work": 0.34, "e work": 0.01 }),
      model: {
        choose: async (i) => {
          seen = i;
          return null;
        },
      },
    });
    await d.decide(
      SMALL,
      ["a", "b", "c", "d", "e"].map((id) => duck(id, { touched: ["/x/Toolbar.swift"] })),
    );
    expect(seen!.ducks.map((x) => x.duckId)).toEqual(["a", "b", "c"]);
    expect(seen!.ducks[0]!.summary).toContain("a work");
    expect(seen!.ducks[0]!.summary).toContain("Toolbar.swift");
  });
});

describe("local similarity", () => {
  it("scores related text above unrelated text", async () => {
    const [rel, unrel] = await new LocalSimilarity().similarities("fix the icon badge colour", [
      "icon badge looks wrong on the toolbar",
      "retry failed stripe webhook events",
    ]);
    expect(rel).toBeGreaterThan(0.2);
    expect(unrel).toBe(0);
  });
});

describe("Haiku adapter contract", () => {
  const input = {
    task: "fix the icon",
    ducks: [
      { duckId: "d1", name: "Pixel", summary: "Did: icon work" },
      { duckId: "d2", name: "Pip", summary: "" },
    ],
  };

  it("sends the Task and the numbered Ducks with the system prompt, and reads the JSON answer", async () => {
    const seen: Array<{ prompt: string; system: string; aborted: boolean }> = [];
    const port = haikuDecider(() => async (i) => {
      seen.push({ prompt: i.prompt, system: i.system, aborted: i.signal.aborted });
      return 'Sure: {"choice":"2"}';
    });
    expect(await port.choose(input)).toEqual({ kind: "duck", duckId: "d2" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.prompt).toContain("fix the icon");
    expect(seen[0]!.prompt).toContain("1. Pixel - Did: icon work");
    expect(seen[0]!.prompt).toContain("2. Pip");
    expect(seen[0]!.system).toContain("hatch");
    expect(seen[0]!.aborted).toBe(false);
  });

  it("reads hatch and wait; anything else is not an answer", () => {
    expect(parseModelChoice('{"choice":"hatch"}', input)).toEqual({ kind: "hatch" });
    expect(parseModelChoice('{"choice":"wait"}', input)).toEqual({ kind: "wait" });
    expect(parseModelChoice('{"choice":1}', input)).toEqual({ kind: "duck", duckId: "d1" });
    expect(parseModelChoice('{"choice":"3"}', input)).toBeNull();
    expect(parseModelChoice('{"choice":"d1"}', input)).toBeNull();
    expect(parseModelChoice("no idea", input)).toBeNull();
    expect(parseModelChoice("{bad json}", input)).toBeNull();
  });

  it("a transport that never answers times out (the decider then hatches)", async () => {
    const port = haikuDecider(() => () => new Promise<string>(() => undefined), 20);
    await expect(port.choose(input)).rejects.toThrow(/timed out/);
    const d = new Decider({ similarity: fixed({ "a work": 0.35 }), model: port });
    expect((await d.decide("tweak the icon", [duck("a")])).kind).toBe("hatch");
  });
});
