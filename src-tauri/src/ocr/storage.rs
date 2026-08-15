use super::types::{
    OcrAssetRecord, OcrAssetStatus, OcrJobRecord, OcrJobStatus, OcrPageLayout, OcrRawPageCache,
    OCR_RAW_CACHE_SCHEMA_VERSION,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const OCR_DATABASE_VERSION: i64 = 1;
const FNV1A64_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
const FNV1A64_PRIME: u64 = 0x00000100000001b3;

fn fnv1a64_update(mut state: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        state ^= u64::from(*byte);
        state = state.wrapping_mul(FNV1A64_PRIME);
    }
    state
}

#[derive(Clone, Debug)]
pub struct OcrStorage {
    pub root: PathBuf,
    pub runtime_root: PathBuf,
    pub raw_cache_root: PathBuf,
    pub sidecar_root: PathBuf,
    database_path: PathBuf,
}

impl OcrStorage {
    pub fn from_app(app: &AppHandle) -> Result<Self, String> {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        Self::from_root(app_data.join("ocr"))
    }

    pub fn from_root(root: PathBuf) -> Result<Self, String> {
        let storage = Self {
            runtime_root: root.join("runtime"),
            raw_cache_root: root.join("cache").join("ocr"),
            sidecar_root: root.join("sidecars"),
            database_path: root.join("ocr.sqlite3"),
            root,
        };
        storage.initialize()?;
        Ok(storage)
    }

    pub fn initialize(&self) -> Result<(), String> {
        fs::create_dir_all(&self.runtime_root).map_err(|error| error.to_string())?;
        fs::create_dir_all(&self.raw_cache_root).map_err(|error| error.to_string())?;
        fs::create_dir_all(&self.sidecar_root).map_err(|error| error.to_string())?;
        self.open_database().map(|_| ())
    }

    pub fn source_signature(source_path: &Path) -> Result<String, String> {
        let file = File::open(source_path).map_err(|error| error.to_string())?;
        let mut reader = BufReader::with_capacity(1024 * 1024, file);
        let mut fingerprint = FNV1A64_OFFSET_BASIS;
        let mut buffer = vec![0u8; 1024 * 1024];
        loop {
            let read = reader
                .read(&mut buffer)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            fingerprint = fnv1a64_update(fingerprint, &buffer[..read]);
        }
        Ok(format!("fnv1a64-{fingerprint:016x}"))
    }

    pub fn asset_id(source_path: &Path) -> Result<String, String> {
        let canonical = source_path
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let normalized = canonical
            .to_string_lossy()
            .replace('\\', "/")
            .to_lowercase();
        let fingerprint = fnv1a64_update(FNV1A64_OFFSET_BASIS, normalized.as_bytes());
        Ok(format!("ocr-{fingerprint:016x}"))
    }

    pub fn upsert_asset(&self, record: &OcrAssetRecord) -> Result<(), String> {
        let serialized = serde_json::to_string(record).map_err(|error| error.to_string())?;
        self.open_database()?
            .execute(
                "INSERT INTO ocr_assets (asset_id, source_path, source_signature, status, record_json, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(asset_id) DO UPDATE SET
                   source_path = excluded.source_path,
                   source_signature = excluded.source_signature,
                   status = excluded.status,
                   record_json = excluded.record_json,
                   updated_at = excluded.updated_at",
                params![
                    record.asset_id,
                    record.source_path,
                    record.source_signature,
                    format!("{:?}", record.status).to_ascii_lowercase(),
                    serialized,
                    record.updated_at
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn read_asset(&self, asset_id: &str) -> Result<Option<OcrAssetRecord>, String> {
        let serialized = self
            .open_database()?
            .query_row(
                "SELECT record_json FROM ocr_assets WHERE asset_id = ?1",
                params![asset_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        deserialize_optional(serialized)
    }

    pub fn list_assets(&self) -> Result<Vec<OcrAssetRecord>, String> {
        self.list_records("SELECT record_json FROM ocr_assets ORDER BY updated_at DESC")
    }

    pub fn upsert_job(&self, record: &OcrJobRecord) -> Result<(), String> {
        let serialized = serde_json::to_string(record).map_err(|error| error.to_string())?;
        self.open_database()?
            .execute(
                "INSERT INTO ocr_jobs (job_id, asset_id, status, stage, record_json, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(job_id) DO UPDATE SET
                   asset_id = excluded.asset_id,
                   status = excluded.status,
                   stage = excluded.stage,
                   record_json = excluded.record_json,
                   updated_at = excluded.updated_at",
                params![
                    record.job_id,
                    record.asset_id,
                    format!("{:?}", record.status).to_ascii_lowercase(),
                    format!("{:?}", record.stage).to_ascii_lowercase(),
                    serialized,
                    record.updated_at
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn read_job(&self, job_id: &str) -> Result<Option<OcrJobRecord>, String> {
        let serialized = self
            .open_database()?
            .query_row(
                "SELECT record_json FROM ocr_jobs WHERE job_id = ?1",
                params![job_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        deserialize_optional(serialized)
    }

    pub fn list_jobs(&self) -> Result<Vec<OcrJobRecord>, String> {
        self.list_records("SELECT record_json FROM ocr_jobs ORDER BY updated_at DESC")
    }

    pub fn recover_running_jobs(&self) -> Result<Vec<OcrJobRecord>, String> {
        let mut recovered = Vec::new();
        for mut job in self.list_jobs()? {
            if job.status != OcrJobStatus::Running {
                continue;
            }
            job.status = OcrJobStatus::Paused;
            job.cancel_requested = false;
            job.last_error =
                Some("桌面端上次在 OCR 任务运行时退出，任务已安全暂停，可继续恢复。".to_string());
            job.updated_at = unix_timestamp_string();
            self.upsert_job(&job)?;
            recovered.push(job);
        }
        Ok(recovered)
    }

    pub fn write_page_layout(
        &self,
        asset_id: &str,
        layout: &mut OcrPageLayout,
    ) -> Result<PathBuf, String> {
        validate_opaque_id(asset_id)?;
        layout.normalize_and_validate()?;
        let directory = self.sidecar_root.join(asset_id);
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let target = directory.join(format!("page-{:06}.json", layout.page));
        write_json_atomically(&target, layout)?;
        Ok(target)
    }

    pub fn read_page_layout(
        &self,
        asset_id: &str,
        page: u32,
        expected_signature: &str,
    ) -> Result<Option<OcrPageLayout>, String> {
        validate_opaque_id(asset_id)?;
        if page == 0 {
            return Err("OCR 页码必须从 1 开始。".to_string());
        }
        let target = self
            .sidecar_root
            .join(asset_id)
            .join(format!("page-{page:06}.json"));
        if !target.exists() {
            return Ok(None);
        }
        let mut layout: OcrPageLayout = read_json(&target)?;
        layout.normalize_and_validate()?;
        if layout.source_signature != expected_signature {
            return Ok(None);
        }
        Ok(Some(layout))
    }

    pub fn read_current_page_layout(
        &self,
        asset_id: &str,
        page: u32,
        expected_signature: &str,
        expected_model_version: &str,
    ) -> Result<Option<OcrPageLayout>, String> {
        let layout = self.read_page_layout(asset_id, page, expected_signature)?;
        Ok(layout.filter(|layout| layout.model_version == expected_model_version))
    }

    pub fn write_raw_page_cache(
        &self,
        asset_id: &str,
        cache: &OcrRawPageCache,
    ) -> Result<PathBuf, String> {
        validate_opaque_id(asset_id)?;
        if cache.schema_version != OCR_RAW_CACHE_SCHEMA_VERSION || cache.page == 0 {
            return Err("OCR 原始页面缓存版本或页码无效。".to_string());
        }
        let directory = self.raw_cache_root.join(asset_id);
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let target = directory.join(format!("page-{:06}.json", cache.page));
        write_json_atomically(&target, cache)?;
        Ok(target)
    }

    pub fn read_raw_page_cache(
        &self,
        asset_id: &str,
        page: u32,
        expected_signature: &str,
        expected_model_version: &str,
    ) -> Result<Option<OcrRawPageCache>, String> {
        validate_opaque_id(asset_id)?;
        if page == 0 {
            return Err("OCR 页码必须从 1 开始。".to_string());
        }
        let target = self
            .raw_cache_root
            .join(asset_id)
            .join(format!("page-{page:06}.json"));
        if !target.exists() {
            return Ok(None);
        }
        let cache: OcrRawPageCache = read_json(&target)?;
        if cache.schema_version != OCR_RAW_CACHE_SCHEMA_VERSION
            || cache.source_signature != expected_signature
            || cache.model_version != expected_model_version
            || cache.page != page
        {
            return Ok(None);
        }
        Ok(Some(cache))
    }

    pub fn mark_stale_assets(&self) -> Result<Vec<OcrAssetRecord>, String> {
        let mut stale = Vec::new();
        for mut asset in self.list_assets()? {
            let signature = Self::source_signature(Path::new(&asset.source_path));
            if signature.as_deref() == Ok(asset.source_signature.as_str()) {
                continue;
            }
            asset.status = OcrAssetStatus::Stale;
            asset.updated_at = unix_timestamp_string();
            self.upsert_asset(&asset)?;
            stale.push(asset);
        }
        Ok(stale)
    }

    pub fn delete_asset(&self, asset_id: &str) -> Result<(), String> {
        validate_opaque_id(asset_id)?;
        let sidecar_directory = self.sidecar_root.join(asset_id);
        if sidecar_directory.exists() {
            let canonical_root = self
                .sidecar_root
                .canonicalize()
                .map_err(|error| error.to_string())?;
            let canonical_target = sidecar_directory
                .canonicalize()
                .map_err(|error| error.to_string())?;
            if canonical_target.parent() != Some(canonical_root.as_path()) {
                return Err("拒绝删除 OCR 根目录之外的数据。".to_string());
            }
            fs::remove_dir_all(&canonical_target).map_err(|error| error.to_string())?;
        }
        self.open_database()?
            .execute(
                "DELETE FROM ocr_assets WHERE asset_id = ?1",
                params![asset_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn list_records<T: DeserializeOwned>(&self, sql: &str) -> Result<Vec<T>, String> {
        let connection = self.open_database()?;
        let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        let mut records = Vec::new();
        for row in rows {
            let serialized = row.map_err(|error| error.to_string())?;
            records.push(serde_json::from_str(&serialized).map_err(|error| error.to_string())?);
        }
        Ok(records)
    }

    fn open_database(&self) -> Result<Connection, String> {
        fs::create_dir_all(&self.root).map_err(|error| error.to_string())?;
        let connection =
            Connection::open(&self.database_path).map_err(|error| error.to_string())?;
        connection
            .execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
            .map_err(|error| error.to_string())?;
        self.apply_migrations(&connection)?;
        Ok(connection)
    }

    fn apply_migrations(&self, connection: &Connection) -> Result<(), String> {
        let current = connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .map_err(|error| error.to_string())?;
        if current >= OCR_DATABASE_VERSION {
            return Ok(());
        }
        if self.database_path.exists()
            && self
                .database_path
                .metadata()
                .map(|value| value.len())
                .unwrap_or(0)
                > 0
        {
            let backup = self.root.join(format!(
                "ocr.sqlite3.before-v{OCR_DATABASE_VERSION}-{}.bak",
                unix_timestamp_string()
            ));
            fs::copy(&self.database_path, backup).map_err(|error| error.to_string())?;
        }
        let transaction = connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        if current < 1 {
            transaction
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS ocr_assets (
                       asset_id TEXT PRIMARY KEY,
                       source_path TEXT NOT NULL,
                       source_signature TEXT NOT NULL,
                       status TEXT NOT NULL,
                       record_json TEXT NOT NULL,
                       updated_at TEXT NOT NULL
                     );
                     CREATE TABLE IF NOT EXISTS ocr_jobs (
                       job_id TEXT PRIMARY KEY,
                       asset_id TEXT NOT NULL,
                       status TEXT NOT NULL,
                       stage TEXT NOT NULL,
                       record_json TEXT NOT NULL,
                       updated_at TEXT NOT NULL,
                       FOREIGN KEY(asset_id) REFERENCES ocr_assets(asset_id) ON DELETE CASCADE
                     );
                     CREATE INDEX IF NOT EXISTS idx_ocr_assets_source_path ON ocr_assets(source_path);
                     CREATE INDEX IF NOT EXISTS idx_ocr_jobs_asset_id ON ocr_jobs(asset_id);",
                )
                .map_err(|error| error.to_string())?;
        }
        transaction
            .pragma_update(None, "user_version", OCR_DATABASE_VERSION)
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }
}

fn deserialize_optional<T: DeserializeOwned>(
    serialized: Option<String>,
) -> Result<Option<T>, String> {
    serialized
        .map(|value| serde_json::from_str(&value).map_err(|error| error.to_string()))
        .transpose()
}

fn validate_opaque_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 96
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("OCR 资产 ID 无效。".to_string());
    }
    Ok(())
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn write_json_atomically(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "OCR 写入路径无父目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("sidecar"),
        uuid::Uuid::new_v4()
    ));
    let payload = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let mut file = File::create(&temporary).map_err(|error| error.to_string())?;
    file.write_all(&payload)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    if path.exists() {
        let previous = parent.join(format!(
            ".{}.previous",
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("sidecar")
        ));
        if previous.exists() {
            fs::remove_file(&previous).map_err(|error| error.to_string())?;
        }
        fs::rename(path, &previous).map_err(|error| error.to_string())?;
        if let Err(error) = fs::rename(&temporary, path) {
            let _ = fs::rename(&previous, path);
            return Err(error.to_string());
        }
        fs::remove_file(previous).map_err(|error| error.to_string())?;
    } else {
        fs::rename(&temporary, path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn unix_timestamp_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_storage() -> OcrStorage {
        let root = std::env::temp_dir().join(format!("ra-ocr-test-{}", uuid::Uuid::new_v4()));
        OcrStorage::from_root(root).expect("应创建测试 OCR 存储")
    }

    #[test]
    fn 数据库会使用数字迁移并恢复运行中任务() {
        let storage = temporary_storage();
        let asset = OcrAssetRecord {
            asset_id: "ocr-test".to_string(),
            paper_id: None,
            source_path: "paper.pdf".to_string(),
            source_signature: "sig".to_string(),
            sidecar_root: "ocr-test".to_string(),
            model_version: "model".to_string(),
            page_count: 1,
            covered_pages: Vec::new(),
            status: OcrAssetStatus::Pending,
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
        };
        storage.upsert_asset(&asset).expect("应保存资产");
        let job = OcrJobRecord {
            job_id: "job-test".to_string(),
            asset_id: asset.asset_id.clone(),
            source_path: asset.source_path.clone(),
            source_signature: asset.source_signature.clone(),
            target_pages: vec![1],
            completed_pages: vec![1],
            failed_pages: vec![super::super::types::OcrFailedPage {
                page: 2,
                attempts: 1,
                error: "测试失败页".to_string(),
            }],
            stage: super::super::types::OcrJobStage::Detect,
            status: OcrJobStatus::Running,
            progress: 0.2,
            cancel_requested: false,
            last_error: None,
            started_at: Some("1".to_string()),
            updated_at: "1".to_string(),
        };
        storage.upsert_job(&job).expect("应保存任务");
        let recovered = storage.recover_running_jobs().expect("应恢复任务");
        assert_eq!(recovered[0].status, OcrJobStatus::Paused);
        assert_eq!(recovered[0].completed_pages, vec![1]);
        assert_eq!(recovered[0].failed_pages[0].page, 2);
        assert_eq!(
            storage
                .open_database()
                .expect("应打开数据库")
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("应读取版本"),
            OCR_DATABASE_VERSION
        );
        fs::remove_dir_all(storage.root).expect("应清理测试目录");
    }

    #[test]
    fn 源文件变化后资产会被标记为过期() {
        let storage = temporary_storage();
        let source = storage.root.join("paper.pdf");
        fs::write(&source, b"first").expect("应创建源文件");
        let asset = OcrAssetRecord {
            asset_id: "ocr-stale".to_string(),
            paper_id: None,
            source_path: source.to_string_lossy().to_string(),
            source_signature: OcrStorage::source_signature(&source).expect("应计算签名"),
            sidecar_root: "ocr-stale".to_string(),
            model_version: "model".to_string(),
            page_count: 1,
            covered_pages: vec![1],
            status: OcrAssetStatus::Ready,
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
        };
        storage.upsert_asset(&asset).expect("应保存资产");
        fs::write(&source, b"second").expect("应修改源文件");

        let stale = storage.mark_stale_assets().expect("应检查失效资产");
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].status, OcrAssetStatus::Stale);
        fs::remove_dir_all(storage.root).expect("应清理测试目录");
    }

    #[test]
    fn sidecar_只在签名匹配时返回() {
        let storage = temporary_storage();
        let mut page = OcrPageLayout::new("signature-a", 1, 100.0, 200.0, 0, "1");
        storage
            .write_page_layout("ocr-test", &mut page)
            .expect("应写入 Sidecar");
        assert!(storage
            .read_page_layout("ocr-test", 1, "signature-a")
            .expect("应读取")
            .is_some());
        assert!(storage
            .read_page_layout("ocr-test", 1, "signature-b")
            .expect("应拒绝过期 Sidecar")
            .is_none());
        fs::remove_dir_all(storage.root).expect("应清理测试目录");
    }
}
