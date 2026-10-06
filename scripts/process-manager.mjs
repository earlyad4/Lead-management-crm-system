import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] === "production" ? "production" : "dev";
const frontendPort = process.env.FRONTEND_PORT || "3001";
const vinextCli = path.join(root, "node_modules", "vinext", "dist", "cli.js");
const frontendArgs = [vinextCli, mode === "production" ? "start" : "dev", "--port", frontendPort, "--hostname", "127.0.0.1"];
const backendArgs = mode === "production" ? [path.join(root,"dist-server","index.mjs")] : ["--import","tsx",path.join(root,"server","index.ts")];
const runDirectory=path.join(root,"run");const pidFile=path.join(runDirectory,"crm.pid");
mkdirSync(runDirectory,{recursive:true});writeFileSync(pidFile,String(process.pid),{encoding:"utf8"});

const children = [];
const launch = (label, args) => {
  const child = spawn(process.execPath, args, { cwd:root, env:{...process.env,FRONTEND_PORT:frontendPort}, stdio:"inherit", windowsHide:false });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (!stopping) {
      process.stderr.write(`${label} stopped unexpectedly (${signal || code}).\n`);
      stop(code || 1);
    }
  });
  return child;
};

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  try{rmSync(pidFile,{force:true})}catch{/* PID cleanup is best effort during shutdown. */}
  for (const child of children) if (!child.killed) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1_500).unref();
};

launch("frontend", frontendArgs);
setTimeout(() => launch("backend", backendArgs), 400);
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
process.on("exit",()=>{try{rmSync(pidFile,{force:true})}catch{/* PID cleanup is best effort during process exit. */}});
