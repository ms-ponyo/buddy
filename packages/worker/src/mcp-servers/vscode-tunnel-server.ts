import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { execFileSync, spawn } from "child_process";
import { hostname } from "os";

const CODE_CLI = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function runCodeCli(...args: string[]): string {
  return execFileSync(CODE_CLI, args, {
    encoding: "utf-8",
    timeout: 15_000,
  }).trim();
}

interface TunnelStatus {
  tunnel: { name: string; uri: string } | null;
  service_installed: boolean;
}

export function getTunnelStatus(): TunnelStatus {
  try {
    const raw = runCodeCli("tunnel", "status");
    return JSON.parse(raw);
  } catch {
    return { tunnel: null, service_installed: false };
  }
}

function getMachineName(): string | null {
  const status = getTunnelStatus();
  if (status.tunnel?.name) return status.tunnel.name;
  const h = hostname().replace(/\.local$/, "");
  return h || null;
}

/**
 * Spawn `code tunnel user login --provider github` and wait for the device
 * code prompt. Returns the URL + code for the user, then continues waiting
 * for auth to complete in the background.
 *
 * Resolves with { deviceCode, verificationUrl, pid } once the prompt is
 * detected, or rejects on timeout / early exit.
 */
function startLogin(): Promise<{
  deviceCode: string;
  verificationUrl: string;
  pid: number;
  done: Promise<string>;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(CODE_CLI, ["tunnel", "user", "login", "--provider", "github"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        child.kill();
        reject(new Error(`Timed out waiting for device code. Output so far:\n${stdout}\n${stderr}`));
      }
    }, 30_000);

    // Promise that resolves when the login process exits
    const done = new Promise<string>((doneResolve, doneReject) => {
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          doneResolve("Login completed successfully.");
        } else {
          const msg = `Login process exited with code ${code}.\n${stdout}\n${stderr}`;
          if (!resolved) reject(new Error(msg));
          doneReject(new Error(msg));
        }
      });
    });

    const tryParse = () => {
      if (resolved) return;
      const combined = stdout + stderr;
      // The CLI prints something like:
      //   To sign in, use a web browser to open the page https://github.com/login/device
      //   and enter the code XXXX-XXXX
      const urlMatch = combined.match(/(https:\/\/github\.com\/login\/device)/);
      const codeMatch = combined.match(/code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/);
      if (urlMatch && codeMatch) {
        resolved = true;
        resolve({
          deviceCode: codeMatch[1],
          verificationUrl: urlMatch[1],
          pid: child.pid!,
          done,
        });
      }
    };

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      tryParse();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      tryParse();
    });

    // Handle already-logged-in case
    child.on("close", () => {
      if (!resolved) {
        const combined = stdout + stderr;
        if (combined.includes("already logged in") || combined.includes("Successfully logged in")) {
          resolved = true;
          resolve({
            deviceCode: "",
            verificationUrl: "",
            pid: child.pid!,
            done: Promise.resolve("Already logged in."),
          });
        }
      }
    });
  });
}

export function createVscodeTunnelServer() {
  // Track the login-done promise so we can check if auth completed
  let loginDone: Promise<string> | null = null;

  return createSdkMcpServer({
    name: "vscode-tunnel",
    tools: [
      tool(
        "vscode_tunnel_status",
        "Check whether a VS Code tunnel is running on this machine, whether the tunnel service is installed, and whether a user is logged in.",
        {},
        async () => {
          try {
            const status = getTunnelStatus();
            const lines: string[] = [];
            // Check login status
            try {
              const user = runCodeCli("tunnel", "user", "show");
              lines.push(`Logged in: ${user}`);
            } catch {
              lines.push("Logged in: no");
            }
            if (status.tunnel) {
              lines.push(`Tunnel running: ${status.tunnel.name}`);
              if (status.tunnel.uri) lines.push(`URI: ${status.tunnel.uri}`);
            } else {
              lines.push("Tunnel is NOT running.");
            }
            lines.push(`Service installed: ${status.service_installed}`);
            return textResult(lines.join("\n"));
          } catch (err) {
            return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      ),

      tool(
        "vscode_tunnel_login",
        "Start GitHub device-code login for VS Code tunnel. Returns a URL and code that the user must open in a browser to authenticate. The login continues in the background — use vscode_tunnel_login_check to see if it completed.",
        {},
        async () => {
          try {
            // Check if already logged in
            try {
              const user = runCodeCli("tunnel", "user", "show");
              if (user && !user.includes("not logged in")) {
                return textResult(`Already logged in: ${user}`);
              }
            } catch { /* not logged in */ }

            const result = await startLogin();
            loginDone = result.done;

            if (!result.deviceCode) {
              // Already logged in case
              const msg = await result.done;
              return textResult(msg);
            }

            return textResult(
              [
                "GitHub authentication required.",
                "",
                `1. Open: ${result.verificationUrl}`,
                `2. Enter code: ${result.deviceCode}`,
                "",
                "Waiting for authentication... Use vscode_tunnel_login_check after completing the browser flow.",
              ].join("\n"),
            );
          } catch (err) {
            return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      ),

      tool(
        "vscode_tunnel_login_check",
        "Check if the GitHub login flow (started by vscode_tunnel_login) has completed.",
        {},
        async () => {
          try {
            // Quick check — is user already logged in?
            try {
              const user = runCodeCli("tunnel", "user", "show");
              if (user && !user.includes("not logged in")) {
                return textResult(`Logged in: ${user}`);
              }
            } catch { /* not logged in yet */ }

            if (!loginDone) {
              return textResult("No login in progress. Call vscode_tunnel_login first.");
            }

            // Check with a short race — don't block forever
            const result = await Promise.race([
              loginDone.then((msg) => ({ status: "done" as const, msg })),
              new Promise<{ status: "pending" }>((r) => setTimeout(() => r({ status: "pending" }), 2_000)),
            ]);

            if (result.status === "done") {
              loginDone = null;
              return textResult(result.msg);
            }
            return textResult("Login still pending — user has not completed the browser auth yet.");
          } catch (err) {
            loginDone = null;
            return textResult(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      ),

      tool(
        "vscode_tunnel_service_install",
        "Install the VS Code tunnel as a system service so it starts on boot and stays running. Must be logged in first (use vscode_tunnel_login).",
        {
          name: z.string().optional().describe("Machine name for the tunnel. Defaults to hostname."),
        },
        async (args) => {
          try {
            const cliArgs = ["tunnel", "service", "install", "--accept-server-license-terms"];
            if (args.name) {
              cliArgs.push("--name", args.name);
            }
            const out = runCodeCli(...cliArgs);
            return textResult(out || "Tunnel service installed successfully.");
          } catch (err) {
            return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      ),

      tool(
        "vscode_tunnel_service_uninstall",
        "Uninstall the VS Code tunnel system service.",
        {},
        async () => {
          try {
            const out = runCodeCli("tunnel", "service", "uninstall");
            return textResult(out || "Tunnel service uninstalled.");
          } catch (err) {
            return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      ),

      tool(
        "vscode_tunnel_link",
        "Generate a VS Code tunnel connect link for a folder on this machine. Returns both a browser URL (vscode.dev) and a desktop URI (vscode://) that opens VS Code connected to the remote folder. The tunnel must be running. IMPORTANT: When presenting the desktop URI to the user, format it as a clickable link (e.g. in Slack use <vscode://...> syntax) so the user can click it directly.",
        {
          folder_path: z.string().describe("Absolute path to the folder on this machine, e.g. /path/to/your/project"),
        },
        async (args) => {
          try {
            const name = getMachineName();
            if (!name) {
              return textResult("Could not determine tunnel machine name. Is the tunnel running? Run vscode_tunnel_status to check.");
            }
            const folder = args.folder_path.replace(/\/+$/, "");
            const browserUrl = `https://vscode.dev/tunnel/${name}${folder}`;
            const desktopUri = `vscode://vscode-remote/tunnel+${name}${folder}`;

            return textResult(
              [
                `Machine: ${name}`,
                `Folder: ${folder}`,
                "",
                `Browser: ${browserUrl}`,
                `Desktop: ${desktopUri}`,
              ].join("\n"),
            );
          } catch (err) {
            return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      ),
    ],
  });
}
