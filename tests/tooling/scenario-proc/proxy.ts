/** A TCP proxy between seshi's clients (the uploader, the CLI, the doctor) and `seshi serve`, that
 * breaks HTTP on the wire. Built on `Bun.listen` and `Bun.connect`: each client connection gets
 * its own connection to the server, the request head is read to know the method and path, and
 * `Connection: close` is put in it so every connection carries one request and the end of the
 * server's answer is the end of the connection.
 *
 * A rule matches by method and path (`*` globs) and counts the requests that match from the
 * moment it is armed; it fires on the `nth` and for `times` matches (or `always`), as the
 * in-process faults do. What it does:
 *
 * - `delay`: hold the request that long, then forward it;
 * - `close-request`: forward the head and N bytes of the body, then close both sides (N = -1:
 *   close before anything reaches the server: a reset);
 * - `close-response`: forward the request, then N bytes of the answer, then close;
 * - `status`: answer with a canned status (and error code) without asking the server;
 * - `drop-response`: forward the request, wait for the whole answer (the server committed), and
 *   close without passing it on;
 * - `kill-client`: forward the head and N bytes of the body (or all of it), then SIGKILL the
 *   client process through the callback, so the kill lands at a precise point of a chunk;
 * - `kill-server`: forward the head and N bytes (or all), then kill the server through the
 *   callback while the request is in flight.
 */

import type { Socket, TCPSocketListener } from "bun";

export type ProxyAction =
  | { kind: "delay"; ms: number }
  | { kind: "close-request"; bytes: number }
  | { kind: "close-response"; bytes: number }
  | { kind: "status"; status: number; code?: string; expected?: number }
  | { kind: "drop-response" }
  | { kind: "kill-client"; bytes: number | "all" }
  | { kind: "kill-server"; bytes: number | "all" };

export interface ProxyRule {
  /** Words for reports. */
  label: string;
  method?: string;
  path: RegExp;
  nth: number;
  times: number | "always";
  seen: number;
  fired: number;
  action: ProxyAction;
}

export interface ProxyRequest {
  /** Its number, from 1, over the proxy's life. */
  n: number;
  method: string;
  path: string;
  /** The rule that fired on it. */
  rule?: string;
  /** The status the server (or a `status` rule) answered, once known. */
  status?: number;
  /** How it ended: `answered`, or what the rule did. */
  outcome?: string;
}

export interface ProxyHooks {
  /** SIGKILL the client process (the uploader) and resolve once it is gone. */
  killClient(): Promise<void>;
  /** Kill the server process and resolve once it is gone. */
  killServer(): Promise<void>;
}

/** `*` matches any run of characters, `/` included. */
export function globRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

const CRLF2 = Buffer.from("\r\n\r\n");

interface Head {
  method: string;
  path: string;
  /** The head as forwarded: `Connection: close` in place of any connection header. */
  bytes: Buffer;
  /** Body length, or chunked. */
  body: number | "chunked";
}

function parseHead(raw: Buffer): Head | null {
  const text = raw.toString("latin1");
  const lines = text.split("\r\n");
  const [method, target] = (lines[0] ?? "").split(" ");
  if (!method || !target) return null;
  let body: number | "chunked" = 0;
  const kept: string[] = [lines[0] as string];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const colon = line.indexOf(":");
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "connection" || name === "keep-alive") continue;
    if (name === "content-length") body = Number.parseInt(value, 10) || 0;
    if (name === "transfer-encoding" && /chunked/i.test(value)) body = "chunked";
    kept.push(line);
  }
  kept.push("Connection: close", "", "");
  const path = target.startsWith("http") ? new URL(target).pathname : target.split("?")[0];
  return { method, path: path as string, bytes: Buffer.from(kept.join("\r\n"), "latin1"), body };
}

/** Where a chunked body ends, if it has ended within `data` (the body so far). */
function chunkedEnd(data: Buffer): number | undefined {
  let at = 0;
  for (;;) {
    const eol = data.indexOf("\r\n", at, "latin1");
    if (eol === -1) return undefined;
    const size = Number.parseInt(data.subarray(at, eol).toString("latin1").split(";")[0] ?? "", 16);
    if (Number.isNaN(size)) return undefined;
    if (size === 0) {
      // Trailers, then an empty line.
      const end = data.indexOf(CRLF2, eol, "latin1");
      if (end !== -1) return end + 4;
      return data.length >= eol + 4 && data.subarray(eol, eol + 4).equals(CRLF2)
        ? eol + 4
        : undefined;
    }
    const next = eol + 2 + size + 2;
    if (data.length < next) return undefined;
    at = next;
  }
}

/** Reads a server's answer as it streams: the status, and where it ends (its length, chunked
 * framing, or the close). The head is passed on with `Connection: close` in place of any
 * connection header, so the client never reuses the connection the proxy closes. */
class ResponseReader {
  private head = Buffer.alloc(0);
  private parsed = false;
  private length: number | "chunked" | "close" = "close";
  private received = 0;
  private chunks = Buffer.alloc(0);
  status: number | undefined;
  done = false;

  constructor(private readonly headRequest = false) {}

  /** The bytes to pass on for `data`. */
  feed(data: Buffer): Buffer {
    let prefix = Buffer.alloc(0);
    let body = data;
    if (!this.parsed) {
      this.head = Buffer.concat([this.head, data]);
      const end = this.head.indexOf(CRLF2);
      if (end === -1) return Buffer.alloc(0);
      const lines = this.head.subarray(0, end).toString("latin1").split("\r\n");
      this.status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? "")?.[1]) || undefined;
      const kept = [lines[0] as string];
      let length: number | "chunked" | "close" = "close";
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === "connection" || name === "keep-alive") continue;
        if (name === "content-length") length = Number.parseInt(value, 10) || 0;
        if (name === "transfer-encoding" && /chunked/i.test(value)) length = "chunked";
        kept.push(line);
      }
      const status = this.status ?? 200;
      if (this.headRequest || status === 204 || status === 304 || status < 200) length = 0;
      this.length = length;
      kept.push("Connection: close", "", "");
      prefix = Buffer.from(kept.join("\r\n"), "latin1");
      body = this.head.subarray(end + 4);
      this.parsed = true;
    }
    if (typeof this.length === "number") {
      const take = Math.min(body.length, this.length - this.received);
      this.received += take;
      body = body.subarray(0, take);
      if (this.received >= this.length) this.done = true;
    } else if (this.length === "chunked") {
      this.chunks = Buffer.concat([this.chunks, body]);
      const end = chunkedEnd(this.chunks);
      if (end !== undefined) {
        body = body.subarray(0, body.length - (this.chunks.length - end));
        this.done = true;
      }
    }
    return Buffer.concat([prefix, body]);
  }
}

/** Writes with backpressure: what a socket does not take now waits for its drain. */
class Out {
  private readonly queue: Buffer[] = [];
  private ending = false;
  closed = false;
  socket: Socket<unknown> | undefined;

  write(data: Buffer): void {
    if (this.closed || data.length === 0) return;
    this.queue.push(data);
    this.flush();
  }

  flush(): void {
    const socket = this.socket;
    if (!socket || this.closed) return;
    while (this.queue.length > 0) {
      const next = this.queue[0] as Buffer;
      const n = socket.write(next);
      if (n < 0) {
        this.closed = true;
        return;
      }
      if (n < next.length) {
        this.queue[0] = next.subarray(n);
        return;
      }
      this.queue.shift();
    }
    if (this.ending) {
      this.closed = true;
      socket.end();
    }
  }

  get pending(): number {
    return this.queue.reduce((n, b) => n + b.length, 0);
  }

  /** End once everything queued is written. */
  end(): void {
    this.ending = true;
    this.flush();
  }

  /** Close now, dropping anything queued. */
  abort(): void {
    this.queue.length = 0;
    this.closed = true;
    try {
      this.socket?.end();
    } catch {}
  }
}

type Phase = "head" | "waiting" | "body" | "done";

/** One client connection and the server connection made for it. */
class Conn {
  phase: Phase = "head";
  head: Head | undefined;
  /** Client bytes not yet handled (the head while it is read, the body while held). */
  buffer = Buffer.alloc(0);
  /** Body bytes received from the client so far (all of them, for chunked framing). */
  bodySeen = Buffer.alloc(0);
  bodyForwarded = 0;
  responseBytes = 0;
  rule: ProxyRule | undefined;
  request: ProxyRequest | undefined;
  readonly client = new Out();
  readonly server = new Out();
  serverSocket: Socket<unknown> | undefined;
  /** Forwarding stopped for good (a rule cut it). */
  cut = false;
  response = new ResponseReader();

  constructor(readonly proxy: FaultProxy) {}

  private get action(): ProxyAction | undefined {
    return this.rule?.action;
  }

  /** The body has fully arrived from the client. */
  private bodyComplete(): boolean {
    const head = this.head as Head;
    if (head.body === "chunked") return chunkedEnd(this.bodySeen) !== undefined;
    return this.bodySeen.length >= head.body;
  }

  onClientData(data: Buffer): void {
    if (this.cut) return;
    if (this.phase === "head") {
      this.buffer = Buffer.concat([this.buffer, data]);
      const end = this.buffer.indexOf(CRLF2);
      if (end === -1) return;
      const head = parseHead(this.buffer.subarray(0, end + 4));
      const rest = this.buffer.subarray(end + 4);
      this.buffer = Buffer.alloc(0);
      if (!head) {
        this.client.abort();
        return;
      }
      this.head = head;
      this.response = new ResponseReader(head.method === "HEAD");
      this.rule = this.proxy.match(head.method, head.path);
      this.request = this.proxy.record(head.method, head.path, this.rule?.label);
      this.phase = "waiting";
      this.bodySeen = Buffer.from(rest);
      this.buffer = Buffer.from(rest);
      void this.start();
      return;
    }
    this.bodySeen = Buffer.concat([this.bodySeen, data]);
    this.buffer = Buffer.concat([this.buffer, data]);
    if (this.phase === "body") this.pump();
    else if (this.phase === "done" && this.action?.kind === "status") this.maybeAnswer();
  }

  private get bodyTotal(): string {
    const body = this.head?.body;
    return body === "chunked" ? "a chunked" : String(body ?? 0);
  }

  private async start(): Promise<void> {
    const action = this.action;
    if (action?.kind === "status") {
      this.phase = "done";
      this.maybeAnswer();
      return;
    }
    if (action?.kind === "close-request" && action.bytes < 0) {
      this.finish("reset");
      return;
    }
    if (action?.kind === "delay") await Bun.sleep(action.ms);
    if (this.client.closed) return;
    try {
      this.serverSocket = await this.proxy.connectUpstream(this);
    } catch {
      this.finish("no server");
      return;
    }
    this.server.socket = this.serverSocket;
    this.server.write((this.head as Head).bytes);
    this.phase = "body";
    this.pump();
  }

  /** How many body bytes the rule lets through before it acts, if it cuts the request. */
  private limit(): number | "all" | undefined {
    const action = this.action;
    if (!action) return undefined;
    if (action.kind === "close-request") return action.bytes;
    if (action.kind === "kill-client" || action.kind === "kill-server") return action.bytes;
    return undefined;
  }

  /** Forward held body bytes to the server, up to the rule's limit. */
  private pump(): void {
    const limit = this.limit();
    let take = this.buffer.length;
    if (typeof limit === "number") take = Math.min(take, Math.max(0, limit - this.bodyForwarded));
    if (take > 0) {
      this.server.write(this.buffer.subarray(0, take));
      this.bodyForwarded += take;
      this.buffer = this.buffer.subarray(take);
    }
    const complete = this.bodyComplete();
    const reached = typeof limit === "number" ? this.bodyForwarded >= limit || complete : complete;
    if (limit !== undefined && reached && !this.cut) {
      this.cut = true;
      void this.act();
    }
  }

  /** The rule's cut, once its bytes have passed. */
  private async act(): Promise<void> {
    const action = this.action as ProxyAction;
    if (action.kind === "close-request") {
      this.finish(`closed after ${this.bodyForwarded} of ${this.bodyTotal} body bytes`);
      return;
    }
    // Let the bytes reach the server before the kill (a killed server is killed at once: its
    // answer may be on its way).
    await this.drained(action.kind === "kill-client");
    if (action.kind === "kill-client") {
      await this.proxy.hooks.killClient();
      if (action.bytes === "all") {
        // The whole request went: let the server answer (and commit), then drop the answer, as
        // the dead client would never have read it.
        this.client.abort();
        this.note(`client killed after the whole request (${this.bodyForwarded} body bytes)`);
        return;
      }
      this.finish(`client killed after ${this.bodyForwarded} of ${this.bodyTotal} body bytes`);
      return;
    }
    if (action.kind === "kill-server") {
      await this.proxy.hooks.killServer();
      this.finish(`server killed after ${this.bodyForwarded} of ${this.bodyTotal} body bytes`);
    }
  }

  private async drained(settle: boolean): Promise<void> {
    for (let i = 0; i < 100 && this.server.pending > 0 && !this.server.closed; i++) {
      await Bun.sleep(5);
    }
    // A moment for the server to read what the socket holds.
    if (settle) await Bun.sleep(30);
  }

  /** A `status` rule answers once the request has fully arrived. */
  private maybeAnswer(): void {
    if (!this.bodyComplete() || this.client.closed) return;
    const action = this.action as Extract<ProxyAction, { kind: "status" }>;
    const body = JSON.stringify({
      error: {
        code: action.code ?? "injected",
        message: `injected by the scenario proxy (${action.status})`,
        ...(action.expected !== undefined ? { expected: action.expected } : {}),
      },
    });
    const response =
      `HTTP/1.1 ${action.status} Injected\r\ncontent-type: application/json\r\n` +
      `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`;
    this.client.write(Buffer.from(response));
    this.client.end();
    if (this.request) {
      this.request.status = action.status;
      this.request.outcome = `answered ${action.status} by the proxy`;
    }
  }

  onServerData(data: Buffer): void {
    const out = this.response.feed(data);
    if (this.request && this.response.status !== undefined) {
      this.request.status = this.response.status;
    }
    const action = this.action;
    const done = this.response.done;
    // A killed client never reads the answer; a killed server's answer (one it managed to send
    // before the kill) is never delivered either.
    if (action?.kind === "drop-response" || this.cut) {
      if (done && action?.kind === "drop-response") {
        this.finish("answer dropped after the server committed");
      } else if (done) this.server.abort();
      return;
    }
    if (action?.kind === "close-response") {
      const left = action.bytes - this.responseBytes;
      if (left <= 0) return;
      const part = out.subarray(0, left);
      this.responseBytes += part.length;
      this.client.write(part);
      if (this.responseBytes >= action.bytes || done) {
        this.note(`closed after ${this.responseBytes} response bytes`);
        this.client.end();
        this.server.abort();
      }
      return;
    }
    this.responseBytes += out.length;
    this.client.write(out);
    if (done) this.answered();
  }

  /** The whole answer passed: close both sides, one request per connection. */
  private answered(): void {
    this.note("answered");
    this.client.end();
    this.server.abort();
  }

  onServerClose(): void {
    const action = this.action;
    if (action?.kind === "drop-response") {
      this.finish("answer dropped after the server committed");
      return;
    }
    if (this.cut) return;
    // An answer delimited by the close (no length) ends here.
    this.answered();
  }

  onClientClose(): void {
    this.client.closed = true;
    // A killed client's request stays with the server until it answers (`kill-client: all`).
    if (this.action?.kind === "kill-client" && this.cut) return;
    this.server.abort();
  }

  private note(outcome: string): void {
    if (this.request && !this.request.outcome) this.request.outcome = outcome;
  }

  private finish(outcome: string): void {
    this.note(outcome);
    this.client.abort();
    this.server.abort();
  }
}

export class FaultProxy {
  readonly rules: ProxyRule[] = [];
  /** Every request seen, in order. */
  readonly requests: ProxyRequest[] = [];
  /** One line per rule that fired. */
  readonly log: string[] = [];
  private listener: TCPSocketListener<Conn> | undefined;
  readonly conns = new Set<Conn>();

  constructor(
    public upstreamPort: number,
    readonly hooks: ProxyHooks,
  ) {}

  get port(): number {
    return this.listener?.port ?? 0;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  start(port = 0): void {
    this.listener = Bun.listen<Conn>({
      hostname: "127.0.0.1",
      port,
      socket: {
        open: (socket) => {
          const conn = new Conn(this);
          conn.client.socket = socket as unknown as Socket<unknown>;
          socket.data = conn;
          this.conns.add(conn);
        },
        data: (socket, data) => socket.data.onClientData(Buffer.from(data)),
        drain: (socket) => socket.data.client.flush(),
        close: (socket) => {
          socket.data.onClientClose();
          this.conns.delete(socket.data);
        },
        error: (socket) => socket.data?.onClientClose(),
      },
    });
  }

  async connectUpstream(conn: Conn): Promise<Socket<unknown>> {
    return (await Bun.connect<Conn>({
      hostname: "127.0.0.1",
      port: this.upstreamPort,
      data: conn,
      socket: {
        data: (socket, data) => socket.data.onServerData(Buffer.from(data)),
        drain: (socket) => socket.data.server.flush(),
        close: (socket) => socket.data.onServerClose(),
        error: (socket) => socket.data.onServerClose(),
        connectError: () => {},
      },
    })) as unknown as Socket<unknown>;
  }

  /** The first armed rule this request fires, counting it against every rule it matches. */
  match(method: string, path: string): ProxyRule | undefined {
    for (const rule of this.rules) {
      if (rule.method && rule.method !== method) continue;
      if (!rule.path.test(path)) continue;
      rule.seen++;
      if (rule.seen < rule.nth) continue;
      if (rule.times !== "always" && rule.fired >= rule.times) continue;
      rule.fired++;
      this.log.push(`${method} ${path}: ${rule.label}`);
      return rule;
    }
    return undefined;
  }

  record(method: string, path: string, rule: string | undefined): ProxyRequest {
    const request: ProxyRequest = {
      n: this.requests.length + 1,
      method,
      path,
      ...(rule ? { rule } : {}),
    };
    this.requests.push(request);
    return request;
  }

  /** Rules not yet fired as often as told (`always` ones until healed). */
  pending(): string[] {
    return this.rules.filter((r) => r.times === "always" || r.fired < r.times).map((r) => r.label);
  }

  heal(): void {
    this.rules.length = 0;
  }

  /** Requests whose method and path match `"<METHOD> <path glob>"`, from index `from`. */
  matching(spec: string, from = 0): ProxyRequest[] {
    const [method, glob] = spec.split(" ") as [string, string];
    const path = globRegex(glob);
    return this.requests
      .slice(from)
      .filter((r) => (method === "*" || r.method === method) && path.test(r.path));
  }

  stop(): void {
    for (const conn of this.conns) {
      conn.client.abort();
      conn.server.abort();
    }
    this.listener?.stop(true);
  }
}
