param([string]$OutputDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist'))
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$metadata = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$name = 'antigravity-third-party-model-plugin-v' + $metadata.version + '-windows-x64'
$work = Join-Path ([IO.Path]::GetTempPath()) ('agy-package-' + [Guid]::NewGuid().ToString('N'))
$stage = Join-Path $work $name
$allow = @('core','ui/api.js','ui/app.js','ui/icons.js','ui/index.html','ui/style.css','patch','install','docs','examples','test','scripts','README.md','LICENSE','THIRD_PARTY_NOTICES.md','CHANGELOG.md','SECURITY.md','CONTRIBUTING.md','package.json','package-lock.json','install-oneclick.cmd','restart-bridge.cmd','uninstall-keep-config.cmd')
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
  foreach ($entry in $allow) {
    $p = Join-Path $root $entry
    $target = Join-Path $stage $entry
    if (-not (Test-Path -LiteralPath $p)) { throw ('Required release file is missing: ' + $entry) }
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $p -Destination $target -Recurse -Force
  }
  $pins = @(Get-ChildItem -LiteralPath $stage -Filter 'node-path.txt' -File -Recurse)
  foreach ($pin in $pins) { Remove-Item -LiteralPath $pin.FullName -Force }
  foreach ($file in Get-ChildItem -LiteralPath $stage -File -Recurse) {
    if ($file.Name -match '^(config\.json|\.env.*|bridge\.log|HANDOVER\.md|STATE\.md|_preview.*\.png)$' -or $file.Name -match '\.real\.json$') { throw ('Private file refused: ' + $file.Name) }
  }
  New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
  $zip = Join-Path ([IO.Path]::GetFullPath($OutputDir)) ($name + '.zip')
  if (Test-Path -LiteralPath $zip) { throw 'Release archive already exists. Choose a fresh OutputDir to avoid overwriting a published artifact.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory($work,$zip,[IO.Compression.CompressionLevel]::Optimal,$false)
  $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText((Join-Path $OutputDir 'SHA256SUMS.txt'),($hash + '  ' + [IO.Path]::GetFileName($zip) + "`n"),(New-Object Text.UTF8Encoding($false)))
  [PSCustomObject]@{ archive=$zip; sha256=$hash; bytes=(Get-Item -LiteralPath $zip).Length } | ConvertTo-Json
} finally {
  $resolvedWork = [IO.Path]::GetFullPath($work)
  if ((Split-Path -Parent $resolvedWork).TrimEnd('\') -ne ([IO.Path]::GetTempPath()).TrimEnd('\') -or (Split-Path -Leaf $resolvedWork) -notmatch '^agy-package-[a-f0-9]{32}$') { throw 'Refusing cleanup outside the packaging temporary directory.' }
  if (Test-Path -LiteralPath $resolvedWork) { Remove-Item -LiteralPath $resolvedWork -Recurse -Force }
}
