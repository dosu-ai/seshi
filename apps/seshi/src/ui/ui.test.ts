/** The team UI: the handler `seshi serve` puts in front of the API (paths, methods, headers),
 * the page's bundle (no inline script or style, nothing remote, no HTML sinks), the API routes
 * it calls against `spec/openapi.yaml`, and the page's helpers that need no DOM: filters,
 * text, and the PKCE sign-in. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type Assets, buildAssets } from "../web/assets";
import { EMPTY, parseState, searchQuery, stateQuery, withFilter, withLabel } from "./page/filters";
import { challengeOf, discover, finishSignIn, type PendingSignIn, startSignIn } from "./page/oidc";
import { ROUTES, resolve } from "./page/routes";
import { fold, highlightParts, shortRepo, splitMarkers } from "./page/text";
import { UI_PATH, uiCsp, uiHandler, underPrefix, withUi } from "./server";

const ASSETS: Assets = {
  index:
    '<script type="module" crossorigin src="/chunk-abc.js"></script><link rel="icon" href="/glyph-1.svg">',
  files: new Map([
    ["/chunk-abc.js", { body: new TextEncoder().encode("1"), type: "text/javascript" }],
  ]),
};

const get = (path: string, method = "GET") => new Request(`http://seshi.test${path}`, { method });

describe("the UI handler", () => {
  const handler = uiHandler({
    assets: ASSETS,
    issuer: () => "https://idp.example.com/oauth2/default",
  });

  it("serves the page under /ui/ with its links moved there", async () => {
    const page = handler(get("/ui/")) as Response;
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await page.text();
    expect(html).toContain('src="/ui/chunk-abc.js"');
    expect(html).toContain('href="/ui/glyph-1.svg"');
    const file = handler(get("/ui/chunk-abc.js")) as Response;
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("text/javascript");
    const index = handler(get("/ui/index.html?state=s")) as Response;
    expect(index.status).toBe(302);
    expect(index.headers.get("location")).toBe("/ui/?state=s");
    expect((handler(get("/ui/nope.js")) as Response).status).toBe(404);
  });

  it("sends / and /ui to the page, keeping the query (an IdP's answer)", () => {
    expect((handler(get("/")) as Response).headers.get("location")).toBe(UI_PATH);
    const back = handler(get("/ui?code=c&state=s")) as Response;
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/ui/?code=c&state=s");
  });

  it("answers only GET and HEAD", () => {
    const post = handler(get("/ui/", "POST")) as Response;
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect((handler(get("/ui/", "HEAD")) as Response).status).toBe(200);
  });

  it("leaves every other path to the API", async () => {
    expect(handler(get("/v1/me"))).toBeUndefined();
    expect(handler(get("/healthz"))).toBeUndefined();
    expect(handler(get("/uix"))).toBeUndefined();
    const app = withUi(() => new Response("api"), handler);
    expect(await (await app(get("/v1/sessions"))).text()).toBe("api");
    expect((await app(get("/ui/"))).status).toBe(200);
  });

  it("sends a policy that allows only the page's own files and the IdP's origin", () => {
    const response = handler(get("/ui/")) as Response;
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self' https://idp.example.com;");
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(uiCsp(undefined)).toContain("connect-src 'self';");
    expect(uiCsp("javascript:alert(1)")).toContain("connect-src 'self';");
  });

  it("moves only root-relative links", () => {
    expect(underPrefix('<a href="//cdn.example/x"><img src="/a.svg">')).toBe(
      '<a href="//cdn.example/x"><img src="/ui/a.svg">',
    );
  });
});

describe("the page's files", () => {
  let assets: Assets;
  beforeAll(async () => {
    assets = await buildAssets(fileURLToPath(new URL("./page/index.html", import.meta.url)));
  });

  it("bundle to a page with no inline script or style, nothing remote and no HTML sinks", () => {
    expect(assets.index).toMatch(/<script type="module" crossorigin src="\/chunk-[a-z0-9]+\.js">/);
    expect(assets.index).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(assets.index).not.toMatch(/<style|\sstyle="/);
    expect(assets.index).not.toMatch(/https?:\/\//);
    const types = [...assets.files.values()].map((f) => f.type.split(";")[0]);
    expect(types).toEqual(expect.arrayContaining(["text/javascript", "text/css", "image/svg+xml"]));
    for (const [path, file] of assets.files) {
      const text = new TextDecoder().decode(file.body);
      expect(text, path).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
      for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
        expect(text, `${path}: ${sink}`).not.toContain(sink);
      }
    }
  });
});

describe("the API routes the page calls", () => {
  // biome-ignore lint/suspicious/noExplicitAny: the spec is checked by its own suite
  const spec: any = Bun.YAML.parse(
    readFileSync(join(import.meta.dirname, "../../../../spec/openapi.yaml"), "utf8"),
  );

  it("are all in spec/openapi.yaml, with their methods", () => {
    for (const [name, route] of Object.entries(ROUTES)) {
      const [method, path] = route.split(" ") as [string, string];
      expect(spec.paths[path], `${name}: ${path}`).toBeDefined();
      expect(spec.paths[path][method.toLowerCase()], `${name}: ${route}`).toBeDefined();
    }
  });

  it("fill their parameters in, encoded", () => {
    expect(resolve("trace", { owner: "a@b.co", archive_id: "f".repeat(64) }).path).toBe(
      `/v1/owners/a%40b.co/sessions/${"f".repeat(64)}/trace`,
    );
    expect(resolve("session", { owner: "../x", archive_id: "1" }).path).toBe(
      "/v1/owners/..%2Fx/sessions/1",
    );
    expect(() => resolve("session", { owner: "a" })).toThrow(/archive_id/);
  });
});

describe("the list's state", () => {
  it("round-trips through the page's address", () => {
    const state = withLabel(
      withFilter({ ...EMPTY, q: "deploy", since: "7d" }, "repo", "acme/app"),
      "team=web",
    );
    const query = stateQuery(state);
    expect(query.toString()).toBe("q=deploy&repo=acme%2Fapp&label=team%3Dweb&since=7d");
    expect(parseState(query)).toEqual(state);
    expect(parseState(new URLSearchParams("since=forever&label=nokey&owner=%20"))).toEqual(EMPTY);
  });

  it("asks search for a browse without words, and for matches with them", () => {
    const now = new Date("2026-11-20T12:00:00Z");
    const browse = searchQuery({ ...EMPTY, since: "1d" }, { now, limit: 50 });
    expect(browse.get("q")).toBeNull();
    expect(browse.get("matches")).toBeNull();
    expect(browse.get("since")).toBe("2026-11-19T12:00:00.000Z");
    const found = searchQuery(withLabel({ ...EMPTY, q: "auth" }, "a=b"), {
      now,
      limit: 5,
      cursor: "5",
    });
    expect(found.toString()).toBe("q=auth&matches=3&label=a%3Db&limit=5&cursor=5");
  });
});

describe("text helpers", () => {
  it("cut snippets at their highlights, dropping ones out of range or order", () => {
    expect(highlightParts("find the token here", [[9, 14]])).toEqual([
      { text: "find the ", hit: false },
      { text: "token", hit: true },
      { text: " here", hit: false },
    ]);
    expect(
      highlightParts("abc", [
        [2, 9],
        [1, 0],
      ]),
    ).toEqual([{ text: "abc", hit: false }]);
  });

  it("keep markup as text and set redaction markers apart", () => {
    expect(splitMarkers('<img src=x onerror="alert(1)"> [redacted:aws-secret]')).toEqual([
      { text: '<img src=x onerror="alert(1)"> ' },
      { text: "[redacted:aws-secret]", rule: "aws-secret" },
    ]);
  });

  it("fold by lines and by length", () => {
    expect(fold("1\n2\n3", 2)).toEqual({ head: "1\n2", lines: 3, folded: true });
    expect(fold("short", 2)).toEqual({ head: "short", lines: 1, folded: false });
    const long = fold("word ".repeat(400), 10, 100);
    expect(long.folded).toBe(true);
    expect(long.head.length).toBeLessThanOrEqual(101);
    expect(shortRepo("github.com/acme/app")).toBe("acme/app");
  });
});

describe("sign-in through the IdP", () => {
  const issuer = "https://idp.example.com";
  const oidc = { issuer, client_id: "seshi-cli", scopes: ["openid", "email", "profile"] };
  const discovery = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
  };

  it("checks the discovery document: the issuer, web URLs, the token endpoint's origin", async () => {
    const serve = (doc: unknown) => async () => Response.json(doc);
    expect(await discover(issuer, serve(discovery))).toEqual(discovery);
    await expect(
      discover(issuer, serve({ ...discovery, issuer: "https://evil.example" })),
    ).rejects.toThrow(/another issuer/);
    await expect(
      discover(issuer, serve({ ...discovery, authorization_endpoint: "javascript:alert(1)" })),
    ).rejects.toThrow(/https/);
    await expect(
      discover(
        issuer,
        serve({ ...discovery, token_endpoint: "https://oauth2.other.example/token" }),
      ),
    ).rejects.toThrow(/not on the issuer's origin/);
    await expect(
      discover(issuer, async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).rejects.toThrow(/allow this page's origin/);
  });

  it("sends the browser to the IdP with PKCE (S256), state and nonce", async () => {
    const { url, pending } = await startSignIn(
      oidc,
      discovery,
      "https://seshi.example/ui/",
      "#/s/a/b",
    );
    const sent = new URL(url);
    expect(sent.origin + sent.pathname).toBe(`${issuer}/authorize`);
    expect(Object.fromEntries(sent.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "seshi-cli",
      redirect_uri: "https://seshi.example/ui/",
      scope: "openid email profile",
      state: pending.state,
      nonce: pending.nonce,
      code_challenge_method: "S256",
      code_challenge: await challengeOf(pending.verifier),
    });
    expect(pending.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pending.back).toBe("#/s/a/b");
    // RFC 7636's example: the challenge of a known verifier.
    expect(await challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("redeems the code with the verifier, and refuses an answer from another sign-in", async () => {
    const { pending } = await startSignIn(oidc, discovery, "https://seshi.example/ui/", "");
    let sent: URLSearchParams | undefined;
    const token = async (_url: string, init?: RequestInit) => {
      sent = new URLSearchParams(String(init?.body));
      return Response.json({ id_token: "header.payload.sig" });
    };
    const answer = new URLSearchParams({ code: "c1", state: pending.state });
    expect(await finishSignIn(answer, pending, "seshi-cli", token)).toEqual({
      id_token: "header.payload.sig",
      nonce: pending.nonce,
    });
    expect(Object.fromEntries(sent ?? [])).toEqual({
      grant_type: "authorization_code",
      code: "c1",
      redirect_uri: "https://seshi.example/ui/",
      client_id: "seshi-cli",
      code_verifier: pending.verifier,
    });
    const other: PendingSignIn = { ...pending, state: "someone-else" };
    await expect(finishSignIn(answer, other, "seshi-cli", token)).rejects.toThrow(
      /another sign-in/,
    );
    await expect(finishSignIn(answer, undefined, "seshi-cli", token)).rejects.toThrow(
      /another sign-in/,
    );
    const denied = new URLSearchParams({ state: pending.state, error: "access_denied" });
    await expect(finishSignIn(denied, pending, "seshi-cli", token)).rejects.toThrow(
      /access_denied/,
    );
    const refused = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
    await expect(finishSignIn(answer, pending, "seshi-cli", refused)).rejects.toThrow(
      /invalid_grant/,
    );
  });
});
