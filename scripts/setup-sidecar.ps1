# Download and setup Ollama sidecar
$ErrorActionPreference = "Stop"

$TargetTriple = "x86_64-pc-windows-msvc"
$BinDir = "src-tauri/binaries"
$OllamaUrl = "https://ollama.com/download/ollama-windows-amd64.zip" 
# Note: Ollama officially distributes an installer (.exe), but we need the binary.
# Since direct binary download link is not always stable/available, 
# for development we often need to copy from existing installation or use a known binary url.
# However, the user might not have Ollama installed.

# Try to find existing Ollama installation first
$LocalOllama = Get-Command "ollama" -ErrorAction SilentlyContinue
if ($LocalOllama) {
    Write-Host "Found local Ollama at $($LocalOllama.Source)"
    $SourcePath = $LocalOllama.Source
} else {
    # Try standard install paths
    $PossiblePaths = @(
        "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
        "$env:ProgramFiles\Ollama\ollama.exe"
    )
    
    foreach ($Path in $PossiblePaths) {
        if (Test-Path $Path) {
            Write-Host "Found Ollama at $Path"
            $SourcePath = $Path
            break
        }
    }
}

if (-not $SourcePath) {
    Write-Warning "Could not find local Ollama installation."
    Write-Warning "Please download Ollama from https://ollama.com/download"
    Write-Warning "After installing, run this script again to copy the binary."
    exit 1
}

# Create binaries directory
if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir | Out-Null
}

# Copy and rename for Tauri sidecar (ollama-x86_64-pc-windows-msvc.exe)
$DestPath = Join-Path $BinDir "ollama-$TargetTriple.exe"
Copy-Item -Path $SourcePath -Destination $DestPath -Force

Write-Host "Successfully setup Ollama sidecar at $DestPath"
