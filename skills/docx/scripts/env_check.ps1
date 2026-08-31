#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Join-Path $ScriptDir 'dotnet'

function Find-Soffice {
    $command = Get-Command soffice.exe, soffice -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    foreach ($candidate in @(
        'C:\Program Files\LibreOffice\program\soffice.exe',
        'C:\Program Files (x86)\LibreOffice\program\soffice.exe',
        (Join-Path $env:LOCALAPPDATA 'Programs\LibreOffice\program\soffice.exe')
    )) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
$dotnetVersion = $null
if ($dotnet) {
    try {
        $dotnetVersion = (& $dotnet.Source --version 2>$null).Trim()
    } catch {
        $dotnetVersion = $null
    }
}
$dotnetReady = $dotnetVersion -and ([int](($dotnetVersion -split '\.')[0]) -ge 8)
$projectReady = Test-Path -LiteralPath $ProjectDir
$soffice = Find-Soffice
$buildReady = $true
$buildError = $null

if (-not $SkipBuild -and $dotnetReady -and $projectReady) {
    & dotnet build $ProjectDir --verbosity quiet 2>$null
    $buildReady = $LASTEXITCODE -eq 0
    if (-not $buildReady) { $buildError = 'dotnet build failed; run setup.ps1 for dependency setup.' }
}

$ready = $dotnetReady -and $projectReady -and $buildReady
$report = [ordered]@{
    status = if ($ready) { 'READY' } else { 'NOT READY' }
    checks = [ordered]@{
        dotnet = [bool]$dotnetReady
        dotnet_version = $dotnetVersion
        project = [bool]$projectReady
        build = [bool]$buildReady
        libreoffice = [bool]($null -ne $soffice)
    }
    paths = [ordered]@{
        project = $ProjectDir
        soffice = $soffice
    }
    hint = if ($ready) { 'Environment is ready.' } else { 'Run powershell -ExecutionPolicy Bypass -File scripts/setup.ps1 -Minimal.' }
    build_error = $buildError
}

if ($Json) {
    $report | ConvertTo-Json -Depth 4 -Compress
} else {
    $report | ConvertTo-Json -Depth 4
}

exit 0
