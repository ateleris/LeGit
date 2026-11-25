# Local performance measurements. Runs on the developer machine only and
# writes a dated report next to the previous ones, outside the repository.
#
#   .\scripts\perf.ps1 -Repo C:\path\to\repo [-ReportDir ..\LeGit-Perf] [-Rounds 40]

param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [string]$ReportDir = (Join-Path $PSScriptRoot "..\..\LeGit-Perf"),
    [int]$Rounds = 40
)

$ErrorActionPreference = "Stop"

$shim = (Get-Command git).Source
$binaries = @($shim)
$real = Join-Path (Split-Path (Split-Path $shim)) "mingw64\bin\git.exe"
if ((Test-Path $real) -and ($real -ne $shim)) { $binaries += $real }

$env:LEGIT_PERF_REPO = (Resolve-Path $Repo).Path
$env:LEGIT_PERF_GIT = $binaries -join ";"
$env:LEGIT_PERF_ROUNDS = $Rounds

New-Item -ItemType Directory -Force $ReportDir | Out-Null
$report = Join-Path $ReportDir ("perf-" + (Get-Date -Format "yyyy-MM-dd-HHmm") + ".md")

Push-Location (Join-Path $PSScriptRoot "..")
try {
    # Windows PowerShell turns native stderr into errors under "Stop".
    $ErrorActionPreference = "Continue"
    $output =cargo test --release -p legit-core --test perf_overhead -- --ignored --nocapture --test-threads=1 2>&1
    $ErrorActionPreference = "Stop"
    if ($LASTEXITCODE -ne 0) { $output | Write-Host; throw "perf run failed" }
} finally {
    Pop-Location
}

$header = @(
    "# LeGit perf report $(Get-Date -Format 'yyyy-MM-dd HH:mm')",
    "",
    "- Repository: $($env:LEGIT_PERF_REPO)",
    "- git: $(git --version)",
    "- Machine: $((Get-CimInstance Win32_Processor).Name), $([math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)) GB"
)
$tables = $output | ForEach-Object { "$_" } | Where-Object { $_ -match '^(\||## )' -or $_ -eq "" }
($header + $tables) | Set-Content -Encoding UTF8 $report
Get-Content $report
Write-Host "`nReport: $report"
