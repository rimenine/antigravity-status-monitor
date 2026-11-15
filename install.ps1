[CmdletBinding()]
param(
  [string]$PluginsRoot = (Join-Path $env:USERPROFILE '.gemini\config\plugins')
)

$ErrorActionPreference = 'Stop'
$PluginId = 'agent-status-monitor'
$SourceDir = [IO.Path]::GetFullPath($PSScriptRoot)
$ConfigRoot = Split-Path -Parent $PluginsRoot
$DestDir = [IO.Path]::GetFullPath((Join-Path $PluginsRoot $PluginId))

Write-Host '=== Antigravity Status Monitor Installer ===' -ForegroundColor Cyan

if (Test-Path $ConfigRoot) {
  Write-Host "[OK] Detected Antigravity config directory: $ConfigRoot" -ForegroundColor Green
} else {
  Write-Host "[WARN] Config directory not found yet; creating: $PluginsRoot" -ForegroundColor Yellow
}
New-Item -ItemType Directory -Force -Path $PluginsRoot | Out-Null

$NodeBin = $null
foreach ($candidate in @('agy-node', 'node')) {
  $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
  if ($cmd) {
    $NodeBin = $cmd.Source
    break
  }
}
if (-not $NodeBin -and $env:APPDATA) {
  $agyDefault = Join-Path $env:APPDATA 'Antigravity\bin\agy-node.cmd'
  if (Test-Path $agyDefault) {
    $NodeBin = $agyDefault
  }
}

if ($NodeBin) {
  $nodeVer = (& $NodeBin -v 2>$null)
  Write-Host "[OK] Detected runtime: $NodeBin ($nodeVer)" -ForegroundColor Green
} else {
  Write-Host '[WARN] Neither agy-node nor node was found. Antigravity may still provide agy-node at runtime.' -ForegroundColor Yellow
}

function Test-VerifiedSidecarProcess {
  param($ProcInfo, $ServerMeta)
  if (-not $ProcInfo) { return $false }
  $cmd = [string]$ProcInfo.CommandLine
  if ($cmd -match '(?i)status-monitor.*server\.mjs') { return $true }
  if ($cmd -notmatch '(?i)(^|[\s"''])server\.mjs($|[\s"''])') { return $false }
  if ($ServerMeta.port -and ($ServerMeta.port -as [int]) -gt 0) {
    try {
      if (Get-NetTCPConnection -OwningProcess ([int]$ProcInfo.ProcessId) -LocalPort ([int]$ServerMeta.port) -State Listen -ErrorAction SilentlyContinue) {
        return $true
      }
    } catch {
    }
  }
  if ($ServerMeta.startedAt -and ($ServerMeta.startedAt -as [int64]) -gt 0 -and $ProcInfo.CreationDate) {
    try {
      $procMs = ([DateTimeOffset]$ProcInfo.CreationDate).ToUnixTimeMilliseconds()
      if ([Math]::Abs($procMs - [int64]$ServerMeta.startedAt) -le 15000) {
        return $true
      }
    } catch {
    }
  }
  return $false
}

function Stop-VerifiedSidecar {
  param([string]$ServerJsonPath)
  if (-not (Test-Path $ServerJsonPath)) { return }
  try {
    $srv = [IO.File]::ReadAllText($ServerJsonPath, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
    if (-not $srv.pid -or ($srv.pid -as [int]) -le 0) { return }
    $targetPid = [int]$srv.pid
    $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" -ErrorAction SilentlyContinue
    if (-not (Test-VerifiedSidecarProcess -ProcInfo $procInfo -ServerMeta $srv)) { return }

    # Wait for Antigravity's cmd.exe wrapper too so sidecars\status-monitor handle closes before replacement
    $wrapperPid = $null
    if ($procInfo.ParentProcessId -and ($procInfo.ParentProcessId -as [int]) -gt 0) {
      $parentProc = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$procInfo.ParentProcessId)" -ErrorAction SilentlyContinue
      if ($parentProc -and $parentProc.Name -ieq 'cmd.exe' -and ([string]$parentProc.CommandLine -match '(?i)agy-node.*server\.mjs')) {
        $wrapperPid = [int]$parentProc.ProcessId
      }
    }

    Write-Host "[INFO] Stopping active Sidecar (PID $targetPid) before update..."
    Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $targetPid -Timeout 5 -ErrorAction SilentlyContinue
    if ($wrapperPid) {
      Wait-Process -Id $wrapperPid -Timeout 2 -ErrorAction SilentlyContinue
      if (Get-Process -Id $wrapperPid -ErrorAction SilentlyContinue) {
        Stop-Process -Id $wrapperPid -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $wrapperPid -Timeout 2 -ErrorAction SilentlyContinue
      }
    }
  } catch {
  }
}

function Stop-AllVerifiedSidecars {
  param([string]$RuntimeDir)
  $srvFile = Join-Path $RuntimeDir 'server.json'
  Stop-VerifiedSidecar -ServerJsonPath $srvFile
  $serversDir = Join-Path $RuntimeDir 'servers'
  if (Test-Path $serversDir) {
    Get-ChildItem -Path $serversDir -Filter '*.json' -File -ErrorAction SilentlyContinue | ForEach-Object {
      Stop-VerifiedSidecar -ServerJsonPath $_.FullName
    }
  }
}

function Remove-DirectoryWithRetry {
  param([string]$TargetPath, [int]$MaxAttempts = 10, [int]$DelayMs = 200)
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    if (-not (Test-Path $TargetPath)) { return }
    try {
      Remove-Item -Path $TargetPath -Recurse -Force
      return
    } catch {
      if ($attempt -eq $MaxAttempts) { throw }
      Start-Sleep -Milliseconds $DelayMs
    }
  }
}

if ($SourceDir -ieq $DestDir) {
  Write-Host "[INFO] Source directory is already installed at $DestDir; skipping copy." -ForegroundColor Cyan
} else {
  $rtRoot = Join-Path $DestDir '.runtime'
  Stop-AllVerifiedSidecars -RuntimeDir $rtRoot

  if (Test-Path (Join-Path $DestDir '.runtime\config.json')) {
    Write-Host '[OK] Existing .runtime configuration detected and will be preserved.' -ForegroundColor Green
  }

  New-Item -ItemType Directory -Force -Path $DestDir | Out-Null

  $CopyFiles = @('plugin.json', 'hooks.json', 'package.json', 'README.md', 'LICENSE', 'uninstall.ps1')
  $CopyDirs = @('assets', 'hooks', 'sidecars', 'skills')

  foreach ($file in $CopyFiles) {
    $src = Join-Path $SourceDir $file
    if (Test-Path $src) {
      Copy-Item -Path $src -Destination (Join-Path $DestDir $file) -Force
    }
  }

  foreach ($dir in $CopyDirs) {
    $srcDir = Join-Path $SourceDir $dir
    $dstDir = Join-Path $DestDir $dir
    if (Test-Path $srcDir) {
      if (Test-Path $dstDir) {
        Remove-DirectoryWithRetry -TargetPath $dstDir
      }
      Copy-Item -Path $srcDir -Destination $dstDir -Recurse -Force
    }
  }
  Write-Host "[OK] Installed plugin files to: $DestDir" -ForegroundColor Green
}

if ($NodeBin) {
  foreach ($rel in @('sidecars\status-monitor\server.mjs', 'hooks\hook-reporter.mjs')) {
    $target = Join-Path $DestDir $rel
    & $NodeBin --check $target
    if ($LASTEXITCODE -ne 0) {
      throw "Syntax check failed for $target"
    }
  }
  Write-Host '[OK] Entrypoint syntax verification passed.' -ForegroundColor Green
}

Write-Host ''
$AliasCloneDir = [IO.Path]::GetFullPath((Join-Path $PluginsRoot 'antigravity-status-monitor'))
if (($SourceDir -ine $DestDir) -and ($SourceDir -ieq $AliasCloneDir)) {
  Write-Host "[WARN] Detected source clone inside $AliasCloneDir; remove it to avoid duplicate plugin loading." -ForegroundColor Yellow
}
Write-Host 'Installation complete!' -ForegroundColor Cyan
Write-Host 'Next steps:'
Write-Host '  1. Open or restart Antigravity so plugins and hooks reload.'
Write-Host '  2. In Antigravity, ask to open the Status Monitor panel or enable it under Plugins.'
