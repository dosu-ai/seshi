export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  config: 3,
  notFound: 4,
  auth: 5,
  conflict: 6,
  unavailable: 7,
  attention: 8,
  notImplemented: 9,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
