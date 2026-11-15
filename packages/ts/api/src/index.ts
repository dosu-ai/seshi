/** `@seshi/api`: the HTTP surface, one `fetch(Request) → Response` over a bucket and its tokens.
 * Layer 5 (X3.2). Branch 06 makes the routes take an Instance; today they take the store, the
 * format registry and the tokens directly, as the server always has. */

export { type App, type AppOptions, createApp, type StorageView, type TokenGrant } from "./app";
