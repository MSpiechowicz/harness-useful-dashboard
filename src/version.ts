import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
export const REPO = "MSpiechowicz/harness-useful-dashboard";
export const BIN_NAME = "harness-dashboard";
