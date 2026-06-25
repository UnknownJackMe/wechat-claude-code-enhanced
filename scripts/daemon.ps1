$ErrorActionPreference = "Stop"

$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$DataDir = Join-Path $env:USERPROFILE ".wechat-claude-code"
$LogDir = Join-Path $DataDir "logs"
$PidFile = Join-Path $DataDir "wechat-claude-code.pid"
$StopFile = Join-Path $DataDir "wechat-claude-code.stop"
$TaskName = "wechat-claude-code"
$WrapperScript = Join-Path $DataDir "daemon-wrapper.ps1"
$NodeHintFile = Join-Path $DataDir "daemon-node.txt"

function Get-PowerShellPath {
  $systemPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  if (Test-Path $systemPowerShell) {
    return $systemPowerShell
  }
  return "powershell.exe"
}

function Ensure-Dirs {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) {
    return $cmd.Source
  }

  $candidates = @()
  if ($env:ProgramFiles) {
    $candidates += Join-Path $env:ProgramFiles "nodejs\node.exe"
  }
  if (${env:ProgramFiles(x86)}) {
    $candidates += Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"
  }
  if ($env:LOCALAPPDATA) {
    $candidates += Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe"
  }
  if ($env:APPDATA) {
    $candidates += Join-Path $env:APPDATA "nvm\node.exe"
  }
  $candidates = $candidates | Where-Object { $_ -and (Test-Path $_) }

  if ($candidates.Count -gt 0) {
    return $candidates[0]
  }

  throw "node.exe not found in PATH. Please install Node.js first."
}

function Write-NodeHint {
  param([string]$NodePath)
  Ensure-Dirs
  Set-Content -Path $NodeHintFile -Value $NodePath -Encoding UTF8
}

function Read-NodeHint {
  if (Test-Path $NodeHintFile) {
    $value = (Get-Content -Path $NodeHintFile -Raw).Trim()
    if ($value -and (Test-Path $value)) {
      return $value
    }
  }
  return $null
}

function Get-NodePath {
  $hint = Read-NodeHint
  if ($hint) {
    return $hint
  }
  $node = Find-Node
  Write-NodeHint -NodePath $node
  return $node
}

function Quote-PsSingleQuoted {
  param([string]$Value)
  if ($null -eq $Value) {
    return "''"
  }
  return "'" + ($Value -replace "'", "''") + "'"
}

function Get-EnvAssignments {
  $lines = @(
    "`$env:WCC_DATA_DIR = " + (Quote-PsSingleQuoted $DataDir)
  )

  return ($lines | ForEach-Object { $_ + ";" }) -join "`n"
}

function Write-Wrapper {
  $nodePath = Get-NodePath
  $envBlock = Get-EnvAssignments
  $stdoutLog = Join-Path $LogDir "stdout.log"
  $stderrLog = Join-Path $LogDir "stderr.log"
  $wrapperLog = Join-Path $LogDir "wrapper.log"
  $wrapper = @"
`$ErrorActionPreference = "Stop"
$envBlock
`$projectDir = $(Quote-PsSingleQuoted $ProjectDir)
`$pidFile = $(Quote-PsSingleQuoted $PidFile)
`$stopFile = $(Quote-PsSingleQuoted $StopFile)
`$nodePath = $(Quote-PsSingleQuoted $nodePath)
`$stdoutLog = $(Quote-PsSingleQuoted $stdoutLog)
`$stderrLog = $(Quote-PsSingleQuoted $stderrLog)
`$wrapperLog = $(Quote-PsSingleQuoted $wrapperLog)

function Write-WrapperLog {
  param([string]`$Message)
  Add-Content -Path `$wrapperLog -Value ("[{0}] {1}" -f (Get-Date).ToString("s"), `$Message)
}

try {
Write-WrapperLog "wrapper started"
Write-WrapperLog ("projectDir={0}" -f `$projectDir)
Write-WrapperLog ("nodePath={0}" -f `$nodePath)

while (`$true) {
  if (Test-Path `$stopFile) {
    Write-WrapperLog "stop file detected, wrapper exiting"
    Remove-Item -LiteralPath `$stopFile -ErrorAction SilentlyContinue
    break
  }
  try {
    Write-WrapperLog "starting node process: `$nodePath dist/main.js start"
    `$child = Start-Process -FilePath `$nodePath -ArgumentList @("dist/main.js", "start") -WorkingDirectory `$projectDir -WindowStyle Hidden -RedirectStandardOutput `$stdoutLog -RedirectStandardError `$stderrLog -PassThru
    Set-Content -Path `$pidFile -Value `$child.Id -Encoding ASCII
    Wait-Process -Id `$child.Id
    `$exitCode = `$child.ExitCode
    Write-WrapperLog ("node process exited with code {0}" -f `$exitCode)
  } catch {
    `$exitCode = 1
    Write-WrapperLog ("wrapper caught exception: {0}" -f `$_)
  }

  Remove-Item -LiteralPath `$pidFile -ErrorAction SilentlyContinue
  if (Test-Path `$stopFile) {
    Write-WrapperLog "stop file detected after child exit, wrapper exiting"
    Remove-Item -LiteralPath `$stopFile -ErrorAction SilentlyContinue
    break
  }
  if (`$exitCode -eq 0) { break }
  Write-WrapperLog "sleeping 10 seconds before restart"
  Start-Sleep -Seconds 10
}
} catch {
  try {
    Write-WrapperLog ("fatal wrapper exception: {0}" -f `$_.Exception.Message)
  } catch {
  }
  exit 1
}
"@
  Set-Content -Path $WrapperScript -Value $wrapper -Encoding UTF8
}

function Get-Task {
  try {
    $schtasks = Join-Path $env:SystemRoot "System32\schtasks.exe"
    if (-not (Test-Path $schtasks)) {
      return $false
    }
    & $schtasks /Query /TN $TaskName 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Register-Task {
  Write-Wrapper
  $taskCommand = "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WrapperScript`""
  $schtasks = Join-Path $env:SystemRoot "System32\schtasks.exe"
  if (-not (Test-Path $schtasks)) {
    Write-Warning "schtasks.exe 不可用，跳过开机自启注册。"
    return $false
  }
  try {
    & $schtasks /Create /F /SC ONLOGON /RL LIMITED /TN $TaskName /TR $taskCommand | Out-Null
    return $true
  } catch {
    Write-Warning "注册计划任务失败，已降级为仅 direct 模式。"
    return $false
  }
}

function Start-DirectProcess {
  Write-Wrapper
  Remove-Item -LiteralPath $StopFile -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $LogDir "wrapper.log") -ErrorAction SilentlyContinue
  $existingPid = Get-RunningPid
  if ($existingPid) {
    Write-Output "Already running (PID: $existingPid)"
    return
  }

  $powerShellPath = Get-PowerShellPath
  Write-Output "Starting wrapper: $WrapperScript"
  Write-Output "PowerShell: $powerShellPath"
  $proc = Start-Process -FilePath $powerShellPath -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $WrapperScript) -WorkingDirectory $ProjectDir -WindowStyle Hidden -PassThru

  Start-Sleep -Seconds 4
  $runningPid = Get-RunningPid
  if ($runningPid) {
    Write-Output "Started (PID: $runningPid)"
    Write-Output "Logs: $LogDir"
    return
  }

  $wrapperProc = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
  if ($wrapperProc) {
    Write-Output "Wrapper is running (PID: $($proc.Id)) but child PID is not ready yet."
  } else {
    Write-Output "Wrapper exited early (PID: $($proc.Id))."
  }
  if (Test-Path (Join-Path $LogDir "stderr.log")) {
    Write-Output "=== stderr.log ==="
    Get-Content -Path (Join-Path $LogDir "stderr.log") -Tail 50
  }
  if (Test-Path (Join-Path $LogDir "wrapper.log")) {
    Write-Output "=== wrapper.log ==="
    Get-Content -Path (Join-Path $LogDir "wrapper.log") -Tail 50
  }
}

function Get-RunningPid {
  if (-not (Test-Path $PidFile)) {
    return $null
  }

  $raw = (Get-Content -Path $PidFile -Raw).Trim()
  if (-not $raw) {
    Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
    return $null
  }

  $runningPid = 0
  if (-not [int]::TryParse($raw, [ref]$runningPid)) {
    Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
    return $null
  }

  $proc = Get-Process -Id $runningPid -ErrorAction SilentlyContinue
  if (-not $proc) {
    Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
    return $null
  }

  return $runningPid
}

function Stop-ProcessTree {
  Set-Content -Path $StopFile -Value "stop" -Encoding ASCII
  $runningPid = Get-RunningPid
  if (-not $runningPid) {
    Write-Output "Not running"
    return
  }

  taskkill /PID $runningPid /T /F | Out-Null
  Start-Sleep -Seconds 1
  Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
  Write-Output "Stopped (PID: $runningPid)"
}

function Show-Status {
  $runningPid = Get-RunningPid
  if ($runningPid) {
    $hasTask = Get-Task
    if ($hasTask) {
      Write-Output "Running (PID: $runningPid, autostart: enabled)"
    } else {
      Write-Output "Running (PID: $runningPid)"
    }
    return
  }

  if (Get-Task) {
    Write-Output "Not running (autostart task installed)"
  } else {
    Write-Output "Not running"
  }
}

function Show-Logs {
  $stdoutLog = Join-Path $LogDir "stdout.log"
  $stderrLog = Join-Path $LogDir "stderr.log"

  if (Test-Path $stdoutLog) {
    Write-Output "=== stdout.log ==="
    Get-Content -Path $stdoutLog -Tail 50
  }
  if (Test-Path $stderrLog) {
    Write-Output ""
    Write-Output "=== stderr.log ==="
    Get-Content -Path $stderrLog -Tail 50
  }
  $wrapperLog = Join-Path $LogDir "wrapper.log"
  if (Test-Path $wrapperLog) {
    Write-Output ""
    Write-Output "=== wrapper.log ==="
    Get-Content -Path $wrapperLog -Tail 50
  }
  if (-not (Test-Path $stdoutLog) -and -not (Test-Path $stderrLog) -and -not (Test-Path $wrapperLog)) {
    Write-Output "No logs found"
  }
}

Ensure-Dirs

$commandName = ""
if ($args.Count -gt 0 -and $null -ne $args[0]) {
  $commandName = [string]$args[0]
}
$commandName = $commandName.ToLowerInvariant()

switch ($commandName) {
  "start" {
    Register-Task | Out-Null
    Start-DirectProcess
  }
  "stop" {
    Stop-ProcessTree
    if (Get-Task) {
      $schtasks = Join-Path $env:SystemRoot "System32\schtasks.exe"
      if (Test-Path $schtasks) {
        & $schtasks /Delete /F /TN $TaskName | Out-Null
      }
    }
  }
  "restart" {
    Stop-ProcessTree
    if (Get-Task) {
      $schtasks = Join-Path $env:SystemRoot "System32\schtasks.exe"
      if (Test-Path $schtasks) {
        & $schtasks /Delete /F /TN $TaskName | Out-Null
      }
    }
    Register-Task | Out-Null
    Start-DirectProcess
  }
  "status" {
    Show-Status
  }
  "logs" {
    Show-Logs
  }
  default {
    Write-Output "Usage: daemon.ps1 {start|stop|restart|status|logs}"
    exit 1
  }
}
