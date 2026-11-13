# Windows x64 installer. Downloads are pinned and checked before extraction.
# No elevation, remote script evaluation, application termination or key import.
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\agy-bridge'),
  [string]$AsarPath = (Join-Path $env:LOCALAPPDATA 'Programs\antigravity\resources\app.asar'),
  [switch]$DryRun,
  [switch]$NoIntegrations,
  [switch]$SkipStart,
  [string]$NodePath
)
$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot
$destination = [IO.Path]::GetFullPath($InstallDir)
$archive = [IO.Path]::GetFullPath($AsarPath)
$nodeVersion = '24.15.0'
$nodeHash = 'CC5149EABD53779CE1E7BDC5401643622D0C7E6800ADE18928A767E940BB0E62'
$nodeArchive = "node-v$nodeVersion-win-x64.zip"
$nodeUrl = "https://nodejs.org/dist/v$nodeVersion/$nodeArchive"
$roots = @('core','ui','patch','install','docs','examples','README.md','LICENSE','THIRD_PARTY_NOTICES.md','CHANGELOG.md','package.json','package-lock.json','install-oneclick.cmd','restart-bridge.cmd','uninstall-keep-config.cmd')
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'This release targets Windows x64.' }
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw "Antigravity app.asar not found: $archive. See -AsarPath in docs/QUICKSTART.md." }
if ($destination -eq [IO.Path]::GetPathRoot($destination)) { throw 'InstallDir must not be a drive root.' }
if ($DryRun) {
  [PSCustomObject]@{ dryRun=$true; source=$source; destination=$destination; asar=$archive; nodeVersion=$nodeVersion; downloadSha256=$nodeHash; integrates=(-not $NoIntegrations); starts=(-not $SkipStart) } | ConvertTo-Json
  exit 0
}

function Test-Node([string]$candidate) {
  if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf) -or [IO.Path]::GetExtension($candidate) -ne '.exe') { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $candidate) 'node_modules\npm\bin\npx-cli.js'))) { return $false }
  try { $v = (& $candidate --version).TrimStart('v'); return ($LASTEXITCODE -eq 0 -and [version]$v -ge [version]'24.5.0') } catch { return $false }
}
function Resolve-Node {
  if ($NodePath) { if (Test-Node $NodePath) { return [IO.Path]::GetFullPath($NodePath) }; throw '-NodePath must point to Node.js 24.5+ with npm installed.' }
  $localNode = Join-Path $destination "runtime\node-v$nodeVersion-win-x64\node.exe"
  if (Test-Node $localNode) { return $localNode }
  foreach ($candidate in @(Get-Command node -CommandType Application -All -ErrorAction SilentlyContinue)) { if (Test-Node $candidate.Source) { return $candidate.Source } }
  $work = Join-Path ([IO.Path]::GetTempPath()) ('agy-node-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $zip = Join-Path $work $nodeArchive
    Write-Host "Downloading Node.js $nodeVersion from nodejs.org ..."
    Invoke-WebRequest -Uri $nodeUrl -OutFile $zip -UseBasicParsing -TimeoutSec 180
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $nodeHash) { throw 'Node archive SHA256 mismatch; extraction refused.' }
    $runtime = Join-Path $destination 'runtime'
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    Expand-Archive -LiteralPath $zip -DestinationPath $runtime -Force
    if (-not (Test-Node $localNode)) { throw 'Downloaded Node runtime failed validation.' }
    return $localNode
  } finally {
    $resolvedWork = [IO.Path]::GetFullPath($work)
    if ((Split-Path -Parent $resolvedWork).TrimEnd('\') -ne ([IO.Path]::GetTempPath()).TrimEnd('\') -or (Split-Path -Leaf $resolvedWork) -notmatch '^agy-node-[a-f0-9]{32}$') { throw 'Refusing cleanup outside the installer temporary directory.' }
    if (Test-Path -LiteralPath $resolvedWork) { Remove-Item -LiteralPath $resolvedWork -Recurse -Force }
  }
}

Write-Host 'Antigravity Third-Party Model Plugin - install' -ForegroundColor Cyan
Write-Host "Install: $destination"
New-Item -ItemType Directory -Path $destination -Force | Out-Null
if ($destination.TrimEnd('\') -ne $source.TrimEnd('\')) {
  foreach ($name in $roots) {
    $from = Join-Path $source $name
    if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $destination -Recurse -Force }
  }
}
$node = Resolve-Node
$env:PATH = (Split-Path -Parent $node) + ';' + $env:PATH
Write-Host "Node: $node"
Set-Content -LiteralPath (Join-Path $destination 'install\node-path.txt') -Value $node -Encoding Unicode -NoNewline
& $node (Join-Path $destination 'patch\apply.mjs') --asar $archive
if ($LASTEXITCODE -ne 0) { throw 'Application patch failed. The installer has stopped.' }
if (-not $NoIntegrations) {
  & (Join-Path $destination 'install\install.ps1') -NoGlobalEnv -SkipStart
}
if (-not $SkipStart) {
  $health = $null
  try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:18925/api/health' -TimeoutSec 2 } catch { }
  if ($health.ok) {
    Write-Host ('An existing bridge is running: v' + $health.version + '. It was not terminated. See docs/QUICKSTART.md for upgrades.') -ForegroundColor Yellow
  } else {
    Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + (Join-Path $destination 'install\start-bridge.vbs') + '"') -WindowStyle Hidden
    $ready = $false
    for ($i=0; $i -lt 32; $i++) {
      Start-Sleep -Milliseconds 250
      try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:18925/api/health' -TimeoutSec 1; if ($r.ok) { $ready = $true; break } } catch { }
    }
    if (-not $ready) { throw 'Bridge did not become ready. Review the local log before retrying.' }
  }
}
Write-Host 'Installed. For first application integration, fully exit Antigravity from its tray and reopen it once.' -ForegroundColor Green
Write-Host 'Then open Settings > Model providers. Daily model changes do not need an application restart.'
