<#
.SYNOPSIS
  Run one isolated opencode session for a single game folder (anti-hallucination).
.DESCRIPTION
  Builds the prompt from prompt.template.md by replacing {{GAME_DIR}}, {{GAME_URL}}, {{PORT}}
  then calls `opencode run` in a brand-new session, so the AI only ever sees ONE folder.
  Supports DryRun to print the final prompt without executing.
.EXAMPLE
  .\run-one.ps1 -GameDir 'C:\...\butterfly-shimai-play-on-crazygames' -Port 8080 -DryRun
.EXAMPLE
  .\run-one.ps1 -GameDir 'C:\...\game1' -AutoApprove
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$GameDir,

  [int]$Port = 8080,

  [string]$TemplatePath = '',

  [string]$WorkspaceRoot = '',

  [string]$LogDir = '',

  [string]$Model = '',

  [string]$Agent = '',

  [switch]$AutoApprove,

  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Resolve script dir without relying on $PSScriptRoot in param defaults
# (it can be empty with some `powershell -File` invocation styles).
$scriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($scriptDir)) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrEmpty($scriptDir)) {
  $scriptDir = Join-Path (Get-Location).Path 'scripts\ai-loop'
}
if ($TemplatePath -eq '') { $TemplatePath = Join-Path $scriptDir 'prompt.template.md' }
if ($WorkspaceRoot -eq '') { $WorkspaceRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path }
if ($LogDir -eq '') { $LogDir = Join-Path $scriptDir 'logs' }

if (-not (Test-Path -LiteralPath $GameDir -PathType Container)) {
  throw "GameDir not found: $GameDir"
}
if (-not (Test-Path -LiteralPath $TemplatePath -PathType Leaf)) {
  throw "Template not found: $TemplatePath"
}
$GameDir = (Resolve-Path -LiteralPath $GameDir).Path
$gameName = Split-Path $GameDir -Leaf
$gameUrl = "http://localhost:$Port"

$template = Get-Content -LiteralPath $TemplatePath -Raw -Encoding UTF8
$prompt = $template.Replace('{{GAME_DIR}}', $GameDir).Replace('{{GAME_URL}}', $gameUrl).Replace('{{PORT}}', "$Port")

if ($DryRun) {
  Write-Output '===== DRY-RUN PROMPT ====='
  Write-Output $prompt
  Write-Output '===== END ====='
  Write-Output "GameDir: $GameDir"
  Write-Output "GameUrl: $gameUrl"
  Write-Output "WorkspaceRoot: $WorkspaceRoot"
  return
}

if (-not (Test-Path -LiteralPath $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir | Out-Null
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$safeName = ($gameName -replace '[^\w\-.]+', '_')
$logFile = Join-Path $LogDir "$stamp-$safeName.log"
$promptFile = Join-Path $LogDir "$stamp-$safeName.prompt.md"
Set-Content -LiteralPath $promptFile -Value $prompt -Encoding UTF8

# Warn if port is busy. Do NOT kill it: user servers are off-limits,
# and the prompt instructs the AI to reuse an existing server read-only.
try {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) {
    Write-Warning ("Port $Port is busy (PID=" + $conn.OwningProcess + "). Leaving it alone.")
  }
} catch {
  Write-Warning ("Port check failed: " + $_.Exception.Message)
}

$shortMsg = 'Execute the game runtime-verification task described in the attached file. Scope: only the game folder stated inside that file. End with the report format defined in the file.'
$opencodeArgs = @('run', $shortMsg, '--dir', $WorkspaceRoot, '--title', "runtime-fix $gameName")
if ($Model -ne '') { $opencodeArgs += @('--model', $Model) }
if ($Agent -ne '') { $opencodeArgs += @('--agent', $Agent) }
if ($AutoApprove) { $opencodeArgs += '--dangerously-skip-permissions' }
# Pass the prompt via --file, NOT via argv: Arabic/long text on the
# Windows command line gets encoding-mangled and crashes opencode startup.
# opencode reads the file itself as UTF8, so nothing is lost.
# NOTE: --file MUST be last. It is an array option and swallows any
# positional message text placed after it (causes "File not found").
$opencodeArgs += @('--file', $promptFile)

Write-Output "[start] game=$gameName"
Write-Output "  dir=$GameDir"
Write-Output "  url=$gameUrl"
Write-Output "  prompt=$promptFile"
Write-Output "  log=$logFile"

# One fresh isolated session per folder. This is the core anti-hallucination mechanism.
& opencode @opencodeArgs 2>&1 | Tee-Object -FilePath $logFile
$exitCode = $LASTEXITCODE
Write-Output "[exit] code=$exitCode log=$logFile"
exit $exitCode
