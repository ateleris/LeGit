# Build the Linux legit-agent from a WINDOWS checkout, via WSL, and place it
# where the Windows bundle expects it (src-tauri/agent/legit-agent-<arch>).
#
# Release builds get the agent from CI (see .github/workflows/release.yml);
# this script is the dev fallback so a local `tauri build` on Windows can
# produce a bundle with WSL support. It builds inside the DEFAULT distro
# against this same checkout through the /mnt/<drive> mount.
#
# Alternative for dev runs (no bundling needed): build the agent in WSL
# (`cargo build -p legit-agent`) and point the app at it with
#   $env:LEGIT_AGENT_BIN = "\\wsl.localhost\<distro>\...\target\debug\legit-agent"
# — the app reads the bytes once at deploy time, so 9P slowness is harmless.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$wslRoot = (wsl.exe --exec wslpath -a ($repoRoot -replace '\\', '/')).Trim()
if (-not $wslRoot) { throw "wslpath failed - is WSL installed?" }

Write-Host "Building legit-agent (x86_64-unknown-linux-musl) in WSL at $wslRoot ..."
wsl.exe --exec sh -lc "cd '$wslRoot' && rustup target add x86_64-unknown-linux-musl && cargo build -p legit-agent --release --target x86_64-unknown-linux-musl"
if ($LASTEXITCODE -ne 0) { throw "agent build failed" }

$dest = Join-Path $repoRoot "src-tauri\agent"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $repoRoot "target\x86_64-unknown-linux-musl\release\legit-agent") `
          (Join-Path $dest "legit-agent-x86_64") -Force

# The Windows bundle references both arches; provide a placeholder when the
# aarch64 cross toolchain isn't set up locally (CI builds the real one).
$aarch64 = Join-Path $dest "legit-agent-aarch64"
if (-not (Test-Path $aarch64)) {
    Copy-Item (Join-Path $dest "legit-agent-x86_64") $aarch64
    Write-Warning "aarch64 agent is a copy of the x86_64 build (dev placeholder) - ARM64 WSL will not work with this bundle."
}

Write-Host "Agent staged in src-tauri/agent/."
