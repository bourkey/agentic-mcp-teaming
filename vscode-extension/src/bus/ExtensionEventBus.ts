import * as vscode from "vscode";
import type { EventType, EventTypeMap } from "../events";

export class ExtensionEventBus {
  private readonly emitters = new Map<string, vscode.EventEmitter<unknown>>();

  private emitter<T extends EventType>(type: T): vscode.EventEmitter<EventTypeMap[T]> {
    if (!this.emitters.has(type)) {
      this.emitters.set(type, new vscode.EventEmitter<EventTypeMap[T]>());
    }
    return this.emitters.get(type) as vscode.EventEmitter<EventTypeMap[T]>;
  }

  publish<T extends EventType>(event: EventTypeMap[T]): void {
    this.emitter(event.type as T).fire(event);
  }

  subscribe<T extends EventType>(
    type: T,
    handler: (event: EventTypeMap[T]) => void,
    context: vscode.ExtensionContext,
  ): vscode.Disposable {
    const disposable = this.emitter(type).event(handler);
    context.subscriptions.push(disposable);
    return disposable;
  }

  dispose(): void {
    for (const emitter of this.emitters.values()) {
      emitter.dispose();
    }
    this.emitters.clear();
  }
}
