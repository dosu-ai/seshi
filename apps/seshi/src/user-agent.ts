/** What every `seshi` command and the capture uploader send as `User-Agent` to a seshi server,
 * so its logs tell seshi's own traffic from other @seshi/client programs. */

import { VERSION } from "@seshi/model";

export const USER_AGENT = `seshi/${VERSION}`;
