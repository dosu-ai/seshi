/** A `.wasm` file imported `with { type: "file" }`: its path, which a compiled binary serves from
 * the files it embeds. */
declare module "*.wasm" {
  const path: string;
  export default path;
}
