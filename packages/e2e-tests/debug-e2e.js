import { execa } from "execa";
import { join } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";

const cliEntry = join(process.cwd(), "../cli/dist/index.js");
const projectRoot = join(process.cwd(), "../../");
const agencyDir = join(projectRoot, ".agency");
const serverJsonPath = join(agencyDir, "server.json");

async function run() {
  if (existsSync(serverJsonPath)) {
    try { unlinkSync(serverJsonPath); } catch {}
  }

  console.log("Starting daemon...");
  const daemonProcess = execa("node", [cliEntry, "server", "start", "--port", "0", "--project-root", projectRoot]);
  
  daemonProcess.stdout.on("data", (chunk) => {
    console.log(`[DAEMON STDOUT]: ${chunk}`);
  });
  daemonProcess.stderr.on("data", (chunk) => {
    console.error(`[DAEMON STDERR]: ${chunk}`);
  });
  daemonProcess.on("exit", (code, signal) => {
    console.log(`[DAEMON EXIT]: code=${code}, signal=${signal}`);
  });

  // Wait for server.json
  let serverConfig = null;
  let attempts = 0;
  while (attempts < 50) {
    if (existsSync(serverJsonPath)) {
      try {
        serverConfig = JSON.parse(readFileSync(serverJsonPath, "utf8"));
        if (serverConfig && serverConfig.url) break;
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    attempts++;
  }

  if (!serverConfig) {
    console.error("Failed to start daemon server");
    daemonProcess.kill("SIGKILL");
    process.exit(1);
  }

  console.log(`Daemon started at ${serverConfig.url}, PID=${serverConfig.pid}`);

  console.log("Starting TUI process...");
  const tuiProcess = execa("node", [cliEntry], {
    env: {
      ...process.env,
      AGENCY_TUI: "true",
      FORCE_COLOR: "0",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  tuiProcess.stdout.on("data", (chunk) => {
    console.log(`[TUI STDOUT]: ${chunk.toString().substring(0, 100)}...`);
  });
  tuiProcess.stderr.on("data", (chunk) => {
    console.error(`[TUI STDERR]: ${chunk.toString()}`);
  });

  await new Promise((resolve) => setTimeout(resolve, 2500));

  console.log("Killing TUI process...");
  tuiProcess.kill("SIGKILL");
  await tuiProcess.catch((err) => err);
  console.log("TUI process killed.");

  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log("Checking if daemon is still alive by fetching health...");
  try {
    const res = await fetch(`${serverConfig.url}/health`);
    console.log(`Fetch health status: ${res.status}`);
    const data = await res.json();
    console.log("Fetch health body:", data);
  } catch (err) {
    console.error("Fetch health failed:", err);
  }

  console.log("Stopping daemon...");
  if (serverConfig && serverConfig.url && serverConfig.token) {
    try {
      await fetch(`${serverConfig.url}/server/stop`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${serverConfig.token}` },
        signal: AbortSignal.timeout(1000),
      });
      console.log("Sent server stop request successfully.");
    } catch (e) {
      console.error("Failed to send server stop:", e);
    }
  }
  daemonProcess.kill("SIGTERM");
  await daemonProcess.catch(() => {});
  console.log("Done");
}

run().catch(console.error);
