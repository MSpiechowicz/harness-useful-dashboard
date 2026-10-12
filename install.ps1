# Harness Dashboard installer for Windows.
#
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/MSpiechowicz/harness-useful-dashboard/main/install.ps1 | iex"
#
# Runs the release's NSIS installer silently: a per-user install in %LOCALAPPDATA%\Harness Dashboard with a Start menu
# shortcut and an entry under Settings > Apps, the same install the in-app updater updates. It then puts the
# harness-dashboard command in %LOCALAPPDATA%\Programs\harness-dashboard and on your PATH. The app keeps that copy in
# step with itself, so the location is fixed.
#
# Environment overrides:
#   HARNESS_DASHBOARD_VERSION  release tag to install (default: latest), e.g. v1.26.0
$ErrorActionPreference = "Stop"

$Repo = "MSpiechowicz/harness-useful-dashboard"
$Bin = "harness-dashboard"
$AppName = "Harness Dashboard"
$CliAsset = "$Bin-cli-x86_64-pc-windows-msvc.exe"
$Version = if ($env:HARNESS_DASHBOARD_VERSION) { $env:HARNESS_DASHBOARD_VERSION } else { "latest" }
$CliDir = Join-Path $env:LOCALAPPDATA "Programs\$Bin"

if (-not [Environment]::Is64BitOperatingSystem) { throw "$AppName requires 64-bit Windows." }
$Base = if ($Version -eq "latest") { "https://github.com/$Repo/releases/latest/download" } else { "https://github.com/$Repo/releases/download/$Version" }

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  # The release's updater manifest carries each bundle's download URL.
  try {
    $Manifest = Invoke-RestMethod -UseBasicParsing -Uri "$Base/latest.json"
  } catch {
    throw "No app release found at $Base (releases before the desktop app have none)."
  }
  $Url = $Manifest.platforms.'windows-x86_64-nsis'.url
  if (-not $Url) { throw "This release has no Windows installer." }
  # Dot segments (also percent-encoded) would walk out of the releases prefix.
  if ($Url -match '\.\.|%2e' -or -not $Url.StartsWith("https://github.com/$Repo/releases/download/", [StringComparison]::Ordinal)) {
    throw "Unexpected download URL in latest.json: $Url"
  }
  $Asset = [IO.Path]::GetFileName(([Uri]$Url).AbsolutePath)
  $Setup = Join-Path $Tmp $Asset
  $Cli = Join-Path $Tmp $CliAsset

  Write-Host "==> Downloading $Asset ($($Manifest.version))" -ForegroundColor Cyan
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Setup
  Write-Host "==> Downloading $CliAsset" -ForegroundColor Cyan
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/$CliAsset" -OutFile $Cli

  # Nothing is installed without a checksum to compare against.
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/checksums.txt" -OutFile (Join-Path $Tmp "checksums.txt")
  } catch {
    throw "This release has no checksums.txt, so $Asset can't be verified. Nothing was installed."
  }
  foreach ($File in @($Setup, $Cli)) {
    $Name = Split-Path -Leaf $File
    $line = Get-Content (Join-Path $Tmp "checksums.txt") | Where-Object { $_ -match "\s$([regex]::Escape($Name))$" } | Select-Object -First 1
    if (-not $line) { throw "checksums.txt has no entry for $Name" }
    $expected = ($line -split "\s+")[0].ToLower()
    $actual = (Get-FileHash -Algorithm SHA256 $File).Hash.ToLower()
    if ($expected -ne $actual) { throw "Checksum mismatch for $Name" }
  }
  Write-Host "==> Checksum verified" -ForegroundColor Cyan

  # Stop the app and the dashboard server in this session, so the new app can take its port. The server is the command
  # line tool run bare or as "serve ...", which is also how releases before the desktop app ran it. The pattern is
  # anchored on the program itself. Never "harness-dashboard mcp" or other subcommands: agents keep those running and
  # read usage through them. A running app's own server is stopped too (the app then quits), which is intended before an
  # upgrade.
  $Exe = [regex]::Escape($Bin) + '(?:\.exe)?'
  $ServerLine = '^(?:"(?:[^"]*[\\/])?' + $Exe + '"|(?:[^\s"]*[\\/])?' + $Exe + ')(?:\s+serve(?:\s.*)?)?\s*$'
  $Session = (Get-Process -Id $PID).SessionId
  Get-CimInstance Win32_Process -Filter "Name = '$Bin.exe' OR Name = '$Bin-app.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.SessionId -eq $Session -and ($_.Name -eq "$Bin-app.exe" -or $_.CommandLine -match $ServerLine) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  # Releases before the desktop app made a shortcut that started the command line tool, and its icon. The installer
  # makes the real shortcut.
  $StartMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $StartMenu "$AppName.lnk")
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $CliDir "$Bin.ico")

  Write-Host "==> Installing" -ForegroundColor Cyan
  $Process = Start-Process -FilePath $Setup -ArgumentList "/S" -Wait -PassThru
  if ($Process.ExitCode -ne 0) { throw "The installer exited with code $($Process.ExitCode)." }

  # The command line tool is a plain binary of the same release. The installer does not touch PATH. An agent may be
  # running it (mcp) and Windows won't overwrite a running exe, but it can rename one: the old file moves aside first,
  # like the app does when it updates the command. The app is installed by now, so a failure here only warns.
  $Target = Join-Path $CliDir "$Bin.exe"
  $CliInstalled = $false
  $Aside = $null
  try {
    New-Item -ItemType Directory -Force -Path $CliDir | Out-Null

    # Leftovers of earlier upgrades. One still locked by a running older mcp stays.
    Get-ChildItem -Path $CliDir -Filter "$Bin.exe.old*" -ErrorAction SilentlyContinue |
      Remove-Item -Force -ErrorAction SilentlyContinue

    if (Test-Path -LiteralPath $Target) {
      $Aside = "$Target.old"
      $N = 1
      while (Test-Path -LiteralPath $Aside) {
        $Aside = "$Target.old.$N"
        $N++
      }
      Move-Item -Force -LiteralPath $Target -Destination $Aside
    }
    Move-Item -Force $Cli $Target
    $CliInstalled = $true
    Write-Host "==> Installed $Bin to $Target" -ForegroundColor Cyan

    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (($UserPath -split ";") -notcontains $CliDir) {
      $NewPath = if ($UserPath) { "$UserPath;$CliDir" } else { $CliDir }
      [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
      Write-Host "==> Added $CliDir to your PATH (open a new terminal to use it)" -ForegroundColor Cyan
    }
  } catch {
    Write-Warning "Couldn't set up the $Bin command: $($_.Exception.Message). The app is installed and works without it."
    # Put the previous command back if it was moved aside and nothing replaced it.
    if ($Aside -and -not (Test-Path $Target) -and (Test-Path $Aside)) {
      Move-Item -Force $Aside $Target -ErrorAction SilentlyContinue
    }
  }

  Write-Host ""
  Write-Host "Installed $AppName $($Manifest.version). Open it from the Start menu. The app updates itself."
  if ($CliInstalled) {
    Write-Host "The '$Bin' command is installed too, try '$Bin today' in a new terminal."
  }
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
