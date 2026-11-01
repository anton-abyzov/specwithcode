import { describe, expect, it } from "vite-plus/test";

import {
  DECISION_STATE_MAX_CHARS,
  decisionTaskState,
  formatProbability,
  parseDecisionResponse,
  readRoutingDecision,
  routingDecisionRequest,
  sureChoice,
} from "./decisionModel.ts";

const choice = (picked: string, probabilities: Record<string, number>) => ({
  type: "choice" as const,
  choice: picked,
  confidence: probabilities[picked] ?? 0,
  probabilities,
});

describe("routingDecisionRequest", () => {
  it("asks the lane and the kind of work about the task's title and brief", () => {
    const request = routingDecisionRequest({ title: "Changelog", text: "Add the 1.0.80 entry" });
    expect(request.state).toBe("Changelog\n\nAdd the 1.0.80 entry");
    expect(Object.keys(request.questions)).toEqual(["lane", "taskClass"]);
    const lane = request.questions.lane;
    expect(lane?.type === "choice" && Object.keys(lane.criteria)).toEqual(["complex", "routine"]);
    const taskClass = request.questions.taskClass;
    expect(taskClass?.type === "choice" && Object.keys(taskClass.criteria)).toContain("code");
  });

  it("cuts a long brief to the state limit", () => {
    expect(decisionTaskState({ text: "x".repeat(DECISION_STATE_MAX_CHARS + 50) })).toHaveLength(
      DECISION_STATE_MAX_CHARS,
    );
  });
});

describe("parseDecisionResponse", () => {
  it("reads a decision response and refuses anything else", () => {
    const body = {
      model: "jev-2026-10",
      answers: {
        lane: choice("routine", { routine: 0.8, complex: 0.2 }),
        urgent: { type: "noul", noul: 0.1 },
      },
      usage: { input_tokens: 40, output_tokens: 0 },
    };
    expect(parseDecisionResponse(body)?.answers.lane).toMatchObject({ choice: "routine" });
    expect(parseDecisionResponse({ detail: "bad key" })).toBeNull();
    expect(parseDecisionResponse("nope")).toBeNull();
  });
});

describe("sureChoice", () => {
  it("acts only on a listed option at the confidence floor or above", () => {
    const allowed = ["complex", "routine"] as const;
    expect(sureChoice(choice("complex", { complex: 0.7, routine: 0.3 }), allowed)).toEqual({
      value: "complex",
      probability: 0.7,
    });
    expect(sureChoice(choice("complex", { complex: 0.69, routine: 0.31 }), allowed)).toBeNull();
    expect(sureChoice(choice("other", { other: 0.99 }), allowed)).toBeNull();
    expect(sureChoice({ type: "noul", noul: 0.99 }, allowed)).toBeNull();
    expect(sureChoice(undefined, allowed)).toBeNull();
  });
});

describe("readRoutingDecision", () => {
  it("never settles on the catch-all class", () => {
    const decided = readRoutingDecision({
      model: "jev-latest",
      answers: {
        lane: choice("complex", { complex: 0.92, routine: 0.08 }),
        taskClass: choice("general", { general: 0.95 }),
      },
    });
    expect(decided.lane).toEqual({ value: "complex", probability: 0.92 });
    expect(decided.taskClass).toBeNull();
  });
});

it("formats a probability as a whole percent", () => {
  expect(formatProbability(0.856)).toBe("86%");
  expect(formatProbability(2)).toBe("100%");
});
