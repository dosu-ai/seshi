import { ServerError } from "@seshi/client";
import { ConfigError } from "@seshi/config";
import { Forbidden, SessionRejected, StoreError } from "@seshi/model";
import { describe, expect, it } from "vitest";
import { NotSignedIn } from "../account/credential";
import { BadServerUrl } from "../account/logins";
import { SignInError } from "../account/oidc";
import { BadUsername } from "../account/user";
import type { CommandContext } from "../commands/index";
import { EXIT } from "./exit";
import { classify, failWith, Refused } from "./failures";
import { Cancelled } from "./terminal";

describe("what each failure exits with (F8.1)", () => {
  it("maps the client commands' errors to the stable codes", () => {
    const exit = (err: unknown) => classify(err)?.exit;
    expect(exit(new NotSignedIn("https://a"))).toBe(EXIT.auth);
    expect(exit(new ServerError(401, "unauthorized", "no"))).toBe(EXIT.auth);
    expect(exit(new ServerError(403, "forbidden", "no"))).toBe(EXIT.auth);
    expect(exit(new Forbidden("no"))).toBe(EXIT.auth);
    expect(exit(new SignInError("declined", "denied"))).toBe(EXIT.auth);
    expect(exit(new SignInError("down", "idp_unreachable"))).toBe(EXIT.unavailable);
    expect(exit(new ServerError(404, "not_found", "no"))).toBe(EXIT.notFound);
    expect(exit(new ServerError(410, "redacted", "gone"))).toBe(EXIT.notFound);
    expect(exit(new ServerError(400, "bad_field", "x"))).toBe(EXIT.usage);
    expect(exit(new ServerError(503, "x", "x"))).toBe(EXIT.unavailable);
    expect(exit(new ServerError(418, "x", "x"))).toBe(EXIT.failure);
    expect(exit(new StoreError("cannot reach"))).toBe(EXIT.unavailable);
    expect(exit(new ConfigError(["bad"]))).toBe(EXIT.config);
    expect(exit(new BadServerUrl("x", "y"))).toBe(EXIT.usage);
    expect(exit(new BadUsername("Zoë", "git"))).toBe(EXIT.config);
    expect(exit(new Cancelled())).toBe(EXIT.failure);
    expect(exit(new SessionRejected("empty", "x"))).toBe(EXIT.failure);
    expect(exit(new Refused(EXIT.conflict, "c", "m"))).toBe(EXIT.conflict);
    const instanceError = Object.assign(new Error("bucket"), { name: "InstanceError" });
    expect(exit(instanceError)).toBe(EXIT.config);
    const io = Object.assign(new Error("ENOENT: no such file or directory, open 'x'"), {
      code: "ENOENT",
      syscall: "open",
    });
    expect(classify(io)).toMatchObject({ exit: EXIT.failure, code: "io" });
    expect(classify(new Error("a bug"))).toBeUndefined();
  });

  it("reports in words or JSON, and rethrows a bug", () => {
    const err: string[] = [];
    const ctx = { stderr: (l: string) => err.push(l) } as unknown as CommandContext;
    expect(failWith(ctx, false, new NotSignedIn(undefined))).toBe(EXIT.auth);
    expect(failWith(ctx, true, new ServerError(404, "not_found", "no such"))).toBe(EXIT.notFound);
    expect(err[0]).toBe("seshi: not signed in: run seshi login --server <url>");
    expect(JSON.parse(err[1] as string)).toEqual({
      error: { code: "not_found", message: "no such" },
    });
    expect(() => failWith(ctx, false, new TypeError("bug"))).toThrow(TypeError);
  });
});
