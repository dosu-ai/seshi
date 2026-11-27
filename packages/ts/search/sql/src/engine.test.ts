import { DuckDBInstance, type DuckDBType } from "@duckdb/node-api";
import { describe, expect, it } from "vitest";
import { jsonValue, storageSecret } from "./engine";

describe("jsonValue", () => {
  it("gives integers as numbers at any depth: lists, arrays, structs, maps, unions", async () => {
    const connection = await (await DuckDBInstance.create(":memory:")).connect();
    const reader = await connection.runAndReadAll(
      "SELECT 1::BIGINT AS n, [1::BIGINT, NULL] AS l, {'a': 3::BIGINT, 'b': [4::HUGEINT]} AS s, map([5::BIGINT], [6::BIGINT]) AS m, [7::BIGINT, 8]::BIGINT[2] AS arr, union_value(n := 9::BIGINT) AS u, 1.5::DECIMAL(4,1) AS d, ['x'] AS t, 18446744073709551615::UBIGINT AS big",
    );
    const types = reader.columnTypes();
    const row = (reader.getRowsJson()[0] ?? []).map((v, i) => jsonValue(v, types[i] as DuckDBType));
    expect(row).toEqual([
      1,
      [1, null],
      { a: 3, b: [4] },
      [{ key: 5, value: 6 }],
      [7, 8],
      { tag: "n", value: 9 },
      1.5,
      ["x"],
      "18446744073709551615",
    ]);
    connection.closeSync();
  });
});

describe("storageSecret", () => {
  it("makes no secret for a folder index", () => {
    expect(storageSecret(undefined)).toBeUndefined();
  });

  it("gives a credential as PROVIDER config, and leaves none to the machine's credential chain", () => {
    expect(
      storageSecret(JSON.stringify({ google_service_account_key: "{}", aws_region: "x" })),
    ).toContain("PROVIDER config");
    expect(storageSecret("{}")).toContain("PROVIDER credential_chain");
    expect(storageSecret(JSON.stringify({ aws_region: "us-east-1" }))).toContain(
      "PROVIDER credential_chain, STORAGE_OPTIONS map(['aws_region']::VARCHAR[], ['us-east-1']::VARCHAR[])",
    );
  });
});
