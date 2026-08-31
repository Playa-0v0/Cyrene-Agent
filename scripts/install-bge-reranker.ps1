# install-bge-reranker.ps1
# 下载 bge-reranker-base 的 ONNX 量化模型到 models/bge-reranker-base/onnx/model_quantized.onnx
# 用法（PowerShell）：
#   .\scripts\install-bge-reranker.ps1           # 自动按优先级尝试
#   .\scripts\install-bge-reranker.ps1 -Force    # 不询问，强制执行

param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$targetDir = Join-Path $repoRoot "models\bge-reranker-base\onnx"
$targetFile = Join-Path $targetDir "model_quantized.onnx"

Write-Host ""
Write-Host "[install-bge-reranker] 目标路径: $targetFile" -ForegroundColor Cyan

# ── 已有则跳过 ──
if (Test-Path $targetFile) {
    $existingSize = (Get-Item $targetFile).Length
    Write-Host "[install-bge-reranker] 文件已存在 ($([math]::Round($existingSize/1MB,1)) MB)，跳过下载。" -ForegroundColor Yellow
    if (-not $Force) {
        $ans = Read-Host "要覆盖吗？[y/N]"
        if ($ans -ne "y" -and $ans -ne "Y") { exit 0 }
    }
}

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

# ── 候选下载源（按推荐顺序） ──
# 1) Hugging Face 国内镜像（hf-mirror.com）— 优先，体积最小（~105MB）
# 2) ModelScope 魔搭 — 兜底，1GB 完整版（code 自动复制为 model_quantized.onnx 名称）
$candidates = @(
    @{
        name        = "hf-mirror.com (Xenova 量化版, ~105MB)"
        url         = "https://hf-mirror.com/Xenova/bge-reranker-base/resolve/main/onnx/model_quantized.onnx"
        type        = "quantized"
    },
    @{
        name        = "魔搭 (model.onnx 完整版, ~1.06GB)"
        url         = "https://www.modelscope.cn/models/BAAI/bge-reranker-base/resolve/master/onnx/model.onnx"
        type        = "full"
    }
)

function Test-UrlReachable($url, $timeoutSec = 10) {
    try {
        $req = [System.Net.HttpWebRequest]::Create($url)
        $req.Method = "HEAD"
        $req.Timeout = $timeoutSec * 1000
        $req.UserAgent = "Mozilla/5.0"
        $resp = $req.GetResponse()
        $status = [int]$resp.StatusCode
        $resp.Close()
        return $status
    } catch {
        return $null
    }
}

function Download-File($url, $dest, $label) {
    Write-Host ""
    Write-Host "[install-bge-reranker] 从 $label 下载..." -ForegroundColor Green
    Write-Host "[install-bge-reranker] URL: $url"
    try {
        # BITS 或 Invoke-WebRequest 二选一，优先 BITS（更稳，支持大文件、断点续传）
        if (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue) {
            Start-BitsTransfer -Source $url -Destination $dest -DisplayName $label -Description "bge-reranker-base onnx" -ErrorAction Stop
        } else {
            # 退回 Invoke-WebRequest（不支持断点续传，但 PowerShell 自带）
            Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 600
        }
        return $true
    } catch {
        Write-Host "[install-bge-reranker] 下载失败: $_" -ForegroundColor Red
        if (Test-Path $dest) { Remove-Item $dest -Force }
        return $false
    }
}

# ── 自动按优先级尝试 ──
foreach ($c in $candidates) {
    Write-Host ""
    Write-Host "[install-bge-reranker] 探测: $($c.name)" -ForegroundColor Cyan
    $status = Test-UrlReachable $c.url
    if ($status -ge 200 -and $status -lt 400) {
        Write-Host "[install-bge-reranker]   ✓ 可达 (HTTP $status)" -ForegroundColor Green
    } else {
        Write-Host "[install-bge-reranker]   ✗ 不可达 (status=$status)" -ForegroundColor DarkGray
        continue
    }

    if (-not (Download-File $c.url $targetFile $c.name)) { continue }

    # 如果是 model.onnx（魔搭），复制为 model_quantized.onnx 名称以匹配代码期望
    if ($c.type -eq "full") {
        Write-Host "[install-bge-reranker] 完整版下载完成，复制为 model_quantized.onnx 名称" -ForegroundColor Yellow
        Copy-Item $targetFile $targetFile -Force
    }

    # 验证
    if (Test-Path $targetFile) {
        $size = (Get-Item $targetFile).Length
        $sizeMB = [math]::Round($size / 1MB, 1)
        if ($size -lt 1MB) {
            Write-Host "[install-bge-reranker] 失败：文件太小 ($sizeMB MB)，疑似下载错误" -ForegroundColor Red
            Remove-Item $targetFile -Force
            continue
        }
        Write-Host ""
        Write-Host "[install-bge-reranker] ✓ 下载完成" -ForegroundColor Green
        Write-Host "[install-bge-reranker]   路径: $targetFile" -ForegroundColor Green
        Write-Host "[install-bge-reranker]   大小: $sizeMB MB" -ForegroundColor Green
        if ($c.type -eq "full") {
            Write-Host "[install-bge-reranker]   类型: 完整版（推荐用 optimum 量化以减小打包体积）" -ForegroundColor Yellow
        } else {
            Write-Host "[install-bge-reranker]   类型: Xenova 量化版" -ForegroundColor Green
        }
        exit 0
    }
}

Write-Host ""
Write-Host "[install-bge-reranker] 所有候选源都失败，请检查网络后重试。" -ForegroundColor Red
exit 1
