$Port = 18925
$BridgeUrl = "http://127.0.0.1:$Port"
function Say($m,$c='Gray'){ Write-Host $m -ForegroundColor $c }
Say "" ; Say "=== agy-bridge status ===" 'Cyan' ; Say ""
Say ("CLOUD_CODE_URL (User) : " + [Environment]::GetEnvironmentVariable('CLOUD_CODE_URL','User'))
Say ("CLOUD_CODE_URL (proc) : " + $env:CLOUD_CODE_URL)
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  Say ("listening             : yes  PID " + (($conn.OwningProcess | Select-Object -Unique) -join ',')) 'Green'
  try {
    $h = Invoke-RestMethod -Uri "$BridgeUrl/api/health" -TimeoutSec 3
    $s = Invoke-RestMethod -Uri "$BridgeUrl/api/state"  -TimeoutSec 3
    Say ("health                : ok  v" + $h.version)
    Say ("providers             : " + (($s.providers | ForEach-Object { $_.name }) -join ', '))
    Say ("active                : " + $s.active_provider_id + " / " + $s.default_model)
    Say ("requests handled      : " + $s.request_count)
    if ($s.control_plane) {
      Say ("control plane         : " + $s.control_plane.mode)
      Say ("Google proxy enabled  : " + $s.control_plane.uses_proxy)
      Say ("catalogue             : Google " + $s.control_plane.official_models + " / custom " + $s.control_plane.custom_models)
    }
  } catch { Say ("health check failed: " + $_) 'Red' }
} else {
  Say "listening             : no (bridge not running)" 'Red'
}
Say ("config dir            : " + (Join-Path $env:LOCALAPPDATA 'agy-bridge'))
Say ""
