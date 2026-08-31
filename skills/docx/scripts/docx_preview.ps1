#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Input,
    [string]$OutDir,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
$inputPath = (Resolve-Path -LiteralPath $Input).Path
if ([IO.Path]::GetExtension($inputPath).ToLowerInvariant() -ne '.docx') {
    throw 'Input must be a .docx file.'
}
if (-not $OutDir) {
    $OutDir = Join-Path (Split-Path -Parent $inputPath) 'preview'
}
[IO.Directory]::CreateDirectory($OutDir) | Out-Null

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

$textOutput = Join-Path $OutDir (([IO.Path]::GetFileNameWithoutExtension($inputPath)) + '.txt')
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($inputPath)
try {
    $entry = $archive.GetEntry('word/document.xml')
    if ($null -eq $entry) { throw 'The document does not contain word/document.xml.' }
    $reader = [IO.StreamReader]::new($entry.Open())
    try { $xml = $reader.ReadToEnd() } finally { $reader.Dispose() }
} finally { $archive.Dispose() }
[IO.File]::WriteAllText($textOutput, ([regex]::Replace($xml, '<[^>]+>', ' ') -replace '\s+', ' ').Trim(), [Text.UTF8Encoding]::new($false))

$soffice = Find-Soffice
$pdfOutput = $null
if ($soffice) {
    & $soffice '--headless' '--norestore' '--convert-to' 'pdf' '--outdir' $OutDir $inputPath 2>$null
    if ($LASTEXITCODE -eq 0) {
        $candidate = Join-Path $OutDir (([IO.Path]::GetFileNameWithoutExtension($inputPath)) + '.pdf')
        if (Test-Path -LiteralPath $candidate) { $pdfOutput = $candidate }
    }
}

$report = [ordered]@{
    status = if ($pdfOutput) { 'ok' } else { 'text-only' }
    input = $inputPath
    text = $textOutput
    pdf = $pdfOutput
    hint = if ($pdfOutput) { 'Inspect the generated PDF for visual layout.' } else { 'Install LibreOffice for a rendered PDF preview.' }
}
if ($Json) { $report | ConvertTo-Json -Compress } else { $report | ConvertTo-Json }
