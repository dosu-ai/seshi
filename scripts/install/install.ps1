<#
.SYNOPSIS
Installs the seshi binary on Windows (F8.4).

.DESCRIPTION
Downloads the release archive for this machine (seshi-windows-x64.zip or
seshi-windows-arm64.zip), checks it against the release's SHA256SUMS, puts seshi.exe in
%LOCALAPPDATA%\Programs\seshi and adds that folder to your user PATH.

  irm https://github.com/dosu-ai/sessiondb/releases/latest/download/install.ps1 | iex

With options:

  & ([scriptblock]::Create((irm https://github.com/dosu-ai/sessiondb/releases/latest/download/install.ps1))) -Version 1.2.3

Settings are parameters rather than SESHI_* variables on purpose: seshi refuses SESHI_* names
it does not know, so an installer variable left in the environment would break every seshi
command. On macOS and Linux, use install.sh.

.PARAMETER Version
A release, such as 1.2.3 (the latest by default).

.PARAMETER InstallDir
Where to put seshi.exe (%LOCALAPPDATA%\Programs\seshi by default).

.PARAMETER NoModifyPath
Leave the user PATH alone.

.PARAMETER BaseUrl
Where releases are (a mirror); https://github.com/dosu-ai/sessiondb/releases by default.
#>
[CmdletBinding()]
param(
  [string]$Version = "",
  [string]$InstallDir = "",
  [switch]$NoModifyPath,
  [string]$BaseUrl = "https://github.com/dosu-ai/sessiondb/releases"
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
# Invoke-WebRequest's progress bar makes downloads many times slower in Windows PowerShell.
$ProgressPreference = 'SilentlyContinue'

$Repository = 'dosu-ai/sessiondb'
$Checksums = 'SHA256SUMS'

function Install-Seshi {
  param([string]$Version, [string]$InstallDir, [bool]$NoModifyPath, [string]$BaseUrl)

  if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
    throw "seshi install: this script is for Windows; on macOS and Linux, use install.sh"
  }
  # Windows PowerShell 5.1 may not offer TLS 1.2 by default; GitHub requires it.
  if ($PSVersionTable.PSEdition -ne 'Core') {
    [Net.ServicePointManager]::SecurityProtocol =
      [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  }

  $Version = $Version -replace '^v', ''
  if ($Version -and $Version -notmatch '^[0-9A-Za-z.+-]+$') {
    throw "seshi install: not a version: $Version"
  }
  $BaseUrl = $BaseUrl.TrimEnd('/')

  # The 64-bit architecture, also from a 32-bit PowerShell.
  $machine = $env:PROCESSOR_ARCHITEW6432
  if (-not $machine) { $machine = $env:PROCESSOR_ARCHITECTURE }
  switch ($machine) {
    'AMD64' { $cpu = 'x64' }
    'ARM64' { $cpu = 'arm64' }
    default { throw "seshi install: seshi has no binary for Windows on $machine" }
  }
  $asset = "seshi-windows-$cpu.zip"
  if ($Version) { $url = "$BaseUrl/download/v$Version" } else { $url = "$BaseUrl/latest/download" }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("seshi-install-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp $asset
    $sums = Join-Path $tmp $Checksums
    if ($Version) { Write-Host "Downloading $asset (v$Version)" } else { Write-Host "Downloading $asset" }
    Invoke-WebRequest -Uri "$url/$asset" -OutFile $zip -UseBasicParsing
    Invoke-WebRequest -Uri "$url/$Checksums" -OutFile $sums -UseBasicParsing

    $expected = $null
    foreach ($line in Get-Content -Path $sums) {
      if ($line -match '^([0-9a-fA-F]{64}) [ *](.+)$' -and $Matches[2] -eq $asset) {
        $expected = $Matches[1].ToLowerInvariant()
        break
      }
    }
    if (-not $expected) { throw "seshi install: $Checksums has no line for $asset" }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      throw "seshi install: checksum mismatch for $asset (expected $expected, got $actual); nothing was installed"
    }

    $unpacked = Join-Path $tmp 'unpacked'
    Expand-Archive -Path $zip -DestinationPath $unpacked -Force
    $exe = Join-Path $unpacked 'seshi.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
      throw "seshi install: $asset holds no seshi.exe"
    }

    if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\seshi' }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $target = Join-Path $InstallDir 'seshi.exe'
    $old = "$target.old"
    Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $target) {
      # A running seshi.exe cannot be overwritten, but it can be renamed out of the way.
      Move-Item -LiteralPath $target -Destination $old -Force
    }
    Copy-Item -LiteralPath $exe -Destination $target -Force
    Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue

    $installed = & $target --version
    if ($LASTEXITCODE -ne 0) { throw "seshi install: $target was installed but does not run" }
    Write-Host "Installed $installed to $target"

    Add-ToPath -Dir $InstallDir -NoModifyPath $NoModifyPath
  }
  finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Test-InPath([string]$PathValue, [string]$Dir) {
  $want = $Dir.TrimEnd('\')
  foreach ($entry in ($PathValue -split ';')) {
    if (-not $entry) { continue }
    $expanded = [Environment]::ExpandEnvironmentVariables($entry).TrimEnd('\')
    if ($expanded -ieq $want) { return $true }
  }
  return $false
}

function Add-ToPath {
  param([string]$Dir, [bool]$NoModifyPath)

  # This session first, so seshi works at once.
  if (-not (Test-InPath $env:Path $Dir)) { $env:Path = "$Dir;$env:Path" }

  # The user PATH lives in the registry as an expandable string (%USERPROFILE%\…);
  # [Environment]::SetEnvironmentVariable would flatten it, so the registry is edited directly.
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try {
    $current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if (Test-InPath $current $Dir) { return }
    if ($NoModifyPath) {
      Write-Host "$Dir is not on your PATH; add it to run seshi by name."
      return
    }
    $parts = @($current -split ';' | Where-Object { $_ })
    $updated = (@($Dir) + $parts) -join ';'
    $key.SetValue('Path', $updated, [Microsoft.Win32.RegistryValueKind]::ExpandString)
  }
  finally {
    $key.Close()
  }
  # Setting any user variable broadcasts WM_SETTINGCHANGE, so new terminals see the new PATH.
  [Environment]::SetEnvironmentVariable('SeshiInstallerRefresh', '1', 'User')
  [Environment]::SetEnvironmentVariable('SeshiInstallerRefresh', $null, 'User')
  Write-Host "Added $Dir to your user PATH. Open a new terminal to use seshi there."
}

Install-Seshi -Version $Version -InstallDir $InstallDir -NoModifyPath $NoModifyPath.IsPresent -BaseUrl $BaseUrl
