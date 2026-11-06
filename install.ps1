# Pip installer for Windows. Needs nothing installed beforehand. In PowerShell:
#
#   irm https://raw.githubusercontent.com/vladypiatko-crypto/pip/main/install.ps1 | iex
#
# It downloads a private copy of Node.js (only used to install Pip's parts), downloads
# Pip, installs Claude Code with Anthropic's official installer if you don't have it,
# adds Pip to the Start menu and desktop, and starts Pip. Run it again any time to update.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # makes downloads much faster
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  $Repo        = if ($env:PIP_REPO)         { $env:PIP_REPO }         else { 'vladypiatko-crypto/pip' }
  $Branch      = if ($env:PIP_BRANCH)       { $env:PIP_BRANCH }       else { 'main' }
  $Source      = if ($env:PIP_SOURCE)       { $env:PIP_SOURCE }       else { "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" }
  $NodeVersion = if ($env:PIP_NODE_VERSION) { $env:PIP_NODE_VERSION } else { '22.23.4' }
  $PipDir      = if ($env:PIP_HOME)         { $env:PIP_HOME }         else { Join-Path $env:LOCALAPPDATA 'PipPet' }

  function Say($msg) { Write-Host "[Pip] $msg" -ForegroundColor Magenta }

  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  New-Item -ItemType Directory -Force -Path $PipDir | Out-Null
  $tmp = Join-Path $PipDir 'tmp'
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null

  # 1. A private copy of Node.js, so nothing has to be installed system-wide.
  $nodeDir = Join-Path $PipDir 'node'
  $nodeExe = Join-Path $nodeDir 'node.exe'
  $haveNode = (Test-Path $nodeExe) -and ((& $nodeExe -v) -eq "v$NodeVersion")
  if (-not $haveNode) {
    Say "Downloading Node.js $NodeVersion..."
    $zip = Join-Path $tmp 'node.zip'
    Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-$arch.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath (Join-Path $tmp 'node') -Force
    if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
    Move-Item (Get-ChildItem (Join-Path $tmp 'node') -Directory | Select-Object -First 1).FullName $nodeDir
  }
  $env:Path = "$nodeDir;$env:Path"

  # 2. Pip itself. Your settings and custom skins live elsewhere, so updating keeps them.
  Say 'Downloading Pip...'
  $zip = Join-Path $tmp 'pip.zip'
  Invoke-WebRequest $Source -OutFile $zip -UseBasicParsing
  Expand-Archive $zip -DestinationPath (Join-Path $tmp 'pip') -Force
  $newApp = Join-Path $PipDir 'app.new'
  if (Test-Path $newApp) { Remove-Item -Recurse -Force $newApp }
  Move-Item (Get-ChildItem (Join-Path $tmp 'pip') -Directory | Select-Object -First 1).FullName $newApp

  Say "Installing Pip's parts (about a minute)..."
  Push-Location $newApp
  try {
    & (Join-Path $nodeDir 'npm.cmd') install --no-audit --no-fund --loglevel=error --update-notifier=false
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
  } finally { Pop-Location }

  $app = Join-Path $PipDir 'app'
  Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$app*" } | Stop-Process -Force
  if (Test-Path $app) { Remove-Item -Recurse -Force $app }
  Move-Item $newApp $app
  Remove-Item -Recurse -Force $tmp

  # 3. Claude Code: Pip's brain, using your own Claude subscription.
  $claudeExe = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
  if ((Get-Command claude -ErrorAction SilentlyContinue) -or (Test-Path $claudeExe)) {
    Say 'Claude Code is already installed.'
  } else {
    Say "Installing Claude Code (Anthropic's official installer)..."
    # Run in its own PowerShell so it can't end this script early.
    powershell -NoProfile -ExecutionPolicy Bypass -Command 'irm https://claude.ai/install.ps1 | iex'
  }

  # 4. Start menu and desktop shortcuts.
  $electron = Join-Path $app 'node_modules\electron\dist\electron.exe'
  $shell = New-Object -ComObject WScript.Shell
  $places = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))
  foreach ($dir in $places) {
    $lnk = $shell.CreateShortcut((Join-Path $dir 'Pip.lnk'))
    $lnk.TargetPath = $electron
    $lnk.Arguments = "`"$app`""
    $lnk.WorkingDirectory = $app
    $lnk.Description = 'Pip, your 3D desktop pet'
    $lnk.Save()
  }

  Say 'Pip is installed!'
  Write-Host '   - Start it any time from the Start menu or the "Pip" icon on your desktop.'
  Write-Host '   - First time? If Pip says Claude Code is not signed in, tap "Sign in to Claude" and log in with your Claude subscription.'

  if (-not $env:PIP_NO_LAUNCH) {
    Say 'Starting Pip...'
    Start-Process -FilePath $electron -ArgumentList "`"$app`"" -WorkingDirectory $app
  }
}
