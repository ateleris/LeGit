# Samples the memory of the running LeGit app and everything it started
# (webview, git children) while you perform an action in it, then prints the
# peaks. Start it, do the action in LeGit, wait for it to finish.
#
#   .\scripts\perf-mem.ps1 [-Seconds 60] [-Label merge-fixture] [-ReportDir ..\LeGit-Perf]

param(
    [int]$Seconds = 60,
    [string]$Label = "run",
    [string]$ReportDir = (Join-Path $PSScriptRoot "..\..\LeGit-Perf"),
    [int]$IntervalMs = 500
)

$ErrorActionPreference = "Stop"
$appNames = @("legit-app.exe", "LeGit.exe")

function Get-Sample {
    $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, WorkingSetSize
    $children = @{}
    foreach ($p in $all) {
        if (-not $children.ContainsKey($p.ParentProcessId)) { $children[$p.ParentProcessId] = @() }
        $children[$p.ParentProcessId] += $p
    }
    $sample = @{ app = 0; webview = 0; git = 0; other = 0; gitCount = 0 }
    $queue = New-Object System.Collections.Queue
    foreach ($p in $all) { if ($appNames -contains $p.Name) { $queue.Enqueue($p) } }
    $seen = @{}
    while ($queue.Count -gt 0) {
        $p = $queue.Dequeue()
        if ($seen.ContainsKey($p.ProcessId)) { continue }
        $seen[$p.ProcessId] = $true
        $mb = $p.WorkingSetSize / 1MB
        if ($appNames -contains $p.Name) { $sample.app += $mb }
        elseif ($p.Name -eq "msedgewebview2.exe") { $sample.webview += $mb }
        elseif ($p.Name -like "git*.exe") { $sample.git += $mb; $sample.gitCount += 1 }
        else { $sample.other += $mb }
        if ($children.ContainsKey($p.ProcessId)) { foreach ($c in $children[$p.ProcessId]) { $queue.Enqueue($c) } }
    }
    $sample
}

New-Item -ItemType Directory -Force $ReportDir | Out-Null
$stamp = Get-Date -Format "yyyy-MM-dd-HHmm"
$csv = Join-Path $ReportDir "mem-$Label-$stamp.csv"
"seconds,app_mb,webview_mb,git_mb,other_mb,git_processes,total_mb" | Set-Content -Encoding UTF8 $csv

$peak = @{ app = 0; webview = 0; git = 0; other = 0; gitCount = 0; total = 0 }
$clock = [System.Diagnostics.Stopwatch]::StartNew()
Write-Host "Sampling for $Seconds s. Perform the action in LeGit now."
while ($clock.Elapsed.TotalSeconds -lt $Seconds) {
    $s = Get-Sample
    $total = $s.app + $s.webview + $s.git + $s.other
    "{0:F1},{1:F0},{2:F0},{3:F0},{4:F0},{5},{6:F0}" -f $clock.Elapsed.TotalSeconds, $s.app, $s.webview, $s.git, $s.other, $s.gitCount, $total |
        Add-Content -Encoding UTF8 $csv
    foreach ($k in @("app", "webview", "git", "other", "gitCount")) { if ($s[$k] -gt $peak[$k]) { $peak[$k] = $s[$k] } }
    if ($total -gt $peak.total) { $peak.total = $total }
    Start-Sleep -Milliseconds $IntervalMs
}

Write-Host ""
Write-Host ("Peak app process:      {0:F0} MB" -f $peak.app)
Write-Host ("Peak webview:          {0:F0} MB" -f $peak.webview)
Write-Host ("Peak git children:     {0:F0} MB ({1} at once)" -f $peak.git, $peak.gitCount)
Write-Host ("Peak other children:   {0:F0} MB" -f $peak.other)
Write-Host ("Peak total:            {0:F0} MB" -f $peak.total)
Write-Host "Samples: $csv"
