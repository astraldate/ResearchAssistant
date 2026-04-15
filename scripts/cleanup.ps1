# cleanup.ps1

# 清理前端依赖
if (Test-Path "node_modules") {
    Write-Host "Removing node_modules..."
    Remove-Item -Path "node_modules" -Recurse -Force
}

# 清理 Rust 构建产物
if (Test-Path "src-tauri/target") {
    Write-Host "Removing src-tauri/target..."
    Remove-Item -Path "src-tauri/target" -Recurse -Force
}

# 清理本机临时日志和评测输出
$TempFiles = @(
    "TEMP_app_slice.txt",
    "tmp-ollama-out.log",
    "tmp-ollama-err.log",
    "research_memory_eval_report.json",
    "research_memory_eval_samples.json"
)

foreach ($File in $TempFiles) {
    if (Test-Path $File) {
        Write-Host "Removing $File..."
        Remove-Item -LiteralPath $File -Force
    }
}

Get-ChildItem -LiteralPath "." -File -Filter "hs_err_pid*.log" | ForEach-Object {
    Write-Host "Removing $($_.Name)..."
    Remove-Item -LiteralPath $_.FullName -Force
}

Get-ChildItem -LiteralPath "." -File -Filter "replay_pid*.log" | ForEach-Object {
    Write-Host "Removing $($_.Name)..."
    Remove-Item -LiteralPath $_.FullName -Force
}

# 重新安装依赖
Write-Host "Installing dependencies..."
pnpm install --force

Write-Host "Done! You can now run 'pnpm tauri dev'"
