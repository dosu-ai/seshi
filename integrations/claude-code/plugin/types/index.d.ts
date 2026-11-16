export type Capture = {
  capturing: boolean;
  reason: string;
  problems: string[];
};

declare module "claude-code" {
  interface PluginState {
    seshi: {
      capture: Shaped<Capture | null>;
      banner: string | null;
    };
  }
}
