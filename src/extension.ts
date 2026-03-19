/**
 * CollabGuard — Split Extension
 *
 * VS Code runs this same file on TWO sides simultaneously when connected via Remote-SSH:
 *
 *   LOCAL (UI side, extensionKind = UI)
 *     → Runs on each developer's own laptop
 *     → Reads username / machineId / hostname from *their* machine
 *     → Exposes private command: collabGuard._getLocalIdentity
 *
 *   REMOTE (Workspace side, extensionKind = Workspace)
 *     → Runs on the shared VPS
 *     → Calls collabGuard._getLocalIdentity (VS Code routes this to the correct local machine)
 *     → Owns the presence file, tree view, status bar, file decorations
 *
 * Key insight: vscode.commands.executeCommand() crosses the local↔remote boundary
 * automatically. The workspace side calls a command registered on the UI side and
 * gets back that specific developer's identity — not a shared one.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── Shared types ─────────────────────────────────────────────────────────────

interface LocalIdentity {
  /** Friendly display name (from setting or hostname fallback) */
  username: string;
  /** Unique per VS Code install — used as presence store key */
  machineId: string;
}

interface UserPresence {
  username: string;
  machineId: string;
  openFiles: string[];
  activeFile: string;
  lastSeen: number;
}

interface PresenceStore {
  version: number;
  /** keyed by machineId — collision-proof even if two devs pick the same display name */
  users: Record<string, UserPresence>;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const kind = context.extension.extensionKind;

  if (kind === vscode.ExtensionKind.UI) {
    activateUIside(context);
  } else {
    // ExtensionKind.Workspace — runs on the VPS
    activateWorkspaceSide(context);
  }
}

export function deactivate(): void { /* subscriptions handle cleanup */ }

// ═══════════════════════════════════════════════════════════════════════════════
// UI SIDE — runs on each developer's laptop
// ═══════════════════════════════════════════════════════════════════════════════

function activateUIside(context: vscode.ExtensionContext): void {
  /**
   * This private command is called by the workspace side.
   * VS Code routes executeCommand() across the local↔remote boundary,
   * so each developer's VPS extension host calls *their own* laptop's command.
   */
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'collabGuard._getLocalIdentity',
      (): LocalIdentity => {
        const username = resolveLocalUsername();
        const machineId = vscode.env.machineId;
        return { username, machineId };
      }
    )
  );

  // Let developer set their display name (stored in LOCAL settings, scope: application)
  context.subscriptions.push(
    vscode.commands.registerCommand('collabGuard.setUsername', async () => {
      const current = resolveLocalUsername();
      const input = await vscode.window.showInputBox({
        prompt: 'Enter your display name shown to teammates',
        value: current,
        placeHolder: 'e.g. Yash',
        validateInput: v => (v.trim() ? null : 'Name cannot be empty')
      });
      if (input?.trim()) {
        await vscode.workspace
          .getConfiguration('collabGuard')
          .update('username', input.trim(), vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          `CollabGuard: Username set to "${input.trim()}". Your teammates will see this name.`
        );
      }
    })
  );

  // First-run hint if no username is configured
  const cfg = vscode.workspace.getConfiguration('collabGuard');
  if (!cfg.get<string>('username')) {
    const hostname = os.hostname();
    vscode.window
      .showInformationMessage(
        `CollabGuard: Using hostname "${hostname}" as your identity. Run "CollabGuard: Set My Username" to set a friendly name.`,
        'Set Now', 'Dismiss'
      )
      .then(choice => {
        if (choice === 'Set Now') {
          vscode.commands.executeCommand('collabGuard.setUsername');
        }
      });
  }
}

function resolveLocalUsername(): string {
  const setting = vscode.workspace
    .getConfiguration('collabGuard')
    .get<string>('username');
  if (setting?.trim()) { return setting.trim(); }
  try { return os.hostname(); } catch { return 'unknown'; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORKSPACE SIDE — runs on the shared VPS
// ═══════════════════════════════════════════════════════════════════════════════

async function activateWorkspaceSide(context: vscode.ExtensionContext): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (!root) {
    // No folder open — nothing to track
    return;
  }

  // Signal to the tree view `when` clause
  vscode.commands.executeCommand('setContext', 'collabGuard.isWorkspace', true);

  // ── Fetch identity from the UI side (crosses local↔remote boundary)
  let identity = await fetchIdentityWithRetry();
  let currentStore: PresenceStore = { version: 1, users: {} };

  // ── Build UI components
  const treeProvider = new PresenceTreeProvider();
  const treeView = vscode.window.createTreeView('collabGuardTree', {
    treeDataProvider: treeProvider,
    showCollapseAll: false
  });
  context.subscriptions.push(treeView);

  const decorator = new PresenceDecorator();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorator)
  );

  const statusBar = new StatusBarManager(context);

  // ── Helpers
  function presencePath(): string {
    const rel =
      vscode.workspace.getConfiguration('collabGuard').get<string>('presenceFile')
      || '.vscode/collab-presence.json';
    return path.join(root!, rel);
  }

  function staleMs(): number {
    return vscode.workspace.getConfiguration('collabGuard')
      .get<number>('staleAfterMs') ?? 15000;
  }

  function pollMs(): number {
    return vscode.workspace.getConfiguration('collabGuard')
      .get<number>('pollIntervalMs') ?? 4000;
  }

  // ── Presence file read/write
  function readStore(): PresenceStore {
    try {
      return JSON.parse(fs.readFileSync(presencePath(), 'utf8')) as PresenceStore;
    } catch {
      return { version: 1, users: {} };
    }
  }

  function writeStore(store: PresenceStore): void {
    try {
      const dir = path.dirname(presencePath());
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
      fs.writeFileSync(presencePath(), JSON.stringify(store, null, 2), 'utf8');
    } catch { /* silent — file may be momentarily locked by another writer */ }
  }

  function pruneStale(store: PresenceStore): void {
    const cutoff = Date.now() - staleMs();
    for (const k of Object.keys(store.users)) {
      if (store.users[k].lastSeen < cutoff) { delete store.users[k]; }
    }
  }

  // ── Publish my presence
  function publishPresence(): void {
    const openFiles = vscode.window.tabGroups.all
      .flatMap(g => g.tabs)
      .map(t => (t.input instanceof vscode.TabInputText ? t.input.uri.fsPath : null))
      .filter((f): f is string => f !== null && f.startsWith(root!));

    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? '';

    const store = readStore();
    pruneStale(store);
    store.users[identity.machineId] = {
      username: identity.username,
      machineId: identity.machineId,
      openFiles,
      activeFile,
      lastSeen: Date.now()
    };
    writeStore(store);
  }

  // ── Refresh all UI from disk
  function refreshUI(): void {
    const store = readStore();
    pruneStale(store);
    currentStore = store;

    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    const others = Object.values(store.users).filter(
      u => u.machineId !== identity.machineId
    );

    treeProvider.update(store, root!, identity);
    decorator.update(others);
    statusBar.update(others, activeFile);
  }

  // ── Full tick: publish then refresh
  function tick(): void {
    publishPresence();
    refreshUI();
  }

  // ── Remove self on shutdown
  function removeSelf(): void {
    try {
      const store = readStore();
      delete store.users[identity.machineId];
      pruneStale(store);
      writeStore(store);
    } catch { /* best-effort */ }
  }

  // ── Event subscriptions
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => tick()),
    vscode.window.tabGroups.onDidChangeTabs(() => tick()),
    vscode.workspace.onDidSaveTextDocument(() => refreshUI())
  );

  // Poll timer — picks up other people's changes
  const timer = setInterval(() => tick(), pollMs());
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // Re-fetch identity if username setting changes (user set it after extension started)
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('collabGuard.username')) {
        identity = await fetchIdentityWithRetry();
        tick();
      }
    })
  );

  // Cleanup on window close
  context.subscriptions.push({ dispose: () => removeSelf() });

  // ── Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('collabGuard.refresh', () => {
      tick();
      vscode.window.showInformationMessage('CollabGuard: Presence refreshed.');
    }),

    vscode.commands.registerCommand('collabGuard.showTeam', () => {
      const others = Object.values(currentStore.users).filter(
        u => u.machineId !== identity.machineId
      );
      if (others.length === 0) {
        vscode.window.showInformationMessage('CollabGuard: No teammates online right now.');
        return;
      }
      const lines = others.map(u => {
        const rel = u.activeFile ? `  ✏️  ${path.relative(root!, u.activeFile)}` : '';
        return `${u.username}  (${u.openFiles.length} file${u.openFiles.length !== 1 ? 's' : ''} open)${rel}`;
      });
      vscode.window.showInformationMessage(
        `Online teammates (${others.length}):\n\n${lines.join('\n')}`,
        { modal: true }
      );
    })
  );

  // ── Go
  tick();
}

/**
 * Calls the UI-side identity command with retries.
 * The UI extension activates slightly after the workspace extension,
 * so we retry a few times before falling back to a safe default.
 */
async function fetchIdentityWithRetry(attempts = 8, delayMs = 800): Promise<LocalIdentity> {
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await vscode.commands.executeCommand<LocalIdentity>(
        'collabGuard._getLocalIdentity'
      );
      if (result?.machineId) { return result; }
    } catch { /* command not registered yet */ }

    if (i < attempts - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // Fallback: use vscode.env.machineId (available on workspace side too),
  // hostname not available here, so use a truncated machineId as display name
  const mid = vscode.env.machineId;
  return {
    username: `dev-${mid.slice(0, 6)}`,
    machineId: mid
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TREE VIEW
// ═══════════════════════════════════════════════════════════════════════════════

type TreeNode = UserNode | FileNode;

class UserNode extends vscode.TreeItem {
  constructor(public readonly presence: UserPresence, isMe: boolean) {
    super(
      isMe ? `${presence.username} (you)` : presence.username,
      vscode.TreeItemCollapsibleState.Expanded
    );
    const secsAgo = Math.round((Date.now() - presence.lastSeen) / 1000);
    this.description = secsAgo < 3 ? 'just now' : `${secsAgo}s ago`;
    this.iconPath = new vscode.ThemeIcon(isMe ? 'account' : 'person');
    this.tooltip = new vscode.MarkdownString(
      `**${presence.username}**\n\nMachine: \`${presence.machineId.slice(0, 8)}…\`\n\nLast seen: ${secsAgo}s ago`
    );
    this.contextValue = 'cgUser';
  }
}

class FileNode extends vscode.TreeItem {
  constructor(filePath: string, root: string, isActive: boolean) {
    const rel = path.relative(root, filePath);
    super(path.basename(rel), vscode.TreeItemCollapsibleState.None);
    this.description = path.dirname(rel) === '.' ? '' : path.dirname(rel);
    this.tooltip = rel;
    this.iconPath = isActive
      ? new vscode.ThemeIcon('edit', new vscode.ThemeColor('charts.orange'))
      : new vscode.ThemeIcon('file');
    this.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [vscode.Uri.file(filePath)]
    };
    this.contextValue = 'cgFile';
  }
}

class PresenceTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChange = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private store: PresenceStore = { version: 1, users: {} };
  private root = '';
  private identity: LocalIdentity = { username: '', machineId: '' };

  update(store: PresenceStore, root: string, identity: LocalIdentity): void {
    this.store = store;
    this.root = root;
    this.identity = identity;
    this._onDidChange.fire(undefined);
  }

  getTreeItem(el: TreeNode): vscode.TreeItem { return el; }

  getChildren(el?: TreeNode): TreeNode[] {
    if (!el) {
      const users = Object.values(this.store.users).sort((a, b) => {
        if (a.machineId === this.identity.machineId) { return -1; }
        if (b.machineId === this.identity.machineId) { return 1; }
        return a.username.localeCompare(b.username);
      });
      return users.map(u => new UserNode(u, u.machineId === this.identity.machineId));
    }
    if (el instanceof UserNode) {
      return el.presence.openFiles.map(
        f => new FileNode(f, this.root, f === el.presence.activeFile)
      );
    }
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILE DECORATOR — initials badge on files open by teammates
// ═══════════════════════════════════════════════════════════════════════════════

class PresenceDecorator implements vscode.FileDecorationProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  /** absPath → teammates who have it open */
  private map = new Map<string, UserPresence[]>();

  update(others: UserPresence[]): void {
    const m = new Map<string, UserPresence[]>();
    for (const u of others) {
      for (const f of u.openFiles) {
        const list = m.get(f) ?? [];
        list.push(u);
        m.set(f, list);
      }
    }
    this.map = m;
    this._onDidChange.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const users = this.map.get(uri.fsPath);
    if (!users?.length) { return undefined; }

    // Badge: initials of up to 2 people, or a count
    const badge = users.length === 1
      ? users[0].username.slice(0, 2).toUpperCase()
      : users.length === 2
        ? users.map(u => u.username[0].toUpperCase()).join('')
        : `${users.length}`;

    // If any of them are actively editing (not just have it open), use stronger color
    const anyActive = users.some(u => u.activeFile === uri.fsPath);

    return {
      badge,
      tooltip: `Open by: ${users.map(u =>
        u.activeFile === uri.fsPath ? `✏️ ${u.username}` : u.username
      ).join(', ')}`,
      color: new vscode.ThemeColor(
        anyActive ? 'charts.orange' : 'charts.blue'
      )
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS BAR
// ═══════════════════════════════════════════════════════════════════════════════

class StatusBarManager {
  private item: vscode.StatusBarItem;

  constructor(ctx: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      200
    );
    this.item.command = 'collabGuard.showTeam';
    ctx.subscriptions.push(this.item);
    this.item.show();
  }

  update(others: UserPresence[], activeFile: string | undefined): void {
    if (others.length === 0) {
      this.item.text = `$(person) solo`;
      this.item.tooltip = 'No teammates online — you have the VPS to yourself';
      this.item.backgroundColor = undefined;
      return;
    }

    // Check if anyone has the currently focused file open
    if (activeFile) {
      const conflict = others.filter(u => u.openFiles.includes(activeFile));
      if (conflict.length > 0) {
        const actively = conflict.filter(u => u.activeFile === activeFile);
        const names = conflict
          .map(u => (u.activeFile === activeFile ? `✏️ ${u.username}` : u.username))
          .join(', ');
        this.item.text = `$(warning) ${names}`;
        this.item.tooltip =
          actively.length > 0
            ? `⚠️ ${actively.map(u => u.username).join(', ')} is actively editing this file!`
            : `${conflict.map(u => u.username).join(', ')} also has this file open`;
        this.item.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        );
        return;
      }
    }

    // Normal: show online count
    this.item.text = `$(person) ${others.length} online`;
    this.item.tooltip = `Teammates: ${others.map(u => u.username).join(', ')} — click for details`;
    this.item.backgroundColor = undefined;
  }
}
