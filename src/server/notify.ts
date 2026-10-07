/**
 * A desktop notification through the OS's own tool, so alerts arrive with no dashboard window open. The text goes in
 * as arguments or environment variables, never into a script, so a project name can't run anything.
 */
export function notifyCommand(title: string, body: string, platform = process.platform): { cmd: string[]; env?: Record<string, string> } | null {
  if (platform === "darwin") {
    return { cmd: ["osascript", "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body] };
  }
  if (platform === "win32") {
    // A toast from PowerShell's own app id: every Windows 10 and 11 has it, nothing to install.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
      "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
      "$t = $xml.GetElementsByTagName('text')",
      "$t.Item(0).AppendChild($xml.CreateTextNode($env:HD_TITLE)) > $null",
      "$t.Item(1).AppendChild($xml.CreateTextNode($env:HD_BODY)) > $null",
      "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
    ].join("; ");
    return { cmd: ["powershell", "-NoProfile", "-NonInteractive", "-Command", script], env: { HD_TITLE: title, HD_BODY: body } };
  }
  const send = Bun.which("notify-send");
  return send ? { cmd: [send, "--app-name=Harness Dashboard", "--icon=harness-dashboard", title, body] } : null;
}

/** Shows the notification. False when this system has no way to (Linux without notify-send). */
export async function notify(title: string, body: string): Promise<boolean> {
  const c = notifyCommand(title, body);
  if (!c) return false;
  try {
    const proc = Bun.spawn(c.cmd, { stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, ...c.env } });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0;
  } catch {
    return false;
  }
}
