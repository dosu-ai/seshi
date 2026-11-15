/** The CLI's own config (`~/.config/seshi/config.toml`, `%APPDATA%\seshi\config.toml` on
 * Windows; F1.4): which server it talks to, who the user says they are, personal capture
 * rules (F9.5) and the colour theme (B1.4). Same loader as the server's, its own schema. */

import * as z from "zod";
import { httpUrl } from "./server/common";

export const THEMES = ["auto", "dark", "light"] as const;

export const capturePath = z
  .strictObject({
    path: z.string().min(1).describe("A folder; ~ is the home folder. Matched by path prefix."),
    capture: z.boolean().describe("Capture sessions under it, or not."),
  })
  .describe("A personal capture rule for a folder (F9.5).");

export const cliConfigSchema = z
  .strictObject({
    server: httpUrl
      .optional()
      .describe("The seshi server this CLI talks to (seshi login --server)."),
    local: z
      .strictObject({
        config: z
          .string()
          .min(1)
          .describe(
            "A server config (seshi.toml) naming the bucket; ~ is the home folder. Its keys must be able to write the bucket.",
          ),
        owner: z
          .string()
          .min(1)
          .optional()
          .describe("The owner id sessions are stored under; user, else the OS user, when unset."),
      })
      .optional()
      .describe(
        "Local mode (X3.5): run the pipeline in-process against a bucket you own, instead of talking to a server. Set server or local, not both.",
      ),
    user: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The username stated with the org key (X5.7); else git user.email, then the OS user.",
      ),
    theme: z
      .enum(THEMES)
      .default("auto")
      .describe("Terminal colours (B1.4): auto detects the background."),
    capture: z
      .strictObject({
        enabled: z.boolean().default(true).describe("Capture for this user (F9.5, global level)."),
        paths: z
          .array(capturePath)
          .default([])
          .describe("Rules by folder; the longest match decides."),
      })
      .prefault({})
      .describe("Personal capture rules (F9.5)."),
  })
  .superRefine((config, ctx) => {
    if (config.server !== undefined && config.local !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["local"],
        message: "set server (a seshi server) or local (a bucket you own), not both",
      });
    }
  })
  .describe("seshi CLI configuration (~/.config/seshi/config.toml).");

export type CliConfig = z.output<typeof cliConfigSchema>;
export type CapturePath = z.output<typeof capturePath>;
