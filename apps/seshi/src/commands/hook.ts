/** `seshi hook <agent> <event>`: internal; agents call it on every turn (F9). It must start fast,
 * so it imports nothing beyond what capture needs (X3.3): `bun run check:hook` holds it to that.
 *
 * Not built yet: branch seshi-14-capture replaces this file. */

import { notImplemented } from "../cli/stub";

export const { run } = notImplemented("hook", "14");
