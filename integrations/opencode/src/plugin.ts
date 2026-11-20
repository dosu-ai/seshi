/** The OpenCode plugins and command `seshi capture install opencode` writes to
 * `~/.config/opencode/plugins/seshi.js`, `~/.config/opencode/seshi/tui.js` and
 * `~/.config/opencode/command/session-capture.md`.
 *
 * OpenCode runs no shell hooks and keeps its sessions in a database, not in a transcript file.
 * Each plugin file serves both of OpenCode's release lines from one default export: 1.x reads
 * `{id, server}` (`{id, tui}` for the TUI plugin) and 2.x reads `{id, setup}`, each ignoring the
 * other's key.
 *
 * The server plugin, which OpenCode loads in the TUI, `opencode run`, `serve` and `web`, runs
 * `seshi hook opencode Stop` once a turn is over. On 1.x (`session.idle`) it reads the session
 * through OpenCode's own client and hands it over whole, as an export (`{info, messages}`, the
 * shape `opencode export` prints), so seshi writes it to disk only for a captured session; it
 * also toasts whether a new session is captured, and carries out `/session-capture
 * off|on|status|share|unshare`, a command file, before OpenCode sends it to the model (`opencode run --command
 * session-capture`, the web UI, and the TUI's home screen; in a session, the TUI plugin takes it
 * first). On 2.x a plugin cannot read a whole session or toast, so it names the session (in the
 * `experimental.idle` hook, which OpenCode awaits, or when a run ends) and seshi reads it from
 * OpenCode's database; `/session-capture` (the command file, or typed into `opencode run`) is
 * carried out in the `prompt` hook, before anything is sent, and the model gets the result. The
 * 2.x TUI plugin shows the status and takes `/session-capture` as a slash command of its own. */

import { bridgeRuntime, CAPTURE_COMMAND } from "@seshi/kit";

export const PLUGIN_MARKER = "seshi:opencode-plugin";
export const COMMAND_MARKER = "seshi:opencode-command";
export const PLUGIN_VERSION = 6;
export const TUI_PLUGIN_MARKER = "seshi:opencode-tui-plugin";
export const TUI_PLUGIN_VERSION = 4;

export function opencodePlugin(command: readonly string[]): string {
  return `// ${PLUGIN_MARKER} v${PLUGIN_VERSION} -- written by "seshi capture install opencode", which
// rewrites it; "seshi capture uninstall opencode" removes it, so edits do not last.
//
// Session Capture for OpenCode: once each turn is over, the session is handed to seshi, which
// uploads it to your team's session store, or leaves it out as your capture rules say. A toast
// says whether a new session is captured; /session-capture off|on|status turns it off or on for this
// session, and /session-capture share|unshare lets your team read it (or not). OpenCode started with --pure captures nothing. One default export serves OpenCode 1.x
// (server) and 2.x (setup).

import { spawn } from "node:child_process";

const SESHI = ${JSON.stringify(command)};
const AGENT = "opencode";
${bridgeRuntime()}

// OpenCode 1.x.
const server = async ({ client }) => {
  const toast = async (message) => {
    try {
      await client.tui.showToast({
        body: {
          title: "Session Capture",
          message,
          variant: /[◉✓]/.test(message) ? "info" : "warning",
          duration: 6000,
        },
      });
    } catch {}
  };
  // Sessions seshi said it does not capture (turned off, paused, excluded): their turns are not
  // read or handed over. /session-capture on, or a new OpenCode, asks again.
  const notCaptured = new Set();
  // Whether a session seshi said it does not capture still is not, from seshi's status line,
  // without reading the session: capture can be turned on where this plugin does not hear it
  // (the TUI plugin's /session-capture on, \`seshi capture on --session\`).
  const stillOff = async (id, cwd) => {
    if (!notCaptured.has(id)) return false;
    const run = await seshi(
      ["statusline", "--agent", AGENT],
      JSON.stringify({ session_id: id, ...(cwd ? { cwd } : {}) }),
      { env: { NO_COLOR: "1" } },
    );
    if (run.code !== 0 || !run.stdout.includes("◉")) return true;
    notCaptured.delete(id);
    return false;
  };
  const heard = (id, message) => {
    if (message.includes("⏸")) notCaptured.add(id);
    else if (message.includes("◉")) notCaptured.delete(id);
  };
  const session = async (id) => {
    try {
      return (await client.session.get({ path: { id } })).data;
    } catch {
      return undefined;
    }
  };
  return {
    event: async ({ event }) => {
      const properties = event.properties ?? {};
      if (event.type === "session.created") {
        const info = properties.info;
        // A subagent's session is captured with its parent's: no toast for it. Not awaited: the
        // session's first turn need not wait for seshi.
        if (!info?.id || info.parentID) return;
        void seshi(
          ["hook", AGENT, "SessionStart"],
          JSON.stringify({ session_id: info.id, cwd: info.directory }),
        ).then(async (run) => {
          for (const message of messages(run.stdout)) {
            heard(info.id, message);
            await toast(message);
          }
        });
        return;
      }
      if (event.type === "session.idle" && properties.sessionID) {
        // Awaited: \`opencode run\` exits once the turn is over, and seshi must have the session.
        const id = properties.sessionID;
        const info = await session(id);
        if (!info || (await stillOff(id, info.directory))) return;
        if (info.parentID && (await stillOff(info.parentID, info.directory))) return;
        let list;
        try {
          list = (await client.session.messages({ path: { id } })).data;
        } catch {
          return;
        }
        if (!Array.isArray(list)) return;
        await seshi(
          ["hook", AGENT, "Stop"],
          JSON.stringify({
            session_id: id,
            cwd: info.directory,
            ...(info.parentID ? { parent_session_id: info.parentID } : {}),
            export: { info, messages: list },
          }),
        );
      }
    },
    // /session-capture off|on|status|share|unshare: seshi does it here, and the model gets the result instead of the
    // command (OpenCode sends a command's text to the model; it cannot be stopped).
    "command.execute.before": async (input, output) => {
      if (input.command !== "${CAPTURE_COMMAND}") return;
      const info = await session(input.sessionID);
      const run = await seshi(
        ["hook", AGENT, "Command"],
        JSON.stringify({
          session_id: input.sessionID,
          ...(info?.directory ? { cwd: info.directory } : {}),
          arguments: input.arguments ?? "",
        }),
      );
      const said =
        messages(run.stdout)[0] ??
        "Session Capture could not be changed: seshi did not answer (is it installed and on this machine's PATH?)";
      heard(input.sessionID, said);
      await toast(said);
      output.parts.splice(0, output.parts.length, {
        type: "text",
        text: \`\${said}\\n\\n(seshi's /${CAPTURE_COMMAND} command already did this. Reply with one short sentence that says so, and do nothing else.)\`,
      });
    },
  };
};

// OpenCode 2.x: no session.idle, and a plugin can neither read a whole session nor toast. When a
// session's run is over, seshi is told which session it was and reads it from OpenCode's database
// (the release channel says which file). From 2.2.1 that is in the experimental.idle hook, which
// OpenCode awaits before the session goes idle (and before the run's end is announced), so
// \`opencode run\` does not exit (and stop its server) before seshi has the session. A run the hook
// did not hand over does it at its end (an event, not awaited): one that failed or was
// interrupted, which skips that hook, and every run before 2.2.1, which takes the hook's name
// without complaint and never calls it. A session missed even so is found by seshi's sweep of the
// database. /session-capture is a command of the
// plugin's own, run here and never sent to the model; in the TUI, seshi's TUI plugin takes it
// first and says the result.
const ENDED = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

const setup = async (ctx) => {
  const channel = ctx.app?.channel;
  const session = async (id) => {
    try {
      const got = await ctx.session.get({ sessionID: id });
      return got?.data ?? got;
    } catch {
      return undefined;
    }
  };
  const where = (info) => {
    const cwd = info?.location?.directory ?? info?.directory;
    return typeof cwd === "string" && cwd ? { cwd } : {};
  };
  const handOver = async (id) => {
    const info = await session(id);
    await seshi(
      ["hook", AGENT, "Stop"],
      JSON.stringify({
        session_id: id,
        ...where(info),
        ...(info?.parentID ? { parent_session_id: info.parentID } : {}),
        ...(typeof channel === "string" && channel ? { opencode_channel: channel } : {}),
      }),
    );
  };
  // The sessions the idle hook handed over whose run's end has not been announced yet.
  const handed = new Set();
  try {
    await ctx.session.hook("experimental.idle", async (input) => {
      await handOver(input.sessionID);
      handed.add(input.sessionID);
    });
  } catch {}
  const stop = new AbortController();
  // A stream that ends or fails is subscribed to again, after a wait that grows while it keeps
  // failing, until the plugin is disposed: every run's end goes on being heard.
  const wait = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      stop.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  void (async () => {
    for (let delay = 1000; !stop.signal.aborted; delay = Math.min(delay * 2, 60000)) {
      try {
        for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
          delay = 1000;
          if (!ENDED.has(event?.type)) continue;
          const id = event.data?.sessionID ?? event.properties?.sessionID;
          if (typeof id !== "string") continue;
          if (handed.delete(id) && event.type === "session.execution.succeeded") continue;
          await handOver(id);
        }
      } catch {}
      if (!stop.signal.aborted) await wait(delay);
    }
  })();
  // /session-capture: 2.x runs seshi's command file as a prompt (its text, with seshi's marker),
  // and \`opencode run\` sends a typed /session-capture as plain text; seshi carries out either here,
  // before the prompt is sent, and the model gets the result instead of the command.
  try {
    await ctx.session.hook("prompt", async (input) => {
      const text = typeof input.prompt?.text === "string" ? input.prompt.text : "";
      const filed = text.includes("${COMMAND_MARKER}");
      const asked = /(?:^|\\n)\\s*\\/${CAPTURE_COMMAND}\\b([^\\n]*)\\s*$/i.exec(text);
      if (!asked || (!filed && !/^\\s*\\/${CAPTURE_COMMAND}\\b/i.test(text))) return;
      const info = await session(input.sessionID);
      const run = await seshi(
        ["hook", AGENT, "Command"],
        JSON.stringify({
          session_id: input.sessionID,
          ...where(info),
          arguments: asked[1].trim(),
        }),
      );
      const said =
        messages(run.stdout)[0] ??
        "Session Capture could not be changed: seshi did not answer (is it installed and on this machine's PATH?)";
      input.prompt.text = \`\${said}\\n\\n(seshi's /${CAPTURE_COMMAND} command already did this. Reply with one short sentence that says so, and do nothing else.)\`;
    });
  } catch {}
  return () => stop.abort();
};

export default { id: "seshi", server, setup };
`;
}

export function opencodeCommand(): string {
  return `---
description: "Session Capture: turn it off or on for this session, show whether it is captured, or share it with your team (off, on, status, share, unshare)"
---
<!-- ${COMMAND_MARKER}: written by "seshi capture install opencode"; seshi's plugin carries it out. -->
/${CAPTURE_COMMAND} $ARGUMENTS
`;
}

/** The TUI plugin, at `~/.config/opencode/seshi/tui.js` and named in `tui.json`'s `plugin` list
 * (OpenCode's TUI loads no plugin folder of its own, and its server would load this file as a
 * server plugin from `plugins/`). It shows `Session Capture ◉/⏸` beside the prompt for the
 * session in view, from `seshi statusline --agent opencode`, refreshed when the session comes into
 * view and after each turn. And it takes `/session-capture off|on|status|share|unshare` from the
 * prompt itself, on the
 * keys that submit it, so the command never reaches the server and the model does not answer.
 * On the home screen, with no session yet, `/session-capture` goes on to the server's command as before.
 *
 * Plain JavaScript, no JSX: OpenCode maps `@opentui/solid` and `solid-js` to its own copies. */
export function opencodeTuiPlugin(command: readonly string[]): string {
  return `// ${TUI_PLUGIN_MARKER} v${TUI_PLUGIN_VERSION} -- written by "seshi capture install opencode", which
// rewrites it; "seshi capture uninstall opencode" removes it, so edits do not last.
//
// Session Capture in OpenCode's TUI: beside the prompt, whether the session in view is captured
// (◉) or not (⏸); and /session-capture off|on|status|share|unshare, typed in the prompt, carried out by seshi before
// OpenCode sends anything to the model. seshi's server plugin (plugins/seshi.js) does the
// capturing; tui.json's "plugin" list names this file.

import { spawn } from "node:child_process";
import { createElement, insert, setProp } from "@opentui/solid";
import { createEffect, createSignal } from "solid-js";

const SESHI = ${JSON.stringify(command)};
const AGENT = "opencode";
${bridgeRuntime()}

// Only these are taken from the prompt; anything else (an attachment's placeholder text, an
// unknown word) goes on to the server's /session-capture command, attachments and all.
const COMMAND_PATTERN = /^\\/${CAPTURE_COMMAND}(?:\\s+(off|on|status|share|unshare))?$/i;

// seshi's status line up to its first " · ", so it fits beside the prompt.
function short(line) {
  const at = line.indexOf(" · ");
  return at === -1 ? line : line.slice(0, at);
}

// OpenCode 1.x's TUI.
const tui = async (api) => {
    // The status line last read, for the session in view only, by id.
    const [statuses, setStatuses] = createSignal({});
    // Reads can finish out of order: only the latest one started is shown.
    let reads = 0;

    // The session /session-capture and the status are about, with its folder: a subagent's session is
    // captured with its parent's.
    const which = (id) => {
      let top = id;
      for (let i = 0; i < 32; i++) {
        const parent = api.state.session.get(top)?.parentID;
        if (!parent) break;
        top = parent;
      }
      const cwd = api.state.session.get(top)?.directory || api.state.path.directory;
      return { session_id: top, ...(cwd ? { cwd } : {}) };
    };

    const refresh = async (id) => {
      const read = ++reads;
      const run = await seshi(["statusline", "--agent", AGENT], JSON.stringify(which(id)), {
        env: { NO_COLOR: "1" },
      });
      if (read !== reads) return;
      const line = run.code === 0 ? (run.stdout.trim().split("\\n")[0] ?? "") : "";
      setStatuses({ [id]: line });
    };

    // The session in view, when its own prompt is the one shown: not a subagent's (no prompt),
    // and none waiting on a permission or a question (their inputs replace the prompt).
    const prompting = () => {
      const route = api.route.current;
      const id = route.name === "session" ? route.params?.sessionID : undefined;
      if (typeof id !== "string" || api.ui.dialog.open) return undefined;
      if (api.state.session.get(id)?.parentID) return undefined;
      if (api.state.session.permission(id).length > 0) return undefined;
      if (api.state.session.question(id).length > 0) return undefined;
      return id;
    };

    const command = async (id, args) => {
      const run = await seshi(
        ["hook", AGENT, "Command"],
        JSON.stringify({ ...which(id), arguments: args }),
      );
      const said =
        messages(run.stdout)[0] ??
        "Session Capture could not be changed: seshi did not answer (is it installed and on this machine's PATH?)";
      api.ui.toast({
        title: "Session Capture",
        message: said,
        variant: /[◉✓]/.test(said) ? "info" : "warning",
        duration: 6000,
      });
      await refresh(id);
    };

    api.slots.register({
      order: 1000,
      slots: {
        session_prompt_right(_ctx, props) {
          const node = createElement("text");
          createEffect(() => {
            void refresh(props.session_id);
          });
          createEffect(() => {
            const theme = api.theme.current;
            const line = statuses()[props.session_id] ?? "";
            setProp(node, "fg", line.includes("⏸") ? theme.warning : theme.textMuted);
          });
          insert(node, () => short(statuses()[props.session_id] ?? ""));
          return node;
        },
      },
    });

    // After each turn, the session in view, when the turn is its own or a subagent's of it.
    api.lifecycle.onDispose(
      api.event.on("session.idle", (event) => {
        const id = event.properties?.sessionID;
        const route = api.route.current;
        const shown = route.name === "session" ? route.params?.sessionID : undefined;
        if (!id || typeof shown !== "string") return;
        if (which(shown).session_id === which(id).session_id) void refresh(shown);
      }),
    );

    // /session-capture off|on|status|share|unshare, on the keys that submit the prompt, before the prompt sends it. A
    // binding that returns false passes the key on to the prompt.
    // The textarea submits on input.submit ("return" by default); prompt.submit is unbound by
    // default.
    const keys = [];
    for (const name of ["input.submit", "prompt.submit"]) {
      try {
        for (const binding of api.tuiConfig.keybinds.get(name) ?? []) {
          if (binding?.key && !keys.includes(binding.key)) keys.push(binding.key);
        }
      } catch {}
    }
    if (keys.length === 0) keys.push("return");
    api.keymap.registerLayer({
      priority: 100,
      bindings: keys.map((key) => ({
        key,
        cmd: (ctx) => {
          const text = ctx.focused?.plainText;
          const id = prompting();
          if (typeof text !== "string" || !id) return false;
          const asked = COMMAND_PATTERN.exec(text.trim());
          if (!asked) return false;
          // Taken only once the prompt is cleared; if it cannot be, the prompt sends it on.
          if (api.keymap.dispatchCommand("prompt.clear")?.ok !== true) return false;
          void command(id, (asked[1] ?? "").toLowerCase());
          return true;
        },
      })),
    });
};

// OpenCode 2.x's TUI: the status in the prompt's footer, /session-capture as a slash command of
// its own (it runs before the prompt is sent, so the model never sees it), and the toast for a
// new session, which 2.x's server plugins cannot show.
const setup = async (ctx) => {
  const [statuses, setStatuses] = createSignal({});
  let reads = 0;
  const cleanups = [];

  // The session /session-capture and the status are about (a subagent's is captured with its
  // parent's), with its own folder when the TUI has it loaded; never the TUI's folder, which may
  // be another project's: without one, seshi goes by the folder it already knows for the session.
  const which = (id) => {
    let top = id;
    try {
      top = ctx.data.session.root(id) || id;
    } catch {}
    let cwd;
    try {
      cwd = ctx.data.session.get(top)?.location?.directory;
    } catch {}
    return { session_id: top, ...(typeof cwd === "string" && cwd ? { cwd } : {}) };
  };

  const refresh = async (id) => {
    const read = ++reads;
    const run = await seshi(["statusline", "--agent", AGENT], JSON.stringify(which(id)), {
      env: { NO_COLOR: "1" },
    });
    if (read !== reads) return;
    const line = run.code === 0 ? (run.stdout.trim().split("\\n")[0] ?? "") : "";
    setStatuses({ [id]: line });
  };

  const toast = (message) => {
    try {
      ctx.ui.toast.show({
        title: "Session Capture",
        message,
        variant: /[◉✓]/.test(message) ? "info" : "warning",
        duration: 6000,
      });
    } catch {}
  };

  const shown = () => {
    const route = ctx.ui.router.current();
    return route?.type === "session" ? route.sessionID : undefined;
  };

  ctx.ui.slot({
    append: "prompt.footer.status",
    render: (input) => {
      const node = createElement("text");
      createEffect(() => {
        if (input.sessionID) void refresh(input.sessionID);
      });
      createEffect(() => {
        const line = input.sessionID ? (statuses()[input.sessionID] ?? "") : "";
        const text = ctx.theme?.text;
        const color = line.includes("⏸") ? text?.feedback?.warning?.base : text?.muted;
        if (color) setProp(node, "fg", color);
      });
      insert(node, () => (input.sessionID ? short(statuses()[input.sessionID] ?? "") : ""));
      return node;
    },
  });

  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "seshi.session-capture",
        title: "Session Capture",
        description:
          "Turn Session Capture off or on for this session, show whether it is captured, or share it with your team",
        group: "Session",
        slash: { name: "${CAPTURE_COMMAND}", arguments: true },
        async run(input) {
          const id = shown();
          if (!id) {
            toast("Session Capture: open a session first");
            return;
          }
          const args = (input ?? "").replace(/^\\s*\\/?${CAPTURE_COMMAND}\\b/i, "").trim();
          const run = await seshi(
            ["hook", AGENT, "Command"],
            JSON.stringify({ ...which(id), arguments: args.toLowerCase() }),
          );
          toast(
            messages(run.stdout)[0] ??
              "Session Capture could not be changed: seshi did not answer (is it installed and on this machine's PATH?)",
          );
          await refresh(id);
        },
      },
    ],
  }));

  cleanups.push(
    ctx.data.on("session.created", (event) => {
      const data = event.data ?? {};
      if (!data.sessionID || data.parentID) return;
      const cwd = data.location?.directory;
      void seshi(
        ["hook", AGENT, "SessionStart"],
        JSON.stringify({ session_id: data.sessionID, ...(cwd ? { cwd } : {}) }),
      ).then((run) => {
        for (const message of messages(run.stdout)) toast(message);
      });
    }),
  );
  // After each run, the session in view, when the run is its own or a subagent's of it.
  for (const type of [
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
  ]) {
    cleanups.push(
      ctx.data.on(type, (event) => {
        const id = event.data?.sessionID;
        const view = shown();
        if (!id || !view) return;
        if (which(view).session_id === which(id).session_id) void refresh(view);
      }),
    );
  }
  return () => {
    for (const cleanup of cleanups) {
      try {
        cleanup?.();
      } catch {}
    }
  };
};

export default { id: "seshi", tui, setup };
`;
}
