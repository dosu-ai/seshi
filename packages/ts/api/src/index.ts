/** `@seshi/api`: the HTTP surface, one `fetch(Request) → Response` over an Instance
 * (`@seshi/instance`), with identity and access from the instance's `Auth` (X5). Layer 5
 * (X3.2). */

export { type App, createApp, maxBodyBytes, type StorageView } from "./app";
