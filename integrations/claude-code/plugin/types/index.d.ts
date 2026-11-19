export type Capture = {
  capturing: boolean;
  reason: string;
  problems: string[];
};

export type CaptureShape = "capture-1";

declare module "claude-code" {
  interface PluginState {
    seshi: {
      capture: Shaped<Capture | null>;
      banner: string | null;
    };
  }
}
