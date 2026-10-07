import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** A native "choose folder" dialog on the user's own desktop, and a plain listing of folders for when there is none. */

export interface PickCommand {
  cmd: string[];
  /** Extra environment for the process: Windows gets the title and start folder this way, never inside the script. */
  env?: Record<string, string>;
}

export interface PickOptions {
  /** An existing absolute folder the dialog opens in. */
  start: string;
  title: string;
}

const MAC_SCRIPT = ["on run argv", "return POSIX path of (choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv)))", "end run"];

const WINDOWS_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$d.Description = $env:HD_PICK_TITLE",
  "$d.SelectedPath = $env:HD_PICK_START",
  "$d.ShowNewFolderButton = $true",
  "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
].join("; ");

/**
 * The command that opens the dialog, or null when this machine has none. Title and folder only ever travel as
 * arguments or environment variables, never as part of a script, and nothing runs through a shell.
 */
export function pickCommand(
  platform: string,
  { start, title }: PickOptions,
  which: (name: string) => string | null = Bun.which,
  desktop = process.env.XDG_CURRENT_DESKTOP ?? "",
): PickCommand | null {
  if (platform === "darwin") return { cmd: ["osascript", ...MAC_SCRIPT.flatMap((l) => ["-e", l]), title, start] };
  if (platform === "win32") return { cmd: ["powershell", "-NoProfile", "-STA", "-Command", WINDOWS_SCRIPT], env: { HD_PICK_TITLE: title, HD_PICK_START: start } };
  const dir = start.endsWith("/") ? start : `${start}/`;
  const zenity: PickCommand = { cmd: ["zenity", "--file-selection", "--directory", `--title=${title}`, `--filename=${dir}`] };
  const kdialog: PickCommand = { cmd: ["kdialog", "--getexistingdirectory", start, "--title", title] };
  // The desktop's own dialog first: KDE's on KDE (and LXQt), GNOME's everywhere else.
  const order = /KDE|LXQt/i.test(desktop) ? [["kdialog", kdialog], ["zenity", zenity]] : [["zenity", zenity], ["kdialog", kdialog]];
  for (const [bin, c] of order as [string, PickCommand][]) if (which(bin)) return c;
  if (which("yad")) return { cmd: ["yad", "--file", "--directory", `--title=${title}`, `--filename=${dir}`] };
  return null;
}

/** Whether a native dialog can be shown here: Linux needs a display and one of the dialog programs. */
export function nativeAvailable(platform = process.platform, env: Record<string, string | undefined> = process.env, which: (name: string) => string | null = Bun.which): boolean {
  if (platform === "darwin" || platform === "win32") return true;
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return pickCommand(platform, { start: "/", title: "" }, which) !== null;
}

/** The folder a dialog printed, or null when it was cancelled or printed something that isn't an absolute path. */
export function parsePicked(code: number, stdout: string): string | null {
  if (code !== 0) return null;
  let path = stdout.replace(/[\r\n]+$/, "");
  if (!isAbsolute(path)) return null;
  // "/home/me/" is "/home/me", but a root ("/" or "C:\") stays one.
  while (/[\\/]$/.test(path) && dirname(path) !== path) path = path.slice(0, -1);
  return path;
}

/** The folder to open the dialog in: the given one, else its nearest existing parent, else home. */
export function startFolder(start: unknown): string {
  if (typeof start === "string" && isAbsolute(start)) {
    let dir = resolve(start);
    for (;;) {
      if (isDir(dir)) return dir;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return homedir();
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Runs a command to its end: its exit code and what it printed. */
export type Run = (command: PickCommand, timeoutMs: number) => Promise<{ code: number; stdout: string }>;

const run: Run = async ({ cmd, env }, timeoutMs) => {
  const proc = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, stdout };
  } catch {
    return { code: 1, stdout: "" };
  } finally {
    clearTimeout(timer);
  }
};

/** The user is choosing, so there is time: ten minutes. */
const PICK_TIMEOUT_MS = 10 * 60_000;

export class PickerBusy extends Error {}

/** One dialog at a time: a second request while one is open is refused, not queued behind it. */
export class FolderPicker {
  private open = false;
  constructor(
    private readonly runner: Run = run,
    private readonly platform: string = process.platform,
    private readonly which: (name: string) => string | null = Bun.which,
    private readonly timeoutMs = PICK_TIMEOUT_MS,
  ) {}

  /** The chosen folder, or null when the dialog was cancelled, failed or isn't available. Throws PickerBusy. */
  async pick(start: unknown, title: unknown): Promise<string | null> {
    if (this.open) throw new PickerBusy();
    const command = pickCommand(this.platform, { start: startFolder(start), title: typeof title === "string" && title ? title.slice(0, 200) : "Folder" }, this.which);
    if (!command) return null;
    this.open = true;
    try {
      const { code, stdout } = await this.runner(command, this.timeoutMs);
      return parsePicked(code, stdout);
    } finally {
      this.open = false;
    }
  }
}

export const folderPicker = new FolderPicker();

export type DirError = "not-absolute" | "not-found" | "not-a-directory" | "denied";

export interface DirListing {
  path: string;
  /** null at the root. */
  parent: string | null;
  home: string;
  dirs: { name: string; path: string }[];
  /** More folders than the cap: the rest are left out. */
  truncated: boolean;
}

const MAX_DIRS = 500;

/**
 * The sub-folders of a folder, for the in-app picker. This is the folder names of the user's own machine, shown to the
 * signed-in app only (every /api route is behind the sign-in). Files aren't listed, and a failure is one of a few fixed
 * codes that say nothing about why.
 */
export function listDirs(raw: string, showHidden = false): DirListing | { error: DirError } {
  const home = homedir();
  const input = raw.trim() || home;
  if (input.length > 4096 || !isAbsolute(input)) return { error: "not-absolute" };
  const path = resolve(input);
  try {
    if (!statSync(path).isDirectory()) return { error: "not-a-directory" };
    const dirs: DirListing["dirs"] = [];
    for (const e of readdirSync(path, { withFileTypes: true })) {
      if (!showHidden && e.name.startsWith(".")) continue;
      const full = join(path, e.name);
      // A link to a folder counts as one.
      if (e.isDirectory() || (e.isSymbolicLink() && isDir(full))) dirs.push({ name: e.name, path: full });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    const up = dirname(path);
    return { path, parent: up === path ? null : up, home, dirs: dirs.slice(0, MAX_DIRS), truncated: dirs.length > MAX_DIRS };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return { error: "denied" };
    if (code === "ENOTDIR") return { error: "not-a-directory" };
    return { error: existsSync(path) ? "denied" : "not-found" };
  }
}
