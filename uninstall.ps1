[CmdletBinding()]
param(
  [string]$PluginsRoot = (Join-Path $env:USERPROFILE '.gemini\config\plugins'),
  [switch]$KeepConfig
)

$ErrorActionPreference = 'Stop'
$CandidatePluginIds = @('agent-status-monitor', 'antigravity-status-monitor')
$InstalledTargets = @()
foreach ($pidName in $CandidatePluginIds) {
  $candidateDir = [IO.Path]::GetFullPath((Join-Path $PluginsRoot $pidName))
  if (Test-Path $candidateDir) {
    $InstalledTargets += @{ Id = $pidName; Dir = $candidateDir }
  }
}

if ($InstalledTargets.Count -eq 0) {
  $defaultDest = [IO.Path]::GetFullPath((Join-Path $PluginsRoot 'agent-status-monitor'))
  Write-Host "[INFO] Plugin is not installed at $defaultDest." -ForegroundColor Yellow
  exit 0
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

    # Capture Antigravity's cmd.exe wrapper before stopping server.mjs so we can wait for its CWD handle to close
    $wrapperPid = $null
    if ($procInfo.ParentProcessId -and ($procInfo.ParentProcessId -as [int]) -gt 0) {
      $parentProc = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$procInfo.ParentProcessId)" -ErrorAction SilentlyContinue
      if ($parentProc -and $parentProc.Name -ieq 'cmd.exe' -and ([string]$parentProc.CommandLine -match '(?i)agy-node.*server\.mjs')) {
        $wrapperPid = [int]$parentProc.ProcessId
      }
    }

    Write-Host "[INFO] Stopping running Sidecar process (PID $targetPid)..."
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

function Clear-ReadOnlyAttributes {
  param([string]$TargetPath)
  Get-ChildItem -Path $TargetPath -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Attributes -band [IO.FileAttributes]::ReadOnly) {
      $_.Attributes = $_.Attributes -bxor [IO.FileAttributes]::ReadOnly
    }
  }
}

function Uninstall-PluginDir {
  param([string]$PluginId, [string]$DestDir, [bool]$PreserveConfig)

  $cwd = [IO.Path]::GetFullPath((Get-Location).Path).TrimEnd('\')
  $destTrim = $DestDir.TrimEnd('\')
  if ($cwd -ieq $destTrim -or $cwd.StartsWith(($destTrim + '\'), [StringComparison]::OrdinalIgnoreCase)) {
    Set-Location (Split-Path -Parent $DestDir)
  }

  $srvFile = Join-Path $DestDir '.runtime\server.json'
  $sidecarManifest = Join-Path $DestDir 'sidecars\status-monitor\sidecar.json'
  if (Test-Path $sidecarManifest) {
    Remove-Item -Path $sidecarManifest -Force -ErrorAction SilentlyContinue
  }
  Stop-VerifiedSidecar -ServerJsonPath $srvFile

  $SavedConfig = $null
  $CfgFile = Join-Path $DestDir '.runtime\config.json'
  $Utf8NoBom = [Text.UTF8Encoding]::new($false)
  if ($PreserveConfig -and (Test-Path $CfgFile)) {
    $SavedConfig = [IO.File]::ReadAllText($CfgFile, $Utf8NoBom)
  }

  for ($attempt = 1; $attempt -le 10; $attempt++) {
    if (-not (Test-Path $DestDir)) { break }
    Clear-ReadOnlyAttributes -TargetPath $DestDir
    try {
      Remove-Item -Path $DestDir -Recurse -Force
      break
    } catch {
      if ($attempt -eq 10) { throw }
      Stop-VerifiedSidecar -ServerJsonPath $srvFile
      Start-Sleep -Milliseconds 200
    }
  }

  if ($PreserveConfig -and $null -ne $SavedConfig) {
    $rtDir = Join-Path $DestDir '.runtime'
    New-Item -ItemType Directory -Force -Path $rtDir | Out-Null
    [IO.File]::WriteAllText((Join-Path $rtDir 'config.json'), $SavedConfig, $Utf8NoBom)
    Write-Host "[OK] Plugin removed; preserved user config at $rtDir\config.json" -ForegroundColor Green
  } else {
    Write-Host "[OK] Uninstalled $PluginId from $DestDir" -ForegroundColor Green
  }
}

foreach ($target in $InstalledTargets) {
  Uninstall-PluginDir -PluginId $target.Id -DestDir $target.Dir -PreserveConfig ([bool]$KeepConfig)
}
