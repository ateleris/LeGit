// Stage the Linux legit-agent binaries the WINDOWS bundle references
// (src-tauri/agent/legit-agent-<arch>, see tauri.windows.conf.json), so a
// fresh checkout can `npm run tauri:dev` / `tauri:build` without a manual
// step. Non-Windows platforms reference no agent resources - nothing to do.
//
// Already-staged binaries are kept (CI downloads its cross-built artifact
// there; delete src-tauri/agent/ - or run
// scripts/build-agent-from-windows.ps1 - to force a rebuild). Otherwise the
// x86_64 musl agent is built in the default WSL distro against this same
// checkout; the aarch64 slot gets a copy as a dev placeholder (CI builds the
// real one - ARM64 WSL will not work with a placeholder bundle).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") process.exit(0);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "src-tauri", "agent");
const x64 = path.join(dest, "legit-agent-x86_64");
const a64 = path.join(dest, "legit-agent-aarch64");

if (fs.existsSync(x64) && fs.existsSync(a64)) {
  console.log("legit-agent already staged (delete src-tauri/agent/ to force a rebuild).");
  process.exit(0);
}

let wslRoot;
try {
  wslRoot = execFileSync("wsl.exe", ["--exec", "wslpath", "-a", root.replaceAll("\\", "/")], {
    stdio: ["ignore", "pipe", "inherit"],
  })
    .toString()
    .trim();
} catch {
  console.error(
    "src-tauri/agent/ is not staged and WSL is unavailable to build the agent.\n" +
      "Install WSL, or place prebuilt legit-agent-x86_64 / legit-agent-aarch64 into src-tauri/agent/.",
  );
  process.exit(1);
}

console.log(`Building legit-agent (x86_64-unknown-linux-musl) in WSL at ${wslRoot} ...`);
execFileSync(
  "wsl.exe",
  [
    "--exec",
    "sh",
    "-lc",
    `cd '${wslRoot}' && rustup target add x86_64-unknown-linux-musl && ` +
      "cargo build -p legit-agent --release --target x86_64-unknown-linux-musl",
  ],
  { stdio: "inherit" },
);

fs.mkdirSync(dest, { recursive: true });
fs.copyFileSync(path.join(root, "target", "x86_64-unknown-linux-musl", "release", "legit-agent"), x64);
if (!fs.existsSync(a64)) {
  fs.copyFileSync(x64, a64);
  console.warn(
    "aarch64 agent is a copy of the x86_64 build (dev placeholder) - ARM64 WSL will not work with this bundle.",
  );
}
console.log("Agent staged in src-tauri/agent/.");
