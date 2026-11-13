# Restart only this project's loopback bridge, leaving Antigravity running.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $root 'core\index.js'
$launcher = Join-Path $PSScriptRoot 'start-bridge.vbs'
if (-not (Test-Path -LiteralPath $entry) -or -not (Test-Path -LiteralPath $launcher)) { throw 'Bridge files not found.' }
$listeners = @(Get-NetTCPConnection -LocalPort 18925 -State Listen -ErrorAction SilentlyContinue)
$bridgeProcessIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
foreach ($bridgeProcessId in $bridgeProcessIds) {
    $candidate = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $bridgeProcessId)
    if ($candidate.Name -ne 'node.exe' -or $candidate.CommandLine -notmatch ([regex]::Escape($entry) + '(?:"|\s|$)')) { throw 'Port 18925 belongs to another program; nothing was stopped.' }
}
foreach ($bridgeProcessId in $bridgeProcessIds) { Stop-Process -Id $bridgeProcessId -ErrorAction Stop }
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $launcher + '"') -WindowStyle Hidden
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 200
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:18925/api/health' -TimeoutSec 1
        if ($health.ok) { Write-Host ('Bridge started: v' + $health.version); exit 0 }
    } catch { }
}
throw 'Bridge did not become ready. Check the local bridge logs.'
