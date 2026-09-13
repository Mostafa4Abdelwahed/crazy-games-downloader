<#
.SYNOPSIS
  Loop over all game folders: one isolated opencode session per folder, one by one.
.DESCRIPTION
  - Discovers direct subdirectories under -Root, sorted alphabetically.
  - Skips already-done folders (state file), safe to stop and resume.
  - Each folder = a brand-new `opencode run` => no cross-game mixing => no hallucination.
  - Per-folder log + summary.csv + summary.md + state JSON.
  - Never kills user servers or user Chrome. Between-round cleanup is opt-in
    and restricted to python http.server on the same port (-CleanupBetween).
.EXAMPLE
  .\run-all.ps1 -Root 'C:\...\rejected' -DryRun
.EXAMPLE
  .\run-all.ps1 -Root 'C:\...\rejected' -AutoApprove
.EXAMPLE
  .\run-all.ps1 -Root 'C:\...\rejected' -Only 'butterfly*,moto*' -Model 'anthropic/claude-sonnet-4-5' -AutoApprove
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Root,

  [int]$Port = 8080,

  [string]$TemplatePath = (Join-Path $PSScriptRoot 'prompt.template.md'),

  [string]$WorkspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,

  [string]$LogDir = (Join-Path $PSScriptRoot 'logs'),

  [string]$StateFile = '',

  [string[]]$Only = @(),

  [string[]]$Exclude = @(),

  [string]$Model = '',

  [string]$Agent = '',

  [switch]$AutoApprove,

  [switch]$DryRun,

  [switch]$RedoFailed,

  [switch]$CleanupBetween
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
  throw "Root not found: $Root"
}
$Root = (Resolve-Path -LiteralPath $Root).Path
if ($StateFile -eq '') { $StateFile = Join-Path $LogDir 'state.json' }
if (-not (Test-Path -LiteralPath $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir | Out-Null
}

function Test-WildcardMatch([string]$Name, [string[]]$Patterns) {
  foreach ($p in $Patterns) {
    if ($Name -like $p) { return $true }
  }
  return $false
}

function Get-PortOwnerPid([int]$CheckPort) {
  try {
    $c = Get-NetTCPConnection -LocalPort $CheckPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return $c.OwningProcess }
  } catch { }
  return $null
}

function Clear-LoopServer([int]$CheckPort) {
  # Kills ONLY python http.server on the same port. Touches nothing else, never Chrome.
  try {
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like "*http.server*$CheckPort*" }
    foreach ($p in $procs) {
      Write-Warning ("Between-round cleanup: stopping PID " + $p.ProcessId)
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Write-Warning ("Cleanup failed: " + $_.Exception.Message)
  }
}

$dirs = Get-ChildItem -LiteralPath $Root -Directory | Sort-Object Name
if ($Only.Count -gt 0) {
  $dirs = $dirs | Where-Object { Test-WildcardMatch $_.Name $Only }
}
if ($Exclude.Count -gt 0) {
  $dirs = $dirs | Where-Object { -not (Test-WildcardMatch $_.Name $Exclude) }
}

if ($dirs.Count -eq 0) {
  Write-Warning "No matching folders under: $Root"
  return
}

Write-Output ("Found " + $dirs.Count + " folders under $Root (port $Port):")
$dirs | ForEach-Object { Write-Output ("  - " + $_.Name) }

# Load previous state
$state = @{}
if ((Test-Path -LiteralPath $StateFile) -and (-not $DryRun)) {
  try {
    $raw = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8
    if ($raw.Trim() -ne '') {
      $obj = $raw | ConvertFrom-Json
      foreach ($prop in $obj.PSObject.Properties) { $state[$prop.Name] = $prop.Value }
    }
  } catch {
    Write-Warning ("State unreadable, starting fresh: " + $_.Exception.Message)
  }
}

function Save-State {
  $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StateFile -Encoding UTF8
}

$runOne = Join-Path $PSScriptRoot 'run-one.ps1'
$results = @()
$index = 0

foreach ($d in $dirs) {
  $index++
  $name = $d.Name
  $prev = $state[$name]

  if ((-not $DryRun) -and $prev -and ($prev.status -eq 'done')) {
    Write-Output "[$index/$($dirs.Count)] SKIP done: $name"
    $results += [pscustomobject]@{ game = $name; status = 'skipped-done'; exit = ''; log = $prev.log }
    continue
  }
  if ((-not $DryRun) -and $prev -and ($prev.status -eq 'failed') -and (-not $RedoFailed)) {
    Write-Output "[$index/$($dirs.Count)] SKIP failed (use -RedoFailed to retry): $name"
    $results += [pscustomobject]@{ game = $name; status = 'skipped-failed'; exit = $prev.exitCode; log = $prev.log }
    continue
  }

  Write-Output ""
  Write-Output "[$index/$($dirs.Count)] START $name"

  $splat = @{
    GameDir = $d.FullName
    Port = $Port
    TemplatePath = $TemplatePath
    WorkspaceRoot = $WorkspaceRoot
    LogDir = $LogDir
  }
  if ($Model -ne '') { $splat['Model'] = $Model }
  if ($Agent -ne '') { $splat['Agent'] = $Agent }
  if ($AutoApprove) { $splat['AutoApprove'] = $true }
  if ($DryRun) { $splat['DryRun'] = $true }

  if ($DryRun) {
    & $runOne @splat
    $results += [pscustomobject]@{ game = $name; status = 'dryrun'; exit = ''; log = '' }
    continue
  }

  if ($CleanupBetween) { Clear-LoopServer -CheckPort $Port }
  else {
    $owner = Get-PortOwnerPid -CheckPort $Port
    if ($owner) { Write-Warning ("Port $Port busy (PID=$owner) before $name. Continuing; AI will reuse per its rules.") }
  }

  $t0 = Get-Date
  & $runOne @splat
  $code = $LASTEXITCODE
  $t1 = Get-Date

  $safeName = ($name -replace '[^\w\-.]+', '_')
  $latestLog = Get-ChildItem -LiteralPath $LogDir -Filter "*$safeName.log" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1

  $status = 'done'
  if ($code -ne 0) { $status = 'failed' }
  $logPath = ''
  if ($latestLog) { $logPath = $latestLog.FullName }
  $state[$name] = @{
    status = $status
    exitCode = $code
    log = $logPath
    startedAt = $t0.ToString('o')
    endedAt = $t1.ToString('o')
  }
  Save-State
  $results += [pscustomobject]@{ game = $name; status = $status; exit = $code; log = $logPath }

  if ($status -eq 'failed') {
    Write-Warning ("FAILED $name (exit=$code), continuing to next. Rerun with -RedoFailed later.")
  } else {
    Write-Output ("OK $name")
  }
  Start-Sleep -Seconds 2
}

# Summaries
if (-not $DryRun) {
  $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
  $csv = Join-Path $LogDir ("summary-" + $ts + '.csv')
  $md = Join-Path $LogDir ("summary-" + $ts + '.md')
  $results | Export-Csv -LiteralPath $csv -NoTypeInformation -Encoding UTF8
  $lines = @('# AI Loop summary', '', '| game | status | exit | log |', '|---|---|---|---|')
  foreach ($r in $results) {
    $lines += "| $($r.game) | $($r.status) | $($r.exit) | $($r.log) |"
  }
  Set-Content -LiteralPath $md -Value ($lines -join "`r`n") -Encoding UTF8
  Write-Output ""
  Write-Output '===== SUMMARY ====='
  $results | Format-Table -AutoSize | Out-String | Write-Output
  Write-Output "CSV: $csv"
  Write-Output "MD: $md"
  Write-Output "STATE: $StateFile"
}
