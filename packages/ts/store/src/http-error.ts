/** A bucket's HTTP answer that was not a success: S3's or Azure Blob's, with the service's own
 * error code when it gave one. Callers that only care that the bucket answered (a refusal, a
 * failed condition) check for this; `S3HttpError` and `AzureHttpError` say which service. */
export class BucketHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "BucketHttpError";
  }
}
