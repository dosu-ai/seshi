import { type FSWatcher, watch } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DROP_IN_DIR_NAME } from "@seshi/config";

export const WATCH_DEBOUNCE_MS = 1000;

export interface ConfigWatchOptions {
  /** The files whose changes mean a reload: the config file and the rule packs. */
  files: () => readonly string[];
  /** Folders whose `*.toml` changes mean a reload: the drop-in folder. */
  dirs: () => readonly string[];
  onChange: () => void;
  debounceMs?: number;
  onError?: (err: unknown) => void;
}

/** Watch the config's files for `watch_config`. Folders are watched, not files, so a file
 * replaced by a rename (editors, Kubernetes ConfigMaps) is still seen. Changes are debounced:
 * `onChange` runs once, `debounceMs` after the last. `rearm()` watches the files again after a
 * reload changed which they are. */
export function watchConfig(options: ConfigWatchOptions): { rearm(): void; close(): void } {
  const debounce = options.debounceMs ?? WATCH_DEBOUNCE_MS;
  interface Watched {
    watcher: FSWatcher;
    names: Set<string>;
    anyToml: boolean;
  }
  const watched = new Map<string, Watched>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(options.onChange, debounce);
    (timer as { unref?: () => void }).unref?.();
  };

  // Folders already watched keep their watcher, so a change that lands while a reload re-arms
  // is not lost; only folders no longer wanted are closed, and new ones opened.
  const arm = () => {
    const wanted = new Map<string, { names: Set<string>; anyToml: boolean }>();
    for (const file of options.files()) {
      const path = resolve(file);
      const entry = wanted.get(dirname(path)) ?? { names: new Set(), anyToml: false };
      entry.names.add(basename(path));
      // The drop-in folder appearing beside the config file is a change too.
      entry.names.add(DROP_IN_DIR_NAME);
      wanted.set(dirname(path), entry);
    }
    for (const dir of options.dirs()) {
      const path = resolve(dir);
      const entry = wanted.get(path) ?? { names: new Set(), anyToml: false };
      entry.anyToml = true;
      wanted.set(path, entry);
    }
    for (const [dir, { watcher }] of watched) {
      if (!wanted.has(dir)) {
        watcher.close();
        watched.delete(dir);
      }
    }
    for (const [dir, want] of wanted) {
      const known = watched.get(dir);
      if (known) {
        known.names = want.names;
        known.anyToml = want.anyToml;
        continue;
      }
      try {
        const watcher = watch(dir, { persistent: false }, (_event, name) => {
          const entry = watched.get(dir);
          const file = name === null ? undefined : String(name);
          if (
            entry &&
            (file === undefined ||
              entry.names.has(file) ||
              (entry.anyToml && file.endsWith(".toml")))
          ) {
            fire();
          }
        });
        watcher.on("error", (err) => options.onError?.(err));
        watched.set(dir, { watcher, ...want });
      } catch (err) {
        // A folder that does not exist yet (no seshi.d/): watched once it does, on the next arm.
        if ((err as { code?: unknown }).code !== "ENOENT") options.onError?.(err);
      }
    }
  };
  arm();
  return {
    rearm: arm,
    close() {
      clearTimeout(timer);
      for (const { watcher } of watched.values()) watcher.close();
      watched.clear();
    },
  };
}
