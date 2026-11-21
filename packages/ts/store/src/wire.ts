/** What the S3 and Azure Blob clients both read off the wire: XML element values and ETags. */

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    return XML_ENTITIES[entity] ?? whole;
  });
}

export function xmlValues(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(decodeXml(m[1] as string));
  return out;
}

export function unquote(value: string | null): string | undefined {
  if (!value) return undefined;
  return value.replace(/^W\//, "").replace(/^"|"$/g, "");
}

export function quote(etag: string): string {
  return etag.startsWith('"') ? etag : `"${etag}"`;
}
