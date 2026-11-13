# agy-bridge installer -- route Antigravity through a third-party API
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-Port 18925] [-NoGlobalEnv]
param(
  [int]$Port = 18925,
  [switch]$NoGlobalEnv,
  [switch]$SkipStart
)
$ErrorActionPreference = 'Stop'
$Root    = Split-Path -Parent $PSScriptRoot
$CoreDir = Join-Path $Root 'core'
$Entry   = Join-Path $CoreDir 'index.js'
$CfgDir  = Join-Path $env:LOCALAPPDATA 'agy-bridge'
$LogDir  = Join-Path $CfgDir 'logs'
$BridgeUrl = "http://127.0.0.1:$Port"

function Say($m, $c='Gray'){ Write-Host $m -ForegroundColor $c }

Say "" ; Say "=== agy-bridge install ===" 'Cyan' ; Say ""

if (-not (Test-Path $Entry)) { throw "bridge core not found: $Entry" }
# Prefer a real node.exe: .cmd shims (harness/volta/nvm wrappers) do not survive
# a detached `cmd /c` launch and will silently do nothing.
$node = (Get-Command node -CommandType Application -All -ErrorAction SilentlyContinue |
         Where-Object { $_.Source -like '*.exe' } | Select-Object -First 1)
if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue) }
if (-not $node) { throw "node not found; install Node.js 24.5+ first" }
Say ("node : " + $node.Source)
Say ("core : " + $CoreDir)
# Persist the resolved node path: this box may expose node as a .cmd shim
# (e.g. a harness-provided node), which the VBS launcher cannot exec directly.
$nodePathFile = Join-Path $PSScriptRoot 'node-path.txt'
Set-Content -Path $nodePathFile -Value $node.Source -Encoding Unicode -NoNewline
Say ("node pinned : " + $nodePathFile) 'DarkGray'

New-Item -ItemType Directory -Force -Path $CfgDir, $LogDir | Out-Null
Say ("config : " + (Join-Path $CfgDir 'config.json')) 'DarkGray'

# 1) user-level env var so every launch path works
if (-not $NoGlobalEnv) {
  [Environment]::SetEnvironmentVariable('CLOUD_CODE_URL', $BridgeUrl, 'User')
  $env:CLOUD_CODE_URL = $BridgeUrl
  # broadcast WM_SETTINGCHANGE so explorer.exe refreshes its env block immediately;
  # without this a Start-Menu launch keeps the stale environment until reboot.
  try {
    $sig = @'
using System;
using System.Runtime.InteropServices;
public class EnvBroadcast {
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
  public static void Notify() {
    UIntPtr r;
    SendMessageTimeout(new IntPtr(0xffff), 0x001A, UIntPtr.Zero, "Environment", 2, 3000, out r);
  }
}
'@
    if (-not ([System.Management.Automation.PSTypeName]'EnvBroadcast').Type) { Add-Type -TypeDefinition $sig -ErrorAction Stop }
    [EnvBroadcast]::Notify()
    Say "      WM_SETTINGCHANGE broadcast ok (explorer env refreshed)" 'DarkGray'
  } catch { Say ("      broadcast skipped: " + $_) 'DarkGray' }
  Say "" ; Say "[1/4] user env CLOUD_CODE_URL = $BridgeUrl" 'Green'
} else {
  Say "" ; Say "[1/4] skipped global env var (launcher mode)" 'Yellow'
}

# 2) autostart via hidden shortcut in Startup folder
$startup = [Environment]::GetFolderPath('Startup')
$vbs = Join-Path $PSScriptRoot 'start-bridge.vbs'
$lnkPath = Join-Path $startup 'agy-bridge.lnk'
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnkPath)
$sc.TargetPath = 'wscript.exe'
$sc.Arguments = '"' + $vbs + '"'
$sc.WorkingDirectory = $Root
$sc.WindowStyle = 7
$sc.Description = 'agy-bridge local protocol bridge'
$sc.Save()
Say "[2/4] autostart registered: $lnkPath" 'Green'

# 3) desktop shortcut to the config page
$desktop = [Environment]::GetFolderPath('Desktop')
$urlFile = Join-Path $desktop 'Antigravity API Settings.url'
$lines = @('[InternetShortcut]', "URL=$BridgeUrl/", 'IconIndex=0')
Set-Content -Path $urlFile -Value $lines -Encoding ASCII
Say "[3/4] desktop entry: $urlFile" 'Green'

# 4) start the bridge now
if (-not $SkipStart) {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($conn) {
    Say "[4/4] port $Port already listening, skip start" 'Yellow'
  } else {
    Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"') -WindowStyle Hidden
    $ok = $false
    for ($i=0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 250
      try { $r = Invoke-RestMethod -Uri "$BridgeUrl/api/health" -TimeoutSec 2; if ($r.ok) { $ok = $true; break } } catch {}
    }
    if ($ok) { Say "[4/4] bridge up: $BridgeUrl" 'Green' }
    else { Say "[4/4] bridge start timeout, see $LogDir\bridge.log" 'Red' }
  }
}

Say "" ; Say "--- next ---" 'Cyan' ; Say ""
Say "  1. open $BridgeUrl/ and add your third-party API (base_url + key + models)"
Say "  2. wire Antigravity to the bridge (REQUIRED - the env var alone does not"
Say "     reach apps launched from the Start Menu):"
Say ("       node `"" + (Join-Path $Root 'patch\apply.mjs') + "`"") 'White'
Say "  3. fully quit Antigravity from the tray, then relaunch"
Say "  4. your models appear in the model picker"
Say "" ; Say "  uninstall: powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\uninstall.ps1`"" ; Say ""
