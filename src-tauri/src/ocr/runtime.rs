use super::manifest::{OcrDownloadAsset, OCR_DOWNLOAD_MANIFEST};
use super::storage::OcrStorage;
use super::types::{
    DownloadOcrRuntimeRequest, OcrJobStage, OcrJobStatus, OcrProgressEvent, OcrRuntimeAssetStatus,
    OcrRuntimeStatus, OCR_MODEL_BUNDLE_VERSION,
};
use futures_util::StreamExt;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Clone, Default)]
pub struct OcrRuntimeState {
    cancel_download: Arc<AtomicBool>,
}

impl OcrRuntimeState {
    pub fn begin_download(&self) {
        self.cancel_download.store(false, Ordering::SeqCst);
    }

    pub fn cancel_download(&self) {
        self.cancel_download.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel_download.load(Ordering::SeqCst)
    }
}

pub fn runtime_status(storage: &OcrStorage) -> Result<OcrRuntimeStatus, String> {
    let mut assets = Vec::with_capacity(OCR_DOWNLOAD_MANIFEST.len());
    let mut ready = cfg!(all(target_os = "windows", target_arch = "x86_64"));
    for asset in OCR_DOWNLOAD_MANIFEST {
        let path = storage.runtime_root.join(asset.file_name);
        let installed_size = path.metadata().ok().map(|metadata| metadata.len());
        let installed = installed_size.is_some();
        let usable = installed && validate_file(&path, asset.expected_size).is_ok();
        ready &= usable;
        assets.push(OcrRuntimeAssetStatus {
            asset_id: asset.asset_id.to_string(),
            file_name: asset.file_name.to_string(),
            purpose: asset.purpose.to_string(),
            version: asset.version.to_string(),
            expected_size: asset.expected_size,
            installed_size,
            installed,
            usable,
            license: asset.license.to_string(),
        });
    }

    let last_error = if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Some("当前 OCR 运行时第一阶段仅支持 Windows x64。".to_string())
    } else if !ready {
        Some("OCR 运行时或模型尚未完整安装。".to_string())
    } else {
        None
    };

    Ok(OcrRuntimeStatus {
        platform_supported: cfg!(all(target_os = "windows", target_arch = "x86_64")),
        ready,
        execution_provider: "CPU".to_string(),
        directml_available: false,
        model_bundle_version: OCR_MODEL_BUNDLE_VERSION.to_string(),
        assets,
        last_error,
    })
}

pub async fn download_runtime<F>(
    storage: &OcrStorage,
    state: &OcrRuntimeState,
    request: DownloadOcrRuntimeRequest,
    mut on_progress: F,
) -> Result<OcrRuntimeStatus, String>
where
    F: FnMut(OcrProgressEvent),
{
    if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        return Err("当前 OCR 运行时第一阶段仅支持 Windows x64。".to_string());
    }
    state.begin_download();
    let selected = select_assets(&request.asset_ids)?;
    if selected.is_empty() {
        return Err("没有可下载的 OCR 资产。".to_string());
    }
    let client = reqwest::Client::builder()
        .user_agent("ResearchAssistant-OCR/1")
        .build()
        .map_err(|error| error.to_string())?;
    let total_assets = selected.len();

    for (index, asset) in selected.into_iter().enumerate() {
        if state.is_cancelled() {
            return Err("OCR 运行时下载已暂停，可稍后重试。".to_string());
        }
        let target = storage.runtime_root.join(asset.file_name);
        if validate_file(&target, asset.expected_size).is_ok() {
            continue;
        }
        let temporary = storage.runtime_root.join(format!(
            ".{}.{}.part",
            asset.file_name,
            uuid::Uuid::new_v4()
        ));
        let response = client
            .get(asset.url)
            .send()
            .await
            .map_err(|error| format!("下载 {} 失败：{error}", asset.purpose))?
            .error_for_status()
            .map_err(|error| format!("下载 {} 失败：{error}", asset.purpose))?;
        let response_total = response.content_length().or_else(|| {
            if asset.expected_size > 0 {
                Some(asset.expected_size)
            } else {
                None
            }
        });
        let mut output = File::create(&temporary).map_err(|error| error.to_string())?;
        let mut stream = response.bytes_stream();
        let mut downloaded = 0u64;
        while let Some(chunk) = stream.next().await {
            if state.is_cancelled() {
                drop(output);
                let _ = fs::remove_file(&temporary);
                return Err("OCR 运行时下载已暂停，可稍后重试。".to_string());
            }
            let chunk = chunk.map_err(|error| error.to_string())?;
            output
                .write_all(&chunk)
                .map_err(|error| error.to_string())?;
            downloaded += chunk.len() as u64;
            let file_ratio = response_total
                .filter(|total| *total > 0)
                .map(|total| (downloaded as f32 / total as f32).clamp(0.0, 1.0))
                .unwrap_or(0.0);
            on_progress(OcrProgressEvent {
                job_id: "ocr-runtime-download".to_string(),
                asset_id: asset.asset_id.to_string(),
                stage: OcrJobStage::Download,
                status: OcrJobStatus::Running,
                current_page: None,
                completed_pages: index,
                total_pages: total_assets,
                failed_pages: 0,
                progress: (index as f32 + file_ratio) / total_assets as f32,
                pages_per_minute: None,
                message: format!("正在下载 {}。", asset.purpose),
            });
        }
        output.sync_all().map_err(|error| error.to_string())?;
        drop(output);
        if let Some(total) = response_total {
            if downloaded != total {
                let _ = fs::remove_file(&temporary);
                return Err(format!(
                    "{} 下载长度不完整：期望 {total} 字节，实际 {downloaded} 字节。",
                    asset.purpose
                ));
            }
        }
        if let Err(error) = validate_file(&temporary, asset.expected_size) {
            let _ = fs::remove_file(&temporary);
            return Err(format!("{} 文件检查失败：{error}", asset.purpose));
        }
        replace_atomically(&temporary, &target)?;
    }

    on_progress(OcrProgressEvent {
        job_id: "ocr-runtime-download".to_string(),
        asset_id: "runtime".to_string(),
        stage: OcrJobStage::Download,
        status: OcrJobStatus::Completed,
        current_page: None,
        completed_pages: total_assets,
        total_pages: total_assets,
        failed_pages: 0,
        progress: 1.0,
        pages_per_minute: None,
        message: "OCR 运行时资产已安装。".to_string(),
    });
    runtime_status(storage)
}

pub fn delete_runtime_assets(
    storage: &OcrStorage,
    asset_ids: &[String],
) -> Result<OcrRuntimeStatus, String> {
    let selected = select_assets(asset_ids)?;
    for asset in selected {
        let path = storage.runtime_root.join(asset.file_name);
        if path.exists() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }
    runtime_status(storage)
}

fn select_assets(asset_ids: &[String]) -> Result<Vec<&'static OcrDownloadAsset>, String> {
    let request_all = asset_ids.is_empty();
    let mut selected = Vec::new();
    for asset in OCR_DOWNLOAD_MANIFEST {
        if !request_all && !asset_ids.iter().any(|asset_id| asset_id == asset.asset_id) {
            continue;
        }
        if !asset.url.starts_with("https://") {
            return Err(format!("OCR 资产 {} 不是 HTTPS 来源。", asset.asset_id));
        }
        selected.push(asset);
    }
    if !request_all {
        for asset_id in asset_ids {
            if !OCR_DOWNLOAD_MANIFEST
                .iter()
                .any(|asset| asset.asset_id == asset_id)
            {
                return Err(format!("未知的 OCR 资产：{asset_id}。"));
            }
        }
    }
    Ok(selected)
}

pub fn validate_file(path: &Path, expected_size: u64) -> Result<u64, String> {
    let metadata = path.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("资产文件不存在或为空。".to_string());
    }
    if expected_size > 0 && metadata.len() != expected_size {
        return Err(format!(
            "文件大小不匹配：期望 {expected_size} 字节，实际 {} 字节。",
            metadata.len()
        ));
    }
    Ok(metadata.len())
}

fn replace_atomically(temporary: &Path, target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "OCR 资产路径无父目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    if !target.exists() {
        return fs::rename(temporary, target).map_err(|error| error.to_string());
    }
    let previous: PathBuf = parent.join(format!(
        ".{}.{}.previous",
        target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("asset"),
        uuid::Uuid::new_v4()
    ));
    fs::rename(target, &previous).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(temporary, target) {
        let _ = fs::rename(&previous, target);
        return Err(error.to_string());
    }
    fs::remove_file(previous).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 过去缺少哈希的资产现在可以被点名下载() {
        let result = select_assets(&["pdfium-win-x64".to_string()]);
        assert_eq!(result.expect("资产应可选择").len(), 1);
    }

    #[test]
    fn 文件检查会拒绝空文件和已知大小不一致() {
        let path = std::env::temp_dir().join(format!("ra-ocr-file-{}", uuid::Uuid::new_v4()));
        fs::write(&path, b"").expect("应写入空测试文件");
        assert!(validate_file(&path, 0).is_err());
        fs::write(&path, b"ResearchAssistant").expect("应写入测试文件");
        assert_eq!(
            validate_file(&path, 0).expect("未知大小时应接受非空文件"),
            17
        );
        assert!(validate_file(&path, 16).is_err());
        fs::remove_file(path).expect("应清理测试文件");
    }
}
