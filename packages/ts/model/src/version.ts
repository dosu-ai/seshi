/** The release, from this package's `package.json` (the one version of the repository): what
 * each trace's `normalizer` reports and `/healthz` and `seshi --version` print. */
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
