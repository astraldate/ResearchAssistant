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

# 重新安装依赖
Write-Host "Installing dependencies..."
pnpm install

Write-Host "Done! You can now run 'pnpm tauri dev'"
