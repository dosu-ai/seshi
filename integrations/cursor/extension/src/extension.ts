import { type FSWatcher, watch } from "node:fs";
import { dirname } from "node:path";
import * as vscode from "vscode";
import { readCursorHooks, seshiProgram } from "./binary";
import { type Focused, focusedConversation, type GroupView } from "./focus";
import { Debouncer, relevantChange } from "./refresh";
import { runSeshi, type StatusJson, statusArgs } from "./seshi";
import { type Action, LABEL, toggled, viewOf } from "./view";

const SELECTED = "composer.getOrderedSelectedComposerIds";
const POLL_MS = 2_000;
const SAFETY_MS = 30_000;
const DOCS = "https://github.com/dosu-ai/seshi/blob/main/docs/capture.md";

let item: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let action: Action = { kind: "status" };
let lastStatus: StatusJson | undefined;
let lastConversation = "";
let internals = true;
let watchers: FSWatcher[] = [];
let watching = "";

function program(): string {
  const setting = vscode.workspace.getConfiguration("seshi").get<string>("command");
  return seshiProgram(setting, readCursorHooks());
}

function folders(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((f) => f.uri.scheme === "file")
    .map((f) => f.uri.fsPath);
}

function groups(): GroupView[] {
  return vscode.window.tabGroups.all.map((g) => ({
    isActive: g.isActive,
    tabs: g.tabs.map((t) => ({
      isActive: t.isActive,
      label: t.label,
      hasInput: t.input !== undefined,
    })),
  }));
}

/** The conversations Cursor says are open, and the one with focus, through an undocumented
 * command; nothing once it fails or the setting turns it off. */
async function conversations(): Promise<{ selected: string[]; focused?: Focused }> {
  const allowed = vscode.workspace
    .getConfiguration("seshi")
    .get<boolean>("useCursorInternals", true);
  if (!internals || !allowed) return { selected: [] };
  try {
    const value = await vscode.commands.executeCommand<unknown>(SELECTED);
    const selected = Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : [];
    const focused = focusedConversation(selected, groups());
    return { selected, ...(focused ? { focused } : {}) };
  } catch (err) {
    internals = false;
    output.appendLine(
      `Cursor's chat list is unavailable (${String(err)}); using the last chat prompted.`,
    );
    return { selected: [] };
  }
}

let title: string | undefined;

async function refresh(): Promise<void> {
  const roots = folders();
  if (roots.length === 0) {
    item.hide();
    return;
  }
  const { selected, focused } = await conversations();
  lastConversation = JSON.stringify([selected, focused?.session_id]);
  title = focused?.title;
  const result = await runSeshi(
    program(),
    statusArgs({ folders: roots, ...(focused ? { focused: focused.session_id } : {}), selected }),
    { cwd: roots[0] as string },
  );
  if (!result.ok) {
    lastStatus = undefined;
    item.text = `$(warning) ${LABEL} · ${result.kind === "missing" ? "seshi not found" : "seshi failed"}`;
    item.tooltip = new vscode.MarkdownString(
      `${result.message}\n\nSet **seshi.command** to the seshi program, or install seshi.`,
    );
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    action = { kind: "setup", message: result.message };
    item.show();
    return;
  }
  const status = result.json as StatusJson;
  lastStatus = status;
  const view = viewOf(status, new Date(), title);
  item.text = view.text;
  item.tooltip = new vscode.MarkdownString(view.tooltip);
  item.backgroundColor = view.background
    ? new vscode.ThemeColor(`statusBarItem.${view.background}Background`)
    : undefined;
  action = view.action;
  item.show();
  watchFolders(status.watch);
}

const debounced = new Debouncer(() => void refresh(), 300);

/** Watch the folders seshi names, not its files: it replaces them by renaming. */
function watchFolders(paths: string[] | undefined): void {
  if (!paths || paths.length < 3) return;
  const key = paths.join("\n");
  if (key === watching) return;
  for (const w of watchers) w.close();
  watchers = [];
  watching = key;
  const [dir, recent, config] = paths as [string, string, string];
  for (const folder of [dir, recent, dirname(config)]) {
    try {
      watchers.push(
        watch(folder, (_event, filename) => {
          if (relevantChange(folder, filename?.toString(), config)) debounced.poke();
        }),
      );
    } catch {
      // Not there yet (no prompt recorded, no config): the safety refresh covers it.
    }
  }
}

async function choose(current: string): Promise<string | undefined> {
  const status = lastStatus;
  const ids = [current, ...(status?.candidates ?? []).map((c) => c.session_id)].filter(
    (id, i, all) => all.indexOf(id) === i,
  );
  const picked = await vscode.window.showQuickPick(
    ids.map((id) => {
      const c = status?.candidates?.find((x) => x.session_id === id);
      return {
        label: `chat ${id.slice(0, 8)}`,
        description: id === current ? "shown" : c?.by === "prompt" ? "last prompted" : c?.by,
        id,
      };
    }),
    { title: "Which chat?", placeHolder: "Cursor did not say which chat is open" },
  );
  return picked?.id;
}

async function toggle(to: "off" | "on", session: string): Promise<void> {
  const result = await runSeshi(
    program(),
    ["capture", to, "--session", session, "--agent", "cursor", "--json"],
    { cwd: folders()[0] as string },
  );
  if (result.ok)
    vscode.window.showInformationMessage(toggled(to, result.json as Record<string, unknown>));
  else vscode.window.showErrorMessage(`${LABEL} could not be turned ${to}: ${result.message}`);
  await refresh();
}

async function showStatus(session?: string): Promise<void> {
  const args = [
    "capture",
    "status",
    ...(session ? ["--session", session, "--agent", "cursor"] : []),
  ];
  output.appendLine(`$ seshi ${args.join(" ")}`);
  const run = await runSeshi(program(), [...args, "--json"], { cwd: folders()[0] as string });
  output.appendLine(run.ok ? JSON.stringify(run.json, null, 2) : run.message);
  output.show(true);
}

async function click(): Promise<void> {
  switch (action.kind) {
    case "toggle": {
      const session = action.pick ? await choose(action.session) : action.session;
      if (session) await toggle(action.to, session);
      return;
    }
    case "explain":
      vscode.window.showInformationMessage(action.message);
      return;
    case "status":
      await showStatus(action.session);
      return;
    case "install": {
      const terminal = vscode.window.createTerminal("seshi");
      terminal.show();
      terminal.sendText(`"${program()}" capture install cursor`);
      return;
    }
    case "setup": {
      const pick = await vscode.window.showWarningMessage(
        action.message,
        "Settings",
        "Install docs",
      );
      if (pick === "Settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "seshi.command");
      } else if (pick === "Install docs") {
        await vscode.env.openExternal(vscode.Uri.parse(DOCS));
      }
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  if (!/cursor/i.test(vscode.env.appName)) return;
  output = vscode.window.createOutputChannel("seshi");
  item = vscode.window.createStatusBarItem("seshi.capture", vscode.StatusBarAlignment.Left, 50);
  item.name = LABEL;
  item.command = "seshi.toggle";
  context.subscriptions.push(
    item,
    output,
    vscode.commands.registerCommand("seshi.toggle", click),
    vscode.commands.registerCommand("seshi.chooseChat", async () => {
      const current = lastStatus?.session?.session_id;
      if (!current || !lastStatus) return;
      const session = await choose(current);
      if (session)
        await toggle(lastStatus.capturing && session === current ? "off" : "on", session);
    }),
    vscode.commands.registerCommand("seshi.showStatus", () =>
      showStatus(lastStatus?.session?.session_id),
    ),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) debounced.poke();
    }),
    vscode.window.tabGroups.onDidChangeTabs(() => debounced.poke()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => debounced.poke()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("seshi")) {
        internals = true;
        debounced.poke();
      }
    }),
    { dispose: () => debounced.dispose() },
    {
      dispose: () => {
        for (const w of watchers) w.close();
      },
    },
  );
  const repoConfig = vscode.workspace.createFileSystemWatcher("**/.seshi/config.toml");
  repoConfig.onDidChange(() => debounced.poke());
  repoConfig.onDidCreate(() => debounced.poke());
  repoConfig.onDidDelete(() => debounced.poke());
  context.subscriptions.push(repoConfig);
  // Cursor sends no event when the open chats change; ask it while the window has focus.
  const poll = setInterval(async () => {
    if (!vscode.window.state.focused) return;
    const { selected, focused } = await conversations();
    if (JSON.stringify([selected, focused?.session_id]) !== lastConversation) debounced.poke();
  }, POLL_MS);
  const safety = setInterval(() => debounced.poke(), SAFETY_MS);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(poll);
      clearInterval(safety);
    },
  });
  void refresh();
}

export function deactivate(): void {}
