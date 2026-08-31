#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Input,
    [Parameter(Mandatory = $true)][string]$OutDir
)

$ErrorActionPreference = 'Stop'
$inputPath = (Resolve-Path -LiteralPath $Input).Path
[IO.Directory]::CreateDirectory($OutDir) | Out-Null
$soffice = @(
    (Get-Command soffice.exe, soffice -ErrorAction SilentlyContinue | Select-Object -First 1).Source,
    'C:\Program Files\LibreOffice\program\soffice.exe',
    'C:\Program Files (x86)\LibreOffice\program\soffice.exe'
) | Where-Object { $_ -and (($_ -notmatch '\\') -or (Test-Path -LiteralPath $_)) } | Select-Object -First 1
if (-not $soffice) { throw 'LibreOffice is required to convert .doc files. Install it with winget install TheDocumentFoundation.LibreOffice.' }
& $soffice '--headless' '--norestore' '--convert-to' 'docx' '--outdir' $OutDir $inputPath
if ($LASTEXITCODE -ne 0) { throw 'LibreOffice conversion failed.' }
