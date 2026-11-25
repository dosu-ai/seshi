#!/usr/bin/env bun

// The server build's entry point (`bun run build --server`, the image): the same seshi, with
// the LanceDB search backend (F10.6). Importing `@seshi/lance` here, and nowhere that
// main.ts reaches, keeps LanceDB's native library (about 200 MB) out of every other binary:
// `bun build --compile` bundles whatever an entry's imports name.
import { lanceIndex, provideLance } from "@seshi/lance";
import { start } from "./main";

provideLance(lanceIndex);
start();
