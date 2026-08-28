import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./winforms.ps1", import.meta.url));

export const name = "winforms";

export const available = () => process.platform === "win32";

// Hooks have no TTY, so the dialog has to be its own window. A PowerShell
// WinForms modal launched as a child process blocks until dismissed and hands
// structured data back on stdout.
export function ask(rows, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", SCRIPT],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      const trimmed = out.trim();
      if (!trimmed) {
        reject(new Error(`dialog produced no output (exit ${code}): ${err.slice(0, 300)}`));
        return;
      }
      try {
        resolve(JSON.parse(trimmed));
      } catch (e) {
        reject(new Error(`dialog output was not JSON: ${e.message}`));
      }
    });

    // Give the dialog a little longer than its own timer before giving up on it.
    const guard = setTimeout(() => child.kill(), timeoutMs + 15_000);
    child.on("close", () => clearTimeout(guard));

    child.stdin.write(JSON.stringify({ rows, timeoutMs }));
    child.stdin.end();
  });
}
