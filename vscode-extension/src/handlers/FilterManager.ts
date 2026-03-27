import type { EventTypeMap } from "../events";

type EntryType = keyof EventTypeMap;
const ALL_TYPES: ReadonlyArray<EntryType> = [
  "agent_turn",
  "phase_changed",
  "artifact_outcome",
  "checkpoint_triggered",
  "checkpoint_resolved",
  "tool_call",
  "session_changed",
  "connection_state",
] as const;

export class FilterManager {
  private allowed: Set<EntryType> = new Set(ALL_TYPES);

  isAllowed(type: EntryType): boolean {
    return this.allowed.has(type);
  }

  setFilter(types: ReadonlyArray<EntryType>): void {
    this.allowed = new Set(types);
  }

  showAll(): void {
    this.allowed = new Set(ALL_TYPES);
  }

  getAllTypes(): ReadonlyArray<EntryType> {
    return ALL_TYPES;
  }

  getActiveTypes(): ReadonlyArray<EntryType> {
    return ALL_TYPES.filter((t) => this.allowed.has(t));
  }
}
