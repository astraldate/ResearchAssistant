// 本增量先建立完整的 OCR 基础边界；真实推理接入后会消费当前预留的版面与任务接口。
#![allow(dead_code)]

mod coordinates;
mod layout;
mod manifest;
mod pipeline;
mod preflight;
mod runtime;
mod storage;
mod types;

use self::runtime::OcrRuntimeState;
use self::storage::OcrStorage;
use self::types::{
    DeleteOcrRuntimeAssetsRequest, DownloadOcrRuntimeRequest, InspectPdfOcrRequest, OcrAssetRecord,
    OcrJobRecord, OcrPageLayout, OcrPdfInspection, OcrRuntimeStatus, ReadOcrPageLayoutRequest,
};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

pub use self::runtime::OcrRuntimeState as RuntimeState;

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let storage = OcrStorage::from_app(app)?;
    let recovered = storage.recover_running_jobs()?;
    let stale = storage.mark_stale_assets()?;
    if !recovered.is_empty() {
        println!(
            "OCR 启动恢复：已安全暂停 {} 个上次未结束的任务。",
            recovered.len()
        );
    }
    if !stale.is_empty() {
        println!(
            "OCR 启动检查：已将 {} 个源文件变化或缺失的资产标记为过期。",
            stale.len()
        );
    }
    Ok(())
}

#[tauri::command]
pub fn get_ocr_runtime_status(app: AppHandle) -> Result<OcrRuntimeStatus, String> {
    runtime::runtime_status(&OcrStorage::from_app(&app)?)
}

#[tauri::command]
pub async fn download_ocr_runtime(
    app: AppHandle,
    state: State<'_, OcrRuntimeState>,
    request: DownloadOcrRuntimeRequest,
) -> Result<OcrRuntimeStatus, String> {
    let storage = OcrStorage::from_app(&app)?;
    let progress_app = app.clone();
    runtime::download_runtime(&storage, state.inner(), request, move |event| {
        let _ = progress_app.emit("ocr-progress", event);
    })
    .await
}

#[tauri::command]
pub fn cancel_ocr_runtime_download(state: State<'_, OcrRuntimeState>) -> Result<(), String> {
    state.cancel_download();
    Ok(())
}

#[tauri::command]
pub fn delete_ocr_runtime_assets(
    app: AppHandle,
    request: DeleteOcrRuntimeAssetsRequest,
) -> Result<OcrRuntimeStatus, String> {
    let storage = OcrStorage::from_app(&app)?;
    runtime::delete_runtime_assets(&storage, &request.asset_ids)
}

#[tauri::command]
pub fn inspect_pdf_ocr(
    app: AppHandle,
    request: InspectPdfOcrRequest,
) -> Result<OcrPdfInspection, String> {
    let source_path = validate_pdf_source(&request.source_path)?;
    let signature = OcrStorage::source_signature(&source_path)?;
    let inspection = preflight::inspect_pdf(&source_path, signature.clone())?;
    let storage = OcrStorage::from_app(&app)?;
    let asset_id = OcrStorage::asset_id(&source_path)?;
    let now = storage::unix_timestamp_string();
    let previous = storage.read_asset(&asset_id)?;
    let record = OcrAssetRecord {
        asset_id: asset_id.clone(),
        paper_id: previous.as_ref().and_then(|asset| asset.paper_id.clone()),
        source_path: source_path.to_string_lossy().to_string(),
        source_signature: signature,
        sidecar_root: storage
            .sidecar_root
            .join(&asset_id)
            .to_string_lossy()
            .to_string(),
        model_version: types::OCR_MODEL_BUNDLE_VERSION.to_string(),
        page_count: inspection.page_count,
        covered_pages: previous
            .as_ref()
            .map(|asset| asset.covered_pages.clone())
            .unwrap_or_default(),
        status: previous
            .as_ref()
            .map(|asset| asset.status)
            .unwrap_or(types::OcrAssetStatus::Pending),
        created_at: previous
            .as_ref()
            .map(|asset| asset.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
    };
    storage.upsert_asset(&record)?;
    Ok(inspection)
}

#[tauri::command]
pub fn list_ocr_assets(app: AppHandle) -> Result<Vec<OcrAssetRecord>, String> {
    OcrStorage::from_app(&app)?.list_assets()
}

#[tauri::command]
pub fn list_ocr_jobs(app: AppHandle) -> Result<Vec<OcrJobRecord>, String> {
    OcrStorage::from_app(&app)?.list_jobs()
}

#[tauri::command]
pub fn read_ocr_page_layout(
    app: AppHandle,
    request: ReadOcrPageLayoutRequest,
) -> Result<Option<OcrPageLayout>, String> {
    let source_path = validate_pdf_source(&request.source_path)?;
    let storage = OcrStorage::from_app(&app)?;
    let asset_id = OcrStorage::asset_id(&source_path)?;
    let signature = OcrStorage::source_signature(&source_path)?;
    storage.read_page_layout(&asset_id, request.page, &signature)
}

fn validate_pdf_source(value: &str) -> Result<PathBuf, String> {
    let source = Path::new(value.trim());
    if value.trim().is_empty() || !source.is_file() {
        return Err("OCR 源 PDF 不存在或不是文件。".to_string());
    }
    if !source
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        return Err("OCR 当前只接受 PDF 文件。".to_string());
    }
    source.canonicalize().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 非_pdf_不能进入_o_c_r_诊断() {
        let path = std::env::temp_dir().join(format!("ra-ocr-source-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&path, "不是 PDF").expect("应创建测试文件");
        assert!(validate_pdf_source(path.to_string_lossy().as_ref()).is_err());
        std::fs::remove_file(path).expect("应清理测试文件");
    }
}
