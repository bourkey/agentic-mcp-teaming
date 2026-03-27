export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];

  readonly event = (listener: (e: T) => void): Disposable => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  };

  fire(data: T): void {
    for (const l of this.listeners) l(data);
  }

  dispose(): void {
    this.listeners = [];
  }
}

export class Disposable {
  static from(...disposables: { dispose(): void }[]): Disposable {
    return new Disposable(() => { for (const d of disposables) d.dispose(); });
  }

  constructor(private readonly fn: () => void) {}
  dispose(): void { this.fn(); }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  iconPath?: ThemeIcon | string;
  command?: { command: string; title: string };
  constructor(
    public label: string,
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export const window = {
  createStatusBarItem: (_alignment?: StatusBarAlignment, _priority?: number) => ({
    text: "",
    command: undefined as string | undefined,
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
  createTreeView: (_id: string, _opts: unknown) => ({
    dispose: () => {},
  }),
  createOutputChannel: (_name: string) => ({
    appendLine: (_line: string) => {},
    show: () => {},
    dispose: () => {},
  }),
  createWebviewPanel: (_viewType: string, _title: string, _column: unknown, _opts: unknown) => ({
    webview: {
      html: "",
      postMessage: async (_msg: unknown) => true,
    },
    reveal: () => {},
    onDidDispose: (_fn: () => void) => ({ dispose: () => {} }),
    dispose: () => {},
  }),
  createTerminal: (_name: string) => ({
    show: () => {},
    sendText: (_text: string) => {},
    dispose: () => {},
  }),
  showInformationMessage: async (_msg: string, ..._buttons: string[]): Promise<string | undefined> => undefined,
  showErrorMessage: async (_msg: string, ..._buttons: string[]): Promise<string | undefined> => undefined,
  showQuickPick: async (_items: unknown, _opts?: unknown): Promise<unknown> => undefined,
};

export const workspace = {
  workspaceFolders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
};

export const commands = {
  registerCommand: (_id: string, _fn: (...args: unknown[]) => unknown) => ({ dispose: () => {} }),
};

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
}

export type ExtensionContext = {
  subscriptions: { dispose(): void }[];
  extensionUri: { fsPath: string };
};
