use super::layout::assign_reading_order;
use super::storage::{unix_timestamp_string, OcrStorage};
use super::types::{
    OcrAssetRecord, OcrAssetStatus, OcrFailedPage, OcrJobRecord, OcrJobStage, OcrJobStatus,
    OcrPageLayout, OcrProgressEvent, OcrRawPageCache, OCR_RAW_CACHE_SCHEMA_VERSION,
};
use serde_json::Value;
use std::path::Path;

const DEFAULT_MAX_PAGE_ATTEMPTS: u32 = 3;

pub struct OcrPageOutput {
    pub raw_payload: Value,
    pub layout: OcrPageLayout,
}

pub trait OcrBackend {
    fn model_version(&self) -> &str;

    fn process_page(
        &mut self,
        source_path: &Path,
        page: u32,
        cached_raw: Option<&Value>,
    ) -> Result<OcrPageOutput, String>;
}

pub fn run_job<B, C, P>(
    storage: &OcrStorage,
    asset: &mut OcrAssetRecord,
    job: &mut OcrJobRecord,
    backend: &mut B,
    mut is_cancelled: C,
    mut on_progress: P,
) -> Result<(), String>
where
    B: OcrBackend,
    C: FnMut() -> bool,
    P: FnMut(OcrProgressEvent),
{
    validate_job(asset, job)?;
    let model_version = backend.model_version().to_string();
    let mut target_pages = job.target_pages.clone();
    target_pages.sort_unstable();
    target_pages.dedup();
    target_pages.retain(|page| *page > 0 && *page <= asset.page_count);
    if target_pages.is_empty() {
        return Err("OCR 任务没有可处理的有效页码。".to_string());
    }
    job.target_pages = target_pages.clone();
    asset.model_version = model_version.clone();
    job.status = OcrJobStatus::Running;
    job.stage = OcrJobStage::Detect;
    job.cancel_requested = false;
    job.started_at.get_or_insert_with(unix_timestamp_string);
    persist_job(storage, job)?;

    for page in target_pages.iter().copied() {
        if is_cancelled() {
            pause_job(storage, job, "OCR 任务已在页面边界安全暂停。")?;
            emit_progress(job, Some(page), &mut on_progress);
            return Ok(());
        }

        let valid_sidecar = storage
            .read_current_page_layout(
                &asset.asset_id,
                page,
                &asset.source_signature,
                &model_version,
            )?
            .is_some();
        if valid_sidecar {
            commit_completed_page(storage, asset, job, page)?;
            emit_progress(job, Some(page), &mut on_progress);
            continue;
        }
        job.completed_pages.retain(|completed| *completed != page);

        let cached = storage.read_raw_page_cache(
            &asset.asset_id,
            page,
            &asset.source_signature,
            &model_version,
        )?;
        let mut attempts = job
            .failed_pages
            .iter()
            .find(|failed| failed.page == page)
            .map(|failed| failed.attempts)
            .unwrap_or(0);
        let mut attempts_this_run = 0;
        let mut last_error = None;
        while attempts_this_run < DEFAULT_MAX_PAGE_ATTEMPTS {
            attempts_this_run += 1;
            attempts += 1;
            match backend.process_page(
                Path::new(&job.source_path),
                page,
                cached.as_ref().map(|cache| &cache.payload),
            ) {
                Ok(mut output) => {
                    output.layout.source_signature = asset.source_signature.clone();
                    output.layout.model_version = model_version.clone();
                    output.layout.page = page;
                    assign_reading_order(&mut output.layout.regions);
                    storage.write_raw_page_cache(
                        &asset.asset_id,
                        &OcrRawPageCache {
                            schema_version: OCR_RAW_CACHE_SCHEMA_VERSION,
                            source_signature: asset.source_signature.clone(),
                            model_version: model_version.clone(),
                            page,
                            payload: output.raw_payload,
                        },
                    )?;
                    // Sidecar 成功落盘后才能提交完成页，保证崩溃恢复不会跳过半成品。
                    storage.write_page_layout(&asset.asset_id, &mut output.layout)?;
                    commit_completed_page(storage, asset, job, page)?;
                    last_error = None;
                    break;
                }
                Err(error) => last_error = Some(error),
            }
        }

        if let Some(error) = last_error {
            upsert_failed_page(job, page, attempts, &error);
            job.last_error = Some(format!("第 {page} 页 OCR 失败：{error}"));
            persist_job(storage, job)?;
        }
        emit_progress(job, Some(page), &mut on_progress);
    }

    if job.failed_pages.is_empty() {
        job.status = OcrJobStatus::Completed;
        job.stage = OcrJobStage::Completed;
        job.progress = 1.0;
        job.last_error = None;
        asset.status = OcrAssetStatus::Ready;
    } else {
        job.status = OcrJobStatus::Failed;
        job.stage = OcrJobStage::Failed;
        asset.status = OcrAssetStatus::Partial;
    }
    job.updated_at = unix_timestamp_string();
    asset.updated_at = job.updated_at.clone();
    storage.upsert_asset(asset)?;
    storage.upsert_job(job)?;
    emit_progress(job, None, &mut on_progress);
    Ok(())
}

fn validate_job(asset: &OcrAssetRecord, job: &OcrJobRecord) -> Result<(), String> {
    if asset.asset_id != job.asset_id || asset.source_signature != job.source_signature {
        return Err("OCR 任务与资产签名不一致，拒绝继续执行。".to_string());
    }
    if asset.status == OcrAssetStatus::Stale {
        return Err("OCR 源 PDF 已变化，请重新预检后创建任务。".to_string());
    }
    Ok(())
}

fn commit_completed_page(
    storage: &OcrStorage,
    asset: &mut OcrAssetRecord,
    job: &mut OcrJobRecord,
    page: u32,
) -> Result<(), String> {
    if !job.completed_pages.contains(&page) {
        job.completed_pages.push(page);
        job.completed_pages.sort_unstable();
    }
    if !asset.covered_pages.contains(&page) {
        asset.covered_pages.push(page);
        asset.covered_pages.sort_unstable();
    }
    job.failed_pages.retain(|failed| failed.page != page);
    job.progress = job.completed_pages.len() as f32 / job.target_pages.len().max(1) as f32;
    job.updated_at = unix_timestamp_string();
    asset.updated_at = job.updated_at.clone();
    storage.upsert_asset(asset)?;
    persist_job(storage, job)
}

fn upsert_failed_page(job: &mut OcrJobRecord, page: u32, attempts: u32, error: &str) {
    job.failed_pages.retain(|failed| failed.page != page);
    job.failed_pages.push(OcrFailedPage {
        page,
        attempts,
        error: error.to_string(),
    });
    job.failed_pages.sort_by_key(|failed| failed.page);
}

fn pause_job(storage: &OcrStorage, job: &mut OcrJobRecord, message: &str) -> Result<(), String> {
    job.status = OcrJobStatus::Paused;
    job.cancel_requested = false;
    job.last_error = Some(message.to_string());
    job.updated_at = unix_timestamp_string();
    persist_job(storage, job)
}

fn persist_job(storage: &OcrStorage, job: &OcrJobRecord) -> Result<(), String> {
    storage.upsert_job(job)
}

fn emit_progress(
    job: &OcrJobRecord,
    current_page: Option<u32>,
    emit: &mut impl FnMut(OcrProgressEvent),
) {
    emit(OcrProgressEvent {
        job_id: job.job_id.clone(),
        asset_id: job.asset_id.clone(),
        stage: job.stage,
        status: job.status,
        current_page,
        completed_pages: job.completed_pages.len(),
        total_pages: job.target_pages.len(),
        failed_pages: job.failed_pages.len(),
        progress: job.progress,
        pages_per_minute: None,
        message: match job.status {
            OcrJobStatus::Paused => "OCR 任务已暂停。",
            OcrJobStatus::Completed => "OCR 任务已完成。",
            OcrJobStatus::Failed => "OCR 任务存在失败页。",
            _ => "OCR 页面处理进度已更新。",
        }
        .to_string(),
    });
}

#[cfg(test)]
mod tests {
    use super::super::types::{OcrRect, OcrRegion, OcrRegionKind};
    use super::*;
    use std::collections::HashMap;

    struct FakeBackend {
        calls: Vec<u32>,
        failures_before_success: HashMap<u32, u32>,
        saw_cache: bool,
    }

    impl OcrBackend for FakeBackend {
        fn model_version(&self) -> &str {
            "fake-v1"
        }

        fn process_page(
            &mut self,
            _source_path: &Path,
            page: u32,
            cached_raw: Option<&Value>,
        ) -> Result<OcrPageOutput, String> {
            self.calls.push(page);
            self.saw_cache |= cached_raw.is_some();
            let remaining = self.failures_before_success.entry(page).or_default();
            if *remaining > 0 {
                *remaining -= 1;
                return Err("模拟识别失败".to_string());
            }
            let mut layout = OcrPageLayout::new("待覆盖", page, 1000.0, 1400.0, 0, "now");
            layout.regions.push(OcrRegion {
                region_id: format!("page-{page}"),
                kind: OcrRegionKind::Body,
                label: "content".to_string(),
                bounds: OcrRect {
                    x: 0.1,
                    y: 0.1,
                    width: 0.8,
                    height: 0.8,
                },
                confidence: 0.9,
                order: 0,
                column: None,
                lines: Vec::new(),
            });
            Ok(OcrPageOutput {
                raw_payload: serde_json::json!({ "page": page }),
                layout,
            })
        }
    }

    fn fixture() -> (OcrStorage, OcrAssetRecord, OcrJobRecord) {
        let root = std::env::temp_dir().join(format!("ra-ocr-pipeline-{}", uuid::Uuid::new_v4()));
        let storage = OcrStorage::from_root(root.clone()).expect("应初始化测试存储");
        let source = root.join("source.pdf");
        std::fs::write(&source, b"pdf").expect("应创建源文件");
        let now = unix_timestamp_string();
        let asset = OcrAssetRecord {
            asset_id: "ocr-test".to_string(),
            paper_id: None,
            source_path: source.to_string_lossy().to_string(),
            source_signature: "sig".to_string(),
            sidecar_root: storage
                .sidecar_root
                .join("ocr-test")
                .to_string_lossy()
                .to_string(),
            model_version: "fake-v1".to_string(),
            page_count: 3,
            covered_pages: Vec::new(),
            status: OcrAssetStatus::Pending,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        let job = OcrJobRecord {
            job_id: "job-test".to_string(),
            asset_id: asset.asset_id.clone(),
            source_path: asset.source_path.clone(),
            source_signature: asset.source_signature.clone(),
            target_pages: vec![1, 2],
            completed_pages: Vec::new(),
            failed_pages: Vec::new(),
            stage: OcrJobStage::Preflight,
            status: OcrJobStatus::Queued,
            progress: 0.0,
            cancel_requested: false,
            last_error: None,
            started_at: None,
            updated_at: now,
        };
        storage.upsert_asset(&asset).expect("应先保存测试资产");
        (storage, asset, job)
    }

    #[test]
    fn sidecar_提交后才记录完成页且恢复时跳过健康页() {
        let (storage, mut asset, mut job) = fixture();
        let mut backend = FakeBackend {
            calls: Vec::new(),
            failures_before_success: HashMap::new(),
            saw_cache: false,
        };
        run_job(
            &storage,
            &mut asset,
            &mut job,
            &mut backend,
            || false,
            |_| {},
        )
        .expect("首次任务应完成");
        assert_eq!(backend.calls, vec![1, 2]);
        assert_eq!(job.completed_pages, vec![1, 2]);
        job.status = OcrJobStatus::Paused;
        run_job(
            &storage,
            &mut asset,
            &mut job,
            &mut backend,
            || false,
            |_| {},
        )
        .expect("恢复任务应跳过健康页");
        assert_eq!(backend.calls, vec![1, 2]);
    }

    #[test]
    fn 失败页会重试并保留最终错误() {
        let (storage, mut asset, mut job) = fixture();
        let mut backend = FakeBackend {
            calls: Vec::new(),
            failures_before_success: HashMap::from([(2, 3)]),
            saw_cache: false,
        };
        run_job(
            &storage,
            &mut asset,
            &mut job,
            &mut backend,
            || false,
            |_| {},
        )
        .expect("任务状态应可靠落盘");
        assert_eq!(job.completed_pages, vec![1]);
        assert_eq!(job.failed_pages[0].page, 2);
        assert_eq!(job.failed_pages[0].attempts, 3);
        assert_eq!(job.status, OcrJobStatus::Failed);

        backend.failures_before_success.insert(2, 0);
        run_job(
            &storage,
            &mut asset,
            &mut job,
            &mut backend,
            || false,
            |_| {},
        )
        .expect("恢复后应允许再次重试失败页");
        assert_eq!(job.completed_pages, vec![1, 2]);
        assert!(job.failed_pages.is_empty());
        assert_eq!(job.status, OcrJobStatus::Completed);
    }

    #[test]
    fn 取消只在页面边界暂停并保留已完成页() {
        let (storage, mut asset, mut job) = fixture();
        let mut backend = FakeBackend {
            calls: Vec::new(),
            failures_before_success: HashMap::new(),
            saw_cache: false,
        };
        let mut checks = 0;
        run_job(
            &storage,
            &mut asset,
            &mut job,
            &mut backend,
            || {
                checks += 1;
                checks > 1
            },
            |_| {},
        )
        .expect("取消应安全收敛");
        assert_eq!(backend.calls, vec![1]);
        assert_eq!(job.completed_pages, vec![1]);
        assert_eq!(job.status, OcrJobStatus::Paused);
    }

    #[test]
    fn 原始缓存与版面_sidecar_相互独立() {
        let (storage, mut asset, mut job) = fixture();
        storage
            .write_raw_page_cache(
                &asset.asset_id,
                &OcrRawPageCache {
                    schema_version: OCR_RAW_CACHE_SCHEMA_VERSION,
                    source_signature: asset.source_signature.clone(),
                    model_version: "fake-v1".to_string(),
                    page: 1,
                    payload: serde_json::json!({ "cached": true }),
                },
            )
            .expect("应写入原始缓存");
        let mut backend = FakeBackend {
            calls: Vec::new(),
            failures_before_success: HashMap::new(),
            saw_cache: false,
        };
        run_job(
            &storage,
            &mut asset,
            &mut job,
            &mut backend,
            || false,
            |_| {},
        )
        .expect("任务应完成");
        assert!(backend.saw_cache);
        assert!(storage
            .read_current_page_layout("ocr-test", 1, "sig", "fake-v1")
            .expect("应读取 Sidecar")
            .is_some());
    }
}
