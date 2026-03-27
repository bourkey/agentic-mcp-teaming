import { describe, it, expect } from "vitest";
import { AgentRegistry } from "../src/core/registry.js";

const fullRegistry = {
  architect: { cli: "claude", specialty: "design", canReview: true, canRevise: true, canImplement: false, allowSubInvocation: true },
  security: { cli: "claude", specialty: "security", canReview: true, canRevise: false, canImplement: false, allowSubInvocation: false },
  implementer: { cli: "codex", canReview: true, canRevise: true, canImplement: true, allowSubInvocation: true },
  tester: { cli: "codex", canReview: true, canRevise: false, canImplement: true, allowSubInvocation: false },
};

describe("AgentRegistry — task 2.3", () => {
  it("looks up a known agent", () => {
    const reg = new AgentRegistry(fullRegistry);
    expect(reg.get("architect")?.cli).toBe("claude");
    expect(reg.get("architect")?.specialty).toBe("design");
  });

  it("returns undefined for unknown agent", () => {
    const reg = new AgentRegistry(fullRegistry);
    expect(reg.get("unknown")).toBeUndefined();
  });

  it("checks sub-invocation permission correctly", () => {
    const reg = new AgentRegistry(fullRegistry);
    expect(reg.allowsSubInvocation("architect")).toBe(true);
    expect(reg.allowsSubInvocation("security")).toBe(false);
    expect(reg.allowsSubInvocation("nonexistent")).toBe(false);
  });

  it("returns reviewers (all have canReview: true)", () => {
    const reg = new AgentRegistry(fullRegistry);
    const reviewers = reg.reviewers();
    expect(reviewers).toContain("architect");
    expect(reviewers).toContain("security");
    expect(reviewers).toContain("implementer");
    expect(reviewers).toContain("tester");
  });

  it("returns only revisers (canRevise: true)", () => {
    const reg = new AgentRegistry(fullRegistry);
    const revisers = reg.revisers();
    expect(revisers).toContain("architect");
    expect(revisers).toContain("implementer");
    expect(revisers).not.toContain("security");
    expect(revisers).not.toContain("tester");
  });

  it("returns only implementers (canImplement: true)", () => {
    const reg = new AgentRegistry(fullRegistry);
    const implementers = reg.implementers();
    expect(implementers).toContain("implementer");
    expect(implementers).toContain("tester");
    expect(implementers).not.toContain("architect");
    expect(implementers).not.toContain("security");
  });

  it("throws on empty registry", () => {
    expect(() => new AgentRegistry({})).toThrow(/empty/);
  });

  it("throws when no reviser is configured", () => {
    expect(() => new AgentRegistry({
      reviewer: { cli: "claude", canReview: true, canRevise: false, canImplement: true, allowSubInvocation: false },
    })).toThrow(/canRevise/);
  });

  it("throws when no implementer is configured", () => {
    expect(() => new AgentRegistry({
      reviewer: { cli: "claude", canReview: true, canRevise: true, canImplement: false, allowSubInvocation: false },
    })).toThrow(/canImplement/);
  });

  it("exposes all agents via all()", () => {
    const reg = new AgentRegistry(fullRegistry);
    expect(reg.all().size).toBe(4);
  });
});
