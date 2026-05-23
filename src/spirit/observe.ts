import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const SCRIPT = `
tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  set winTitle to ""
  try
    set winTitle to name of first window of frontApp
  end try
  return appName & "\\t" & winTitle
end tell
`;

export type ActiveApp = { app: string; title: string };

export async function getActiveApp(): Promise<ActiveApp> {
  try {
    const { stdout } = await execFileP("osascript", ["-e", SCRIPT], { timeout: 3000 });
    const [app, ...rest] = stdout.trim().split("\t");
    return { app: app ?? "", title: rest.join("\t") };
  } catch (e) {
    return { app: "", title: "" };
  }
}
