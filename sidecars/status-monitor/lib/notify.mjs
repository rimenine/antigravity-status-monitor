import { execFile } from "node:child_process";

function escapeAppleScript(str) {
  return String(str || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .slice(0, 200);
}

function escapeXml(str) {
  return String(str || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .slice(0, 200);
}

export function sendDesktopNotification(title, message) {
  try {
    if (process.platform === "win32") {
      const escPs = (s) => s.replace(/'/g, "''");
      const toastXml = `<toast><visual><binding template="ToastText02"><text id="1">${escapeXml(title)}</text><text id="2">${escapeXml(message)}</text></binding></visual></toast>`;
      const psScript = [
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;",
        "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;",
        "$x = [Windows.Data.Xml.Dom.XmlDocument]::new();",
        `$x.LoadXml('${escPs(toastXml)}');`,
        // WinRT Toast 必须绑定已在开始菜单注册的 AppUserModelID，借用 System32 已知文件夹 GUID + PowerShell 身份弹窗避免被静默丢弃
        "$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';",
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($x));",
      ].join(" ");
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psScript],
        { windowsHide: true },
        () => {},
      );
      return;
    }

    if (process.platform === "darwin") {
      const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`;
      execFile("osascript", ["-e", script], () => {});
      return;
    }

    if (process.platform === "linux") {
      execFile(
        "notify-send",
        ["-u", "critical", "-a", "Antigravity Status Monitor", String(title).slice(0, 200), String(message).slice(0, 200)],
        () => {},
      );
    }
  } catch {
  }
}
