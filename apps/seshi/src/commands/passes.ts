import type { HeldUploaderLock, Uploader } from "@seshi/capture";

/** Run uploader passes over `only` while they get somewhere: until a pass sends and retracts
 * nothing, sign-in is needed, another uploader takes the lock over, or `maxPasses`. Returns why
 * uploads wait to sign in, if they do. For a command that uploads in the foreground
 * (`seshi upload`, a cloud hook). */
export async function passUntilSettled(
  uploader: Uploader,
  lock: HeldUploaderLock,
  only: ReadonlySet<string>,
  maxPasses = 50,
): Promise<string | undefined> {
  for (let i = 0; i < maxPasses; i++) {
    if (!lock.beat()) return undefined;
    const summary = await uploader.pass({ only });
    if (summary.signIn) return summary.signIn;
    if (summary.uploaded === 0 && summary.retracted === 0) return undefined;
  }
  return undefined;
}
