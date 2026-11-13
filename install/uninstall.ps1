# agy-bridge uninstaller -- full rollback
param(
  [switch]$KeepConfig,
  [switch]$DeleteConfig,
  [string]$AsarPath = (Join-Path $env:LOCALAPPDATA 'Programs\antigravity\resources\app.asar')
)
$ErrorActionPreference = 'Stop'
if ($KeepConfig -and $DeleteConfig) { throw 'Choose either KeepConfig or DeleteConfig.' }
$KeepConfig = -not $DeleteConfig
$project = Split-Path -Parent $PSScriptRoot
$expectedEntry = Join-Path $project 'core\index.js'
$listeners = @(Get-NetTCPConnection -LocalPort 18925 -State Listen -ErrorAction SilentlyContinue)
foreach ($bridgeProcessId in @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
  $candidate = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $bridgeProcessId)
  if ($candidate.Name -ne 'node.exe' -or $candidate.CommandLine -notmatch ([regex]::Escape($expectedEntry) + '(?:"|\s|$)')) { throw 'Port 18925 belongs to another program or installation. No process was stopped.' }
}
$pin = Join-Path $PSScriptRoot 'node-path.txt'
$nodeExe = if (Test-Path -LiteralPath $pin) { (Get-Content -LiteralPath $pin -Raw).Trim() } else { (Get-Command node -ErrorAction Stop).Source }
if (Test-Path -LiteralPath ($AsarPath + '.agybridge.bak')) {
  & $nodeExe (Join-Path $project 'patch\restore.mjs') --asar $AsarPath
  if ($LASTEXITCODE -ne 0) { throw 'Archive restoration failed; bridge was kept running.' }
}
$CfgDir = Join-Path $env:LOCALAPPDATA 'agy-bridge'
function Say($m,$c='Gray'){ Write-Host $m -ForegroundColor $c }
Say "" ; Say "=== agy-bridge uninstall ===" 'Cyan' ; Say ""

$pids = @()
try { $pids = (Get-NetTCPConnection -LocalPort 18925 -State Listen -ErrorAction SilentlyContinue).OwningProcess } catch {}
if ($pids) {
  foreach ($p in ($pids | Select-Object -Unique)) {
    try { Stop-Process -Id $p -Force -ErrorAction Stop; Say "[1/5] stopped bridge PID $p" 'Green' }
    catch { Say "[1/5] failed to stop PID $p : $_" 'Red' }
  }
} else { Say "[1/5] no running bridge" 'Yellow' }

[Environment]::SetEnvironmentVariable('CLOUD_CODE_URL', $null, 'User')
Remove-Item Env:\CLOUD_CODE_URL -ErrorAction SilentlyContinue
Say "[2/5] removed user env CLOUD_CODE_URL" 'Green'

$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'agy-bridge.lnk'
if (Test-Path $lnk) { Remove-Item $lnk -Force; Say "[3/5] autostart removed" 'Green' } else { Say "[3/5] no autostart entry" 'Yellow' }

$url = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Antigravity API Settings.url'
if (Test-Path $url) { Remove-Item $url -Force; Say "[4/5] desktop entry removed" 'Green' } else { Say "[4/5] no desktop entry" 'Yellow' }

if ($KeepConfig) { Say "[5/5] config kept at $CfgDir" 'Yellow' }
elseif (Test-Path $CfgDir) {
  $resolved = [IO.Path]::GetFullPath($CfgDir)
  if ($resolved -ne [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'agy-bridge'))) { throw 'Unexpected config path; deletion refused.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force; Say "[5/5] config dir removed" 'Green'
}
else { Say "[5/5] no config dir" 'Yellow' }

Say "" ; Say "done. Reopen Antigravity normally to load the restored archive." 'Cyan' ; Say ""
