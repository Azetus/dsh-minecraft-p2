#Requires -Version 7.0
<#
.SYNOPSIS
Runs a DSH headless task and returns one structured result.
.EXAMPLE
./scripts/dsh-task.ps1 -Task 'Read README.md and summarize it. Do not edit files.'
.EXAMPLE
./scripts/dsh-task.ps1 -Task 'Continue the previous review.' -SessionId 'session-...'
.NOTES
DSH_PERMISSION_MODE is passed only to the child process. DSH may still update
its own profile and session data outside the workspace in read-only mode.
The wrapper reports failures in Errors; inspect Exit, Reason and TimedOut.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$Task,

    [string]$Cwd = (Get-Location).Path,

    [ValidateSet('read-only', 'workspace-write')]
    [string]$Mode = 'read-only',

    [string]$SessionId,

    [ValidateRange(1, 86400)]
    [int]$TimeoutSeconds = 300
)

$result = [ordered]@{
    Exit = $null
    SessionId = $SessionId
    Reason = $null
    Text = $null
    InTokens = [long]0
    OutTokens = [long]0
    CacheReadTokens = [long]0
    CacheWriteTokens = [long]0
    Stderr = ''
    TimedOut = $false
    Errors = @()
}

$process = $null
try {
    $directory = Get-Item -LiteralPath $Cwd -ErrorAction Stop
    if (-not $directory.PSIsContainer -or $directory.PSProvider.Name -ne 'FileSystem') {
        throw 'Cwd must be a filesystem directory.'
    }
    $dshCommand = Get-Command dsh -CommandType Application -ErrorAction Stop |
        Select-Object -First 1

    # A fresh PowerShell process supports Windows .cmd launchers without shell
    # interpolation of the task text. The payload travels as encoded JSON.
    $arguments = @('--profile', 'headless', '--json')
    if ($SessionId) { $arguments += @('--session-id', $SessionId) }
    $arguments += $Task
    $payload = @{
        Command = $dshCommand.Source
        Arguments = $arguments
    } | ConvertTo-Json -Compress -Depth 4
    $encodedPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    $childScript = @'
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
    $commandArguments = @($payload.Arguments)
    & $payload.Command @commandArguments
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.ToString())
    exit 1
}
'@
    $childScript = $childScript.Replace('__PAYLOAD__', $encodedPayload)
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childScript))
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = (Join-Path $PSHOME $(if ($IsWindows) { 'pwsh.exe' } else { 'pwsh' }))
    $startInfo.WorkingDirectory = $directory.FullName
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
    foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedCommand)) {
        $startInfo.ArgumentList.Add($argument)
    }
    $startInfo.Environment['DSH_PERMISSION_MODE'] = $Mode

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void]$process.Start()
    # Drain both pipes concurrently so large output cannot deadlock the child.
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $result.TimedOut = $true
        $result.Errors += "DSH exceeded the $TimeoutSeconds second timeout."
        $process.Kill($true)
        $process.WaitForExit()
    }
    $result.Exit = $process.ExitCode
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $result.Stderr = $stderrTask.GetAwaiter().GetResult()

    $events = @()
    $lineNumber = 0
    foreach ($line in ($stdout -split '\r?\n')) {
        $lineNumber++
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try {
            $events += ConvertFrom-Json -InputObject $line -ErrorAction Stop
        } catch {
            $result.Errors += "Invalid JSON on stdout line ${lineNumber}: $($_.Exception.Message)"
        }
    }

    $session = $events | Where-Object type -eq 'session' | Select-Object -Last 1
    if ($session) { $result.SessionId = $session.sessionId }
    $turnEnd = $events | Where-Object phase -eq 'turn_end' | Select-Object -Last 1
    if ($turnEnd) { $result.Reason = $turnEnd.reason.kind }
    $final = $events | Where-Object type -eq 'final' | Select-Object -Last 1
    if ($final) { $result.Text = $final.text }
    foreach ($event in $events) {
        # Only step_end usage is counted: future summary events must not cause
        # the same tokens to be counted twice. Cached tokens stay separate.
        if ($event.phase -eq 'step_end' -and $event.usage) {
            $result.InTokens += [long]$event.usage.inputTokens
            $result.OutTokens += [long]$event.usage.outputTokens
            $result.CacheReadTokens += [long]$event.usage.cacheReadTokens
            $result.CacheWriteTokens += [long]$event.usage.cacheWriteTokens
        }
    }
    if ($result.Exit -ne 0) { $result.Errors += "DSH exited with code $($result.Exit)." }
    if (-not $final) { $result.Errors += 'No final event was returned by DSH.' }
    if (-not $turnEnd) { $result.Errors += 'No turn_end event was returned by DSH.' }
    elseif ($result.Reason -ne 'completed') {
        $result.Errors += "DSH ended with reason: $($result.Reason)."
    }
} catch {
    $result.Errors += $_.Exception.Message
} finally {
    if ($process) {
        try {
            if ($process.Id -and -not $process.HasExited) {
                $process.Kill($true)
                $process.WaitForExit()
            }
        } catch {
            $result.Errors += "Process cleanup failed: $($_.Exception.Message)"
        }
        $process.Dispose()
    }
}

[pscustomobject]$result
