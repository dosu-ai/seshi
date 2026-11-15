/** `@seshi/api`: the HTTP surface, one `fetch(Request) → Response` over a bucket, with identity
 * and access from `@seshi/auth` (X5). Layer 5 (X3.2). Branch 06 makes the routes take an
 * Instance; today they take the store, the format registry and an `Auth` directly. */

export {
  type App,
  type AppOptions,
  createApp,
  maxBodyBytes,
  type StorageView,
  type TokenGrant,
} from "./app";
