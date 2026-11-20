import type { AuthModes, ExchangeResult } from "@seshi/auth";
import type { Identity } from "@seshi/model";
import { h, replace } from "../../web/dom";
import {
  ApiError,
  type Credential,
  call,
  clearCredential,
  loadCredential,
  PENDING_KEY,
  SIGNED_OUT,
  saveCredential,
} from "./api";
import { renderList } from "./list";
import { finishSignIn, type PendingSignIn } from "./oidc";
import { forgetSessions, renderSession } from "./session";
import { renderSignIn } from "./signin";

const root = document.getElementById("app") as HTMLElement;
const who = document.getElementById("who") as HTMLElement;

let generation = 0;
let identity: Identity | undefined;

function route(): void {
  if (!identity) return;
  const mine = ++generation;
  const isCurrent = () => mine === generation;
  const [path = "", search = ""] = location.hash.replace(/^#\/?/, "").split("?", 2);
  const query = new URLSearchParams(search);
  let parts: string[];
  try {
    parts = path.split("/").map((p) => decodeURIComponent(p));
  } catch {
    parts = [];
  }
  if (parts[0] === "s" && parts[1] && parts[2]) {
    renderSession(root, { owner: parts[1], archive: parts[2], query, me: identity, isCurrent });
  } else {
    renderList(root, { query, me: identity, isCurrent });
  }
}

function showWho(me: Identity, credential: Credential): void {
  replace(
    who,
    h(
      "span",
      { class: "me", title: `signed in with ${credential.via}` },
      h("span", { class: "owner" }, me.owner),
      me.role && me.role !== "member" ? h("span", { class: "role" }, me.role) : null,
    ),
    h(
      "button",
      {
        type: "button",
        class: "quiet",
        onclick: () => {
          clearCredential();
          location.hash = "#/";
          location.reload();
        },
      },
      "Sign out",
    ),
  );
}

function signedIn(credential: Credential, me: Identity): void {
  forgetSessions();
  saveCredential(credential);
  identity = me;
  showWho(me, credential);
  route();
}

function signIn(modes: AuthModes, notice?: string): void {
  // Whatever was loading for the last credential no longer draws, and nothing it read stays.
  generation++;
  forgetSessions();
  identity = undefined;
  document.title = "seshi";
  replace(who);
  renderSignIn(root, modes, signedIn, notice);
}

function readPending(): PendingSignIn | undefined {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingSignIn) : undefined;
  } catch {
    return undefined;
  }
}

/** Back from the IdP (`?code=&state=`): redeem the code, trade the ID token for a session
 * token, and take the code out of the address. */
async function returnFromIdp(
  modes: AuthModes,
  query: URLSearchParams,
): Promise<string | undefined> {
  const pending = readPending();
  history.replaceState(null, "", `${location.pathname}${pending?.back ?? ""}`);
  if (!modes.oidc) return "This server has no sign-in through an IdP.";
  try {
    const { id_token, nonce } = await finishSignIn(query, pending, modes.oidc.client_id, (u, i) =>
      fetch(u, i),
    );
    const result = await call<ExchangeResult>("exchange", {
      credential: null,
      body: { id_token, nonce },
    });
    const credential: Credential = {
      token: result.session_token,
      via: "sign-in",
      expires_at: result.expires_at,
    };
    signedIn(credential, await call<Identity>("me", { credential }));
    return undefined;
  } catch (err) {
    return `Sign-in did not finish: ${err instanceof Error ? err.message : String(err)}.`;
  }
}

async function boot(): Promise<void> {
  let modes: AuthModes;
  try {
    modes = await call<AuthModes>("authConfig", { credential: null });
  } catch (err) {
    replace(
      root,
      h(
        "p",
        { class: "problem", role: "alert" },
        `The server did not answer: ${err instanceof Error ? err.message : String(err)}. Reload to try again.`,
      ),
    );
    return;
  }
  window.addEventListener(SIGNED_OUT, () => {
    clearCredential();
    signIn(modes, "Your sign-in has ended. Sign in again to keep reading.");
  });
  window.addEventListener("hashchange", route);

  const query = new URLSearchParams(location.search);
  if (query.has("state")) {
    const problem = await returnFromIdp(modes, query);
    if (problem === undefined) return;
    signIn(modes, problem);
    return;
  }
  const credential = loadCredential();
  if (!credential) {
    signIn(modes);
    return;
  }
  try {
    signedIn(credential, await call<Identity>("me", { credential }));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      clearCredential();
      signIn(modes, "Your sign-in has ended. Sign in again to keep reading.");
      return;
    }
    replace(
      root,
      h(
        "p",
        { class: "problem", role: "alert" },
        `The server did not answer: ${err instanceof Error ? err.message : String(err)}. Reload to try again.`,
      ),
    );
  }
}

void boot();
