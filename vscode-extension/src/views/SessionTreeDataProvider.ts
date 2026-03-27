import * as vscode from "vscode";
import type { ExtensionEventBus } from "../bus/ExtensionEventBus";

const PHASES = ["proposal", "design", "spec", "task", "implementation", "review"] as const;
type Phase = (typeof PHASES)[number];

interface ArtifactInfo {
  artifactId: string;
  outcome: string;
  round: number;
  awaitingDecision: boolean;
}

interface PhaseInfo {
  name: Phase;
  current: boolean;
  done: boolean;
  artifacts: Map<string, ArtifactInfo>;
}

type TreeNode = PhaseNode | ArtifactNode | MessageNode;

class PhaseNode {
  constructor(readonly info: PhaseInfo) {}

  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(
      this.info.name,
      this.info.artifacts.size > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.iconPath = this.info.done
      ? new vscode.ThemeIcon("check")
      : this.info.current
        ? new vscode.ThemeIcon("loading~spin")
        : new vscode.ThemeIcon("circle-outline");
    return item;
  }
}

class ArtifactNode {
  constructor(readonly info: ArtifactInfo) {}

  toTreeItem(): vscode.TreeItem {
    const label = this.info.awaitingDecision
      ? `${this.info.artifactId} — Awaiting human decision`
      : `${this.info.artifactId} [${this.info.outcome}] r${this.info.round}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    if (this.info.awaitingDecision) {
      item.iconPath = new vscode.ThemeIcon("warning");
    } else if (this.info.outcome === "consensus-reached" || this.info.outcome === "human-approved") {
      item.iconPath = new vscode.ThemeIcon("check");
    } else if (this.info.outcome === "aborted") {
      item.iconPath = new vscode.ThemeIcon("x");
    } else {
      item.iconPath = new vscode.ThemeIcon("circle-filled");
    }
    return item;
  }
}

class MessageNode {
  constructor(private readonly text: string) {}

  toTreeItem(): vscode.TreeItem {
    return new vscode.TreeItem(this.text, vscode.TreeItemCollapsibleState.None);
  }
}

export class SessionTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private phases: Map<Phase, PhaseInfo> = new Map();
  private currentPhase: Phase | null = null;
  private sessionId: string | null = null;

  constructor(bus: ExtensionEventBus, context: vscode.ExtensionContext) {
    this.reset();
    context.subscriptions.push(this._onDidChangeTreeData);

    bus.subscribe("phase_changed", (event) => {
      const prev = this.phases.get(event.fromPhase as Phase);
      if (prev) prev.done = true;
      this.currentPhase = event.toPhase as Phase;
      const curr = this.phases.get(this.currentPhase);
      if (curr) curr.current = true;
      this._onDidChangeTreeData.fire();
    }, context);

    bus.subscribe("checkpoint_triggered", (event) => {
      const phaseInfo = this.findOrCurrentPhase(event.artifactId);
      if (phaseInfo) {
        const art = phaseInfo.artifacts.get(event.artifactId) ?? {
          artifactId: event.artifactId,
          outcome: "pending",
          round: 0,
          awaitingDecision: false,
        };
        art.awaitingDecision = true;
        phaseInfo.artifacts.set(event.artifactId, art);
        this._onDidChangeTreeData.fire();
      }
    }, context);

    bus.subscribe("checkpoint_resolved", (event) => {
      for (const phase of this.phases.values()) {
        const art = phase.artifacts.get(event.artifactId);
        if (art) {
          art.awaitingDecision = false;
          art.outcome = event.outcome;
          this._onDidChangeTreeData.fire();
          break;
        }
      }
    }, context);

    bus.subscribe("artifact_outcome", (event) => {
      const phaseInfo = this.findOrCurrentPhase(event.artifactId);
      if (phaseInfo) {
        const existing = phaseInfo.artifacts.get(event.artifactId);
        phaseInfo.artifacts.set(event.artifactId, {
          artifactId: event.artifactId,
          outcome: event.outcome,
          round: event.rounds,
          awaitingDecision: existing?.awaitingDecision ?? false,
        });
        this._onDidChangeTreeData.fire();
      }
    }, context);

    bus.subscribe("session_changed", (event) => {
      this.sessionId = event.sessionId;
      this.reset();
      this._onDidChangeTreeData.fire();
    }, context);

    bus.subscribe("agent_turn", (event) => {
      const phaseInfo = this.phases.get(event.phase as Phase);
      if (phaseInfo) {
        const existing = phaseInfo.artifacts.get(event.artifactId);
        phaseInfo.artifacts.set(event.artifactId, {
          artifactId: event.artifactId,
          outcome: existing?.outcome ?? "in-progress",
          round: event.round,
          awaitingDecision: existing?.awaitingDecision ?? false,
        });
        this._onDidChangeTreeData.fire();
      }
    }, context);
  }

  private reset(): void {
    this.phases.clear();
    this.currentPhase = null;
    for (const phase of PHASES) {
      this.phases.set(phase, { name: phase, current: false, done: false, artifacts: new Map() });
    }
  }

  private findOrCurrentPhase(artifactId: string): PhaseInfo | undefined {
    for (const phase of this.phases.values()) {
      if (phase.artifacts.has(artifactId)) return phase;
    }
    return this.currentPhase !== null ? this.phases.get(this.currentPhase) : undefined;
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element.toTreeItem();
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!this.sessionId) {
      return [new MessageNode("No active session — run 'Coordinator: Start' to begin")];
    }
    if (element === undefined) {
      return PHASES.map((phase) => new PhaseNode(this.phases.get(phase)!));
    }
    if (element instanceof PhaseNode) {
      return [...element.info.artifacts.values()].map((art) => new ArtifactNode(art));
    }
    return [];
  }
}
