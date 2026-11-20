/** The team UI as other code (the cross-package tests) reaches it: the handler `seshi serve`
 * puts in front of the API, and the page's sign-in steps, which need no DOM. */

export { finishSignIn, type PendingSignIn, startSignIn } from "./page/oidc";
export { UI_PATH, uiHandler, withUi } from "./server";
