import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import {
  type CapturePaths,
  captureRules,
  decide,
  identifySafely,
  otherFolders,
  placeOf,
  readHead,
  readSpool,
  readState,
  stateFacts,
  uploaderRunning,
} from "@seshi/capture";
import { cliLabelProblems, loadCliConfig } from "@seshi/config";
import type { CaptureAgent, CaptureHost } from "@seshi/kit";
import type { NormalizedRecord } from "@seshi/model";
import { canonicalJson } from "@seshi/model";
import {
  type RuleSet,
  redactionRules,
  redactTranscript,
  ruleRedactor,
  ruleSetFromDocument,
} from "@seshi/redact";
import type { Account } from "../account/account";
import { type Backend, ServerlessBackend } from "../backend";
import { allCaptureAgents } from "../capture-agents";
import { hostOf } from "../commands/capture-host";
import type { CommandContext } from "../commands/index";
import { buildFormats } from "../integrations";
import type { AgentInfo, DoctorDeps, Normalizer, Redaction, Residue } from "./deps";
import { serverView } from "./server";
import type { Failure } from "./types";

export interface RealDepsOptions {
  host?: CaptureHost;
  paths: CapturePaths;
  backend?: Backend;
  backendError?: Failure & { exit?: number };
  account?: Account;
  cwd?: string;
}

function readFile(path: string, end: number): string {
  if (end <= 0) return "";
  const buffer = Buffer.alloc(end);
  const fd = openSync(path, "r");
  let read = 0;
  try {
    while (read < end) {
      const n = readSync(fd, buffer, read, end - read, read);
      if (n === 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }
  return buffer.subarray(0, read).toString("utf8");
}

function statFile(path: string): { size: number; mtimeMs: number } | null {
  try {
    const stat = statSync(path);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function agentInfo(agent: CaptureAgent, host: CaptureHost): AgentInfo {
  return {
    name: agent.name,
    format: agent.format,
    encoding: agent.encoding,
    chunkable: agent.chunkable,
    identify: (path) => identifySafely(agent, path, readHead(path))?.session_id,
    ...(agent.locate ? { locate: (id: string) => agent.locate?.(id, host) } : {}),
    ...(agent.compose ? { uploaded: (id: string) => agent.compose?.path(id, host) } : {}),
  };
}

export function residueOf(rules: RuleSet, records: readonly NormalizedRecord[]): Residue[] {
  const redactor = ruleRedactor(rules);
  const hits: Residue[] = [];
  let carried = {};
  records.forEach((record, index) => {
    const out = redactor.redact([record], carried);
    carried = out.withheld;
    if (canonicalJson(out.records[0]) !== canonicalJson(record)) {
      hits.push({
        index,
        rules: Object.entries(out.summary.counts ?? {})
          .filter(([, n]) => (n as number) > 0)
          .map(([rule]) => rule)
          .sort(),
      });
    }
  });
  return hits;
}

export type RedactionPoint = "pre-redact" | "redact-on-write";

export function ruleRedaction(rules: RuleSet, origin: string, point: RedactionPoint): Redaction {
  const redactor = ruleRedactor(rules);
  return {
    rule_set: rules.hash,
    origin,
    transcript: (text, encoding) =>
      point === "pre-redact" ? redactTranscript(rules, text, encoding).text : text,
    records: (records) => redactor.redact(records).records,
    residue: (records) => residueOf(rules, records),
  };
}

function uploaderRules(paths: CapturePaths, server: string | undefined): Redaction {
  try {
    const cached = JSON.parse(readFileSync(paths.redactionRules, "utf8")) as {
      server?: string;
      document?: unknown;
    };
    if (cached.document && (server === undefined || cached.server === server)) {
      const { rules } = ruleSetFromDocument(cached.document);
      return ruleRedaction(
        rules,
        `the rules fetched from ${cached.server ?? "the server"}`,
        "pre-redact",
      );
    }
  } catch {}
  return ruleRedaction(redactionRules(), "the built-in pack", "pre-redact");
}

export async function realDeps(ctx: CommandContext, options: RealDepsOptions): Promise<DoctorDeps> {
  const host = options.host ?? hostOf(ctx);
  const { paths } = options;
  const agents = new Map((await allCaptureAgents()).map((a) => [a.name, agentInfo(a, host)]));
  const snapshot = await captureRules(host, paths);
  const formats = buildFormats(await ctx.integrations());
  const cwd = options.cwd ?? process.cwd();
  const normalizer: Normalizer = {
    records: (format, text) => formats.normalize({ source: format, transcript: text }).records,
    version: (format) => formats.versionOf(format),
    stale: (format, builtWith) => formats.isStale(format, builtWith),
  };
  const backend = options.backend;
  const redaction =
    backend instanceof ServerlessBackend
      ? ruleRedaction(backend.instance.redaction, "the local bucket's rules", "redact-on-write")
      : uploaderRules(paths, backend?.where);
  return {
    now: () => new Date(),
    state: () => readState(paths),
    judge: (state, agent, entry) => {
      const folder = entry?.cwd ?? (entry ? undefined : cwd);
      return decide(
        {
          rules: snapshot.rules,
          ...(snapshot.error ? { rulesError: snapshot.error } : {}),
          place: placeOf(folder),
          ...stateFacts(state, agent, entry, new Date()),
          seen: otherFolders(state, agent, entry, folder).map(placeOf),
        },
        host.platform,
      );
    },
    labelProblems: (entry) => {
      const problems: string[] = [];
      try {
        const { config } = loadCliConfig({
          env: { ...host.env },
          home: host.home,
          platform: host.platform,
        });
        problems.push(...cliLabelProblems(config.labels));
      } catch {}
      const folder = entry?.cwd ?? (entry ? undefined : cwd);
      problems.push(
        ...(placeOf(folder).repo?.config.labelProblems ?? []).map(
          (p) => `.seshi/config.toml: ${p}`,
        ),
      );
      return problems;
    },
    agent: (name) => agents.get(name),
    files: { stat: statFile, read: readFile },
    spool: () => readSpool(paths).items,
    log: () => {
      const lines: string[] = [];
      for (const file of [`${paths.log}.1`, paths.log]) {
        try {
          lines.push(...readFileSync(file, "utf8").split("\n").filter(Boolean));
        } catch {}
      }
      return lines;
    },
    uploaderRunning: () => uploaderRunning(paths),
    ...(backend ? { server: serverView(backend) } : {}),
    ...(options.backendError ? { serverError: options.backendError } : {}),
    normalizer,
    redaction,
  };
}
