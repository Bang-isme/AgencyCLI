import { execa } from "execa";
import { join } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";

const cliEntry = join(process.cwd(), "../cli/dist/index.js");
const projectRoot = join(process.cwd(), "../../");
const agencyDir = join(projectRoot, ".agency");
const serverJsonPath = join(agencyDir, "server.json");

if (existsSync(serverJsonPath)) {
  try {
    unlinkSync(serverJsonPath);
  } catch {}
}

console.log("Starting Daemon...");
const daemon = execa("node", [cliEntry, "server", "start", "--port", "0", "--project-root", projectRoot]);
daemon.stdout?.on("data", (chunk) => {
  console.log(`[DAEMON STDOUT]: ${chunk.toString().trim()}`);
});
daemon.stderr?.on("data", (chunk) => {
  console.error(`[DAEMON STDERR]: ${chunk.toString().trim()}`);
});
daemon.on("exit", (code, signal) => {
  console.log(`[DAEMON EXIT]: code=${code}, signal=${signal}`);
});
// Catch the promise so the script doesn't crash on daemon exit
daemon.catch((err) => {
  console.log("[DAEMON PROMISE REJECTED]:", err.message);
});

// Wait for server.json
let config = null;
let attempts = 0;
while (attempts < 50) {
  if (existsSync(serverJsonPath)) {
    try {
      config = JSON.parse(readFileSync(serverJsonPath, "utf8"));
      if (config && config.url) break;
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  attempts++;
}

console.log("Config loaded:", config);

console.log("Starting TUI Process...");
const tuiProcess = execa("node", [cliEntry], {
  env: {
    ...process.env,
    AGENCY_TUI: "true",
    FORCE_COLOR: "0",
  },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  timeout: 10000,
});
console.log("TUI Process PID:", tuiProcess.pid);

tuiProcess.stdout?.on("data", (chunk) => {
  console.log(`[TUI STDOUT]: ${chunk.toString().trim()}`);
});
tuiProcess.stderr?.on("data", (chunk) => {
  console.error(`[TUI STDERR]: ${chunk.toString().trim()}`);
});
tuiProcess.on("exit", (code, signal) => {
  console.log(`[TUI EXIT]: code=${code}, signal=${signal}`);
});
tuiProcess.catch((err) => {
  console.log("[TUI PROMISE REJECTED]:", err.message);
});

// Let it run and output layout
await new Promise((resolve) => setTimeout(resolve, 3000));

console.log("Killing TUI...");
tuiProcess.kill("SIGKILL");
await tuiProcess.catch((err) => err);
console.log("TUI killed.");

// Wait 2 seconds
await new Promise((resolve) => setTimeout(resolve, 2000));

console.log("Checking daemon status...");
try {
  process.kill(daemon.pid, 0);
  console.log("Daemon is STILL ALIVE!");
  daemon.kill("SIGKILL");
} catch {
  console.log("Daemon is DEAD.");
}
