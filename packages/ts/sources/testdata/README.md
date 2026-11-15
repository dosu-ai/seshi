# Test data for `@seshi/sources`

Tests never call a real bucket, STS or any network service.

- `s3/list-objects-v2.xml` is a ListObjectsV2 answer and `s3/assume-role.xml` an STS
  AssumeRole answer. Both are **hand-written** from the shapes AWS documents for those calls
  (the S3 API reference's ListObjectsV2 response syntax, including the `&quot;`-encoded ETag,
  a multipart ETag with a `-N` suffix, checksum elements and a continuation token; the STS API
  reference's AssumeRole example). They are not recordings of a live account, and the keys in
  them are AWS's documented example values.
- `FakeS3` and `FakeSts` in `src/testing.ts` (`@seshi/sources/testing`) answer from memory in
  those same documented shapes: ListObjectsV2 with `prefix`, `start-after`, `max-keys` and
  continuation tokens; GetObject with `Range: bytes=N-` (206 and `Content-Range`), `If-Match`
  (412 `PreconditionFailed`), 416 `InvalidRange`, 404 `NoSuchKey` and `x-amz-meta-*` user
  metadata; and AssumeRole with its external id check. `FakeS3.listen()` serves the bucket on
  a local port for tests that go over real HTTP.
