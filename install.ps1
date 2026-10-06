# Harness Dashboard installer for Windows.
#
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/MSpiechowicz/harness-useful-dashboard/main/install.ps1 | iex"
#
# Environment overrides:
#   HARNESS_DASHBOARD_VERSION      release tag to install (default: latest), e.g. v0.2.0
#   HARNESS_DASHBOARD_INSTALL_DIR  install directory (default: %LOCALAPPDATA%\Programs\harness-dashboard)
$ErrorActionPreference = "Stop"

$Repo = "MSpiechowicz/harness-useful-dashboard"
$Bin = "harness-dashboard"
$AppName = "Harness Dashboard"
$Version = if ($env:HARNESS_DASHBOARD_VERSION) { $env:HARNESS_DASHBOARD_VERSION } else { "latest" }
$InstallDir = if ($env:HARNESS_DASHBOARD_INSTALL_DIR) { $env:HARNESS_DASHBOARD_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\$Bin" }

if (-not [Environment]::Is64BitOperatingSystem) { throw "Harness Dashboard requires 64-bit Windows." }
$Asset = "$Bin-windows-x64.exe"
$Base = if ($Version -eq "latest") { "https://github.com/$Repo/releases/latest/download" } else { "https://github.com/$Repo/releases/download/$Version" }

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  Write-Host "==> Downloading $Asset ($Version)" -ForegroundColor Cyan
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Asset" -OutFile (Join-Path $Tmp $Asset)

  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/checksums.txt" -OutFile (Join-Path $Tmp "checksums.txt")
    $line = Get-Content (Join-Path $Tmp "checksums.txt") | Where-Object { $_ -match "\s$([regex]::Escape($Asset))$" } | Select-Object -First 1
    if (-not $line) { throw "checksums.txt has no entry for $Asset" }
    $expected = ($line -split "\s+")[0].ToLower()
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $Tmp $Asset)).Hash.ToLower()
    if ($expected -ne $actual) { throw "Checksum mismatch for $Asset" }
    Write-Host "==> Checksum verified" -ForegroundColor Cyan
  } catch [System.Net.WebException] {
    Write-Warning "No checksums.txt in this release; skipping verification."
  }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $Target = Join-Path $InstallDir "$Bin.exe"
  # Stop a running instance so the file can be replaced.
  Get-Process -Name $Bin -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Move-Item -Force (Join-Path $Tmp $Asset) $Target
  Write-Host "==> Installed to $Target" -ForegroundColor Cyan

  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($UserPath -split ";") -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    Write-Host "==> Added $InstallDir to your PATH (open a new terminal to use it)" -ForegroundColor Cyan
  }

  # The app's logo for the shortcut, published with each release (releases before 1.3.1 don't have it).
  $Icon = Join-Path $InstallDir "$Bin.ico"
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Bin.ico" -OutFile $Icon
  } catch {
    $Icon = $null
    Write-Warning "No app icon in this release; the shortcut uses a generic one."
  }

  $StartMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
  $Shell = New-Object -ComObject WScript.Shell
  $Link = $Shell.CreateShortcut((Join-Path $StartMenu "$AppName.lnk"))
  $Link.TargetPath = $Target
  $Link.Arguments = "serve"
  $Link.WorkingDirectory = $InstallDir
  $Link.WindowStyle = 7  # minimized console
  $Link.Description = "Token usage across your AI coding tools"
  if ($Icon) { $Link.IconLocation = "$Icon,0" }
  $Link.Save()
  Write-Host "==> Added `"$AppName`" to the Start menu" -ForegroundColor Cyan

  Write-Host ""
  Write-Host "Run '$Bin' (or use the Start menu) to open the dashboard. Update later with '$Bin update'."
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
