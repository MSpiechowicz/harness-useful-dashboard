// The app icons, embedded in the binary with `with { type: "file" }`: the import is the file's path.
declare module "*.svg" {
  const path: string;
  export default path;
}
declare module "*.ico" {
  const path: string;
  export default path;
}
declare module "*.icns" {
  const path: string;
  export default path;
}
