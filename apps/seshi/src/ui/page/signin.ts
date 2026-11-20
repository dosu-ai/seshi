import type { AuthModes } from "@seshi/auth";
import type { Identity } from "@seshi/model";
import { h, replace } from "../../web/dom";
import { ApiError, type Credential, call, PENDING_KEY } from "./api";
import { discover, SignInError, startSignIn } from "./oidc";

/** The page's address, which the IdP sends the browser back to: always `/ui/`, however the
 * page was opened, since that is the redirect URI registered with the IdP (docs/ui.md). */
export function redirectUri(): string {
  return `${location.origin}/ui/`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The sign-in screen. `done` gets a credential the API has accepted. */
export function renderSignIn(
  root: HTMLElement,
  modes: AuthModes,
  done: (credential: Credential, identity: Identity) => void,
  notice?: string,
): void {
  const problem = h("p", { class: "problem", role: "alert", hidden: true });
  const fail = (message: string) => {
    problem.textContent = message;
    problem.hidden = false;
  };

  const oidc = modes.oidc;
  const idpButton = oidc
    ? h(
        "button",
        {
          type: "button",
          class: "primary",
          onclick: async () => {
            problem.hidden = true;
            idpButton?.setAttribute("disabled", "");
            try {
              const discovery = await discover(oidc.issuer, (u, i) => fetch(u, i));
              const { url, pending } = await startSignIn(
                oidc,
                discovery,
                redirectUri(),
                location.hash,
              );
              sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
              location.assign(url);
            } catch (err) {
              idpButton?.removeAttribute("disabled");
              fail(
                err instanceof SignInError
                  ? `Sign-in through ${hostOf(oidc.issuer)} cannot start: ${err.message}.`
                  : `Sign-in cannot start: ${err instanceof Error ? err.message : String(err)}.`,
              );
            }
          },
        },
        `Sign in with ${hostOf(oidc.issuer)}`,
      )
    : undefined;

  const token = h("input", {
    id: "token",
    type: "password",
    autocomplete: "off",
    spellcheck: "false",
    required: true,
  });
  const user = modes.org_key
    ? h("input", {
        id: "user",
        type: "text",
        autocomplete: "username",
        spellcheck: "false",
      })
    : undefined;
  const submit = h("button", { type: "submit", class: oidc ? "" : "primary" }, "Sign in");

  const form = h(
    "form",
    {
      class: "token-form",
      onsubmit: async (event: Event) => {
        event.preventDefault();
        problem.hidden = true;
        const credential: Credential = {
          token: token.value.trim(),
          via: user?.value.trim() ? "org key" : "token",
          ...(user?.value.trim() ? { user: user.value.trim() } : {}),
        };
        if (!credential.token) return;
        submit.setAttribute("disabled", "");
        try {
          const identity = await call<Identity>("me", { credential });
          if (!identity.scopes?.includes("sessions:read")) {
            fail("That credential cannot read sessions. Use one that can.");
            return;
          }
          done(credential, identity);
        } catch (err) {
          fail(
            err instanceof ApiError && err.status === 401
              ? `The server does not accept that ${user?.value.trim() ? "key and username" : "token"}.`
              : `The server did not answer: ${err instanceof Error ? err.message : String(err)}.`,
          );
        } finally {
          submit.removeAttribute("disabled");
        }
      },
    },
    h("label", { for: "token" }, modes.org_key ? "Token or org key" : "Token"),
    token,
    user
      ? [
          h("label", { for: "user" }, "Username"),
          user,
          h("p", { class: "hint" }, "Only with the org key: the username you sign in as."),
        ]
      : null,
    submit,
  );

  replace(
    root,
    h(
      "section",
      { class: "signin" },
      h("h1", null, "Read your team's sessions"),
      h(
        "p",
        { class: "lede" },
        "Sign in to browse and search the coding-agent sessions this server keeps. You see what your credential may read: your own sessions and those shared with the team.",
      ),
      notice ? h("p", { class: "notice", role: "status" }, notice) : null,
      idpButton,
      idpButton ? h("p", { class: "or" }, "or use a seshi token") : null,
      form,
      problem,
      h(
        "p",
        { class: "hint" },
        "The credential stays in this tab only and is gone when you close it.",
      ),
    ),
  );
  (idpButton ?? token).focus();
}
