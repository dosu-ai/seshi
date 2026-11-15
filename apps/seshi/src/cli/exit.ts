/** Stable exit codes (F8.1). Every command ends with one of these, so scripts can branch on
 * what happened without parsing messages. They never change meaning; new ones are added at the
 * end. docs/cli.md lists them. Imported by `seshi hook`, so this file imports nothing. */
export const EXIT = {
  /** It did what was asked. */
  ok: 0,
  /** Something failed that no other code covers. */
  failure: 1,
  /** The command line is wrong: an unknown command, option or argument. */
  usage: 2,
  /** The config cannot be used, or the bucket or server it names cannot be (a setting to fix
   * before anything runs). */
  config: 3,
  /** What was asked for does not exist (a session, a source, a token). */
  notFound: 4,
  /** Not signed in, or the credential may not do this. */
  auth: 5,
  /** Refused because of the state it found (another worker moved a checkpoint, a session
   * conflicts). Running again later may succeed. */
  conflict: 6,
  /** A server, bucket or vendor API could not be reached or failed; try again. */
  unavailable: 7,
  /** Worked, with something to look at: a job or source has errors, a worker is stopped or
   * there are two (`workers status`, `sync status`). */
  attention: 8,
  /** The command is part of seshi but not built yet in this binary. */
  notImplemented: 9,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
