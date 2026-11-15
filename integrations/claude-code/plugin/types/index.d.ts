/** The Session Capture chip's state contract (F9.4): what `seshi statusline --json` last said of
 * this session, and the banner a toggle shows for a few seconds. */

/** Whether seshi captures this session, as the CLI's own decision function says (F9.5). */
export type Capture = {
  /** True while the session is being captured: `Session Capture ◉`. */
  capturing: boolean;
  /** Why, in one short sentence (`off for this session`, `paused until 14:00`). */
  reason: string;
  /** Anything that needs action, shown after a separator (B1.6): `3 queued`, `sign in`. */
  problems: string[];
};

declare module "claude-code" {
  interface PluginState {
    seshi: {
      /** Tagged (`capture-1`): change the tag when `Capture`'s fields change. */
      capture: Shaped<Capture | null>;
      /** The banner's text while it shows after a toggle; null at rest. */
      banner: string | null;
    };
  }
}
