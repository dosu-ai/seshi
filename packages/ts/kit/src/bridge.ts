/** The JavaScript, as source text, shared by the add-ons seshi writes into agents that run no
 * shell hooks (pi's extension, OpenCode's plugin). It defines `seshi(args, input, options)`, which
 * runs seshi with `input` on stdin and never rejects, and `messages(stdout)`, what seshi asked to
 * tell the person. The file it goes into imports `spawn` from `node:child_process` and defines
 * `SESHI`, the program and its leading arguments. */
export function bridgeRuntime(): string {
  return String.raw`const HOOK_TIMEOUT_MS = 10000;

// seshi's own variables, inherited from a shell another agent started (a Claude Code session
// sets them), name that agent's session, not this one.
function environment(extra) {
  const env = { ...process.env, ...extra };
  delete env.SESHI_SESSION_ID;
  delete env.SESHI_AGENT;
  return env;
}

function quoted(word) {
  return /^[\w@%+=:,./\\-]+$/.test(word) ? word : '"' + word.replace(/"/g, '""') + '"';
}

// Run seshi with input on stdin. Never rejects: a missing or failing seshi is an exit code.
function seshi(args, input, options = {}) {
  return new Promise((resolve) => {
    const [program, ...rest] = SESHI;
    // A .cmd or .bat shim (npm's, on Windows) runs only through the shell.
    const shell = process.platform === "win32" && !/\.exe$/i.test(program);
    let stdout = "";
    let done = false;
    let child;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    };
    const timer = setTimeout(() => {
      child?.kill();
      finish(-1);
    }, options.timeoutMs ?? HOOK_TIMEOUT_MS);
    const spawnOptions = {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: environment(options.env),
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    };
    try {
      child = shell
        ? spawn([program, ...rest, ...args].map(quoted).join(" "), { ...spawnOptions, shell: true })
        : spawn(program, [...rest, ...args], spawnOptions);
    } catch {
      finish(-1);
      return;
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// What seshi asked to tell the person: one JSON object per line, with "message".
function messages(stdout) {
  const out = [];
  for (const line of stdout.split("\n")) {
    try {
      const said = JSON.parse(line);
      if (said && typeof said.message === "string") out.push(said.message);
    } catch {}
  }
  return out;
}`;
}
