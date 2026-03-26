// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Instant, UNIX_EPOCH};
use tauri::{Emitter, State, Window};

mod cards;
mod encyclopedia;
mod mobile;
mod research_memory;
mod text_decode;
use cards::{CardSettings, KnowledgeCardDetail, KnowledgeCardSummary, SaveKnowledgeCardRequest};
use encyclopedia::TermLookupMode;
use research_memory::{
    ApplyReviewRequest, ComparePapersResult, DocumentResult, IdeaCandidate, IngestMode,
    PageVisualNoteResult, ResearchGraph, ResearchGraphEdgeDetail, ResearchGraphNodeDetail,
    ResearchIngestOptions, ResearchPaperRecord, ResearchSearchHit, ReviewRecord,
};
use text_decode::{decode_command_output, decode_text_bytes, read_text_file_auto};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileNode {
    pub id: String,
    pub name: String,
    pub path: String,
    pub type_name: String, // "file" or "folder"
    pub has_children: bool,
    pub children: Option<Vec<FileNode>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OllamaModel {
    pub name: String,
    pub size: u64,
    pub digest: String,
    pub details: serde_json::Value,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OllamaModelList {
    pub models: Vec<OllamaModel>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OllamaVersionInfo {
    pub version: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SystemOllamaInspection {
    pub app_path: Option<String>,
    pub app_version: Option<String>,
    pub service_path: Option<String>,
    pub service_reported_version: Option<String>,
    pub service_client_version: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct PrivateOllamaRuntimeInfo {
    pub executable_path: Option<String>,
    pub reported_version: Option<String>,
    pub client_version: Option<String>,
    pub runtime_root: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OllamaRuntimeProgress {
    pub status: String,
    pub total: Option<u64>,
    pub completed: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PullProgress {
    pub status: String,
    pub model_name: Option<String>,
    pub source_url: Option<String>,
    pub digest: Option<String>,
    pub total: Option<u64>,
    pub completed: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatStreamEvent {
    pub request_id: String,
    pub phase: String,
    pub reasoning: String,
    pub answer: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BriefProgressEvent {
    pub request_id: String,
    pub phase: String,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HfResolveResult {
    pub url: String,
    pub filename: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WorkspaceImportResult {
    pub source_path: String,
    pub workspace_path: String,
    pub ingest_path: String,
    pub tree: FileNode,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WorkspaceSnapshot {
    pub workspace_path: String,
    pub tree: FileNode,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ZoteroStorageCandidate {
    pub data_dir: String,
    pub storage_path: String,
    pub source: String,
    pub pdf_count: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ZoteroImportResult {
    pub source_storage_path: String,
    pub workspace_path: String,
    pub ingest_path: String,
    pub tree: FileNode,
    pub copied_pdfs: usize,
    pub skipped_existing: usize,
}

#[derive(Deserialize)]
struct HfApiResponse {
    siblings: Vec<HfSibling>,
}

#[derive(Deserialize)]
struct HfSibling {
    rfilename: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InferenceMode {
    SingleMm,
    DualPipeline,
}

impl Default for InferenceMode {
    fn default() -> Self {
        Self::SingleMm
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct InferenceSettings {
    pub mode: InferenceMode,
    #[serde(default = "default_thinking_enabled")]
    pub thinking_enabled: bool,
}

fn default_thinking_enabled() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ExplainPdfSelectionRequest {
    pub term: String,
    pub pdf_path: String,
    pub page: u32,
    pub model: String,
    #[serde(default)]
    pub mode: TermLookupMode,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ExplainPdfSelectionResult {
    pub term: String,
    pub plain_summary: String,
    pub source_title: Option<String>,
    pub source_url: Option<String>,
    pub source_provider: Option<String>,
    pub source_lang: Option<String>,
    pub source_extract: Option<String>,
    pub page_context_snippet: Option<String>,
    pub source_status: String,
    pub generated_at: String,
    pub lookup_mode: TermLookupMode,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TranslatePdfSelectionRequest {
    pub text: String,
    pub pdf_path: String,
    pub page: u32,
    pub model: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TranslatePdfSelectionResult {
    pub original_text: String,
    pub translated_text: String,
    pub page: u32,
    pub generated_at: String,
    pub model_used: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TranslatePdfPageRequest {
    pub pdf_path: String,
    pub page: u32,
    pub model: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TranslatePdfPageResult {
    pub page: u32,
    pub translated_markdown: String,
    pub source_text_length: usize,
    pub generated_at: String,
    pub model_used: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GenerateBriefReportRequest {
    pub request_id: String,
    pub paper_path: Option<String>,
    pub scope_paper: Option<String>,
    pub active_pdf_path: Option<String>,
    pub user_instruction: Option<String>,
    pub model: String,
}

impl Default for InferenceSettings {
    fn default() -> Self {
        Self {
            mode: InferenceMode::SingleMm,
            thinking_enabled: true,
        }
    }
}

pub struct InferenceSettingsState {
    settings: Mutex<InferenceSettings>,
}

impl InferenceSettingsState {
    pub fn new() -> Self {
        Self {
            settings: Mutex::new(InferenceSettings::default()),
        }
    }

    pub fn get(&self) -> Result<InferenceSettings, String> {
        self.settings
            .lock()
            .map(|guard| guard.clone())
            .map_err(|e| format!("Failed to lock inference settings: {}", e))
    }

    pub fn set_mode(&self, mode: InferenceMode) -> Result<InferenceSettings, String> {
        let mut guard = self
            .settings
            .lock()
            .map_err(|e| format!("Failed to lock inference settings: {}", e))?;
        guard.mode = mode;
        Ok(guard.clone())
    }

    pub fn set_thinking_enabled(&self, thinking_enabled: bool) -> Result<InferenceSettings, String> {
        let mut guard = self
            .settings
            .lock()
            .map_err(|e| format!("Failed to lock inference settings: {}", e))?;
        guard.thinking_enabled = thinking_enabled;
        Ok(guard.clone())
    }

    pub fn replace(&self, settings: InferenceSettings) -> Result<(), String> {
        let mut guard = self
            .settings
            .lock()
            .map_err(|e| format!("Failed to lock inference settings: {}", e))?;
        *guard = settings;
        Ok(())
    }
}

const MAX_PDF_PAGE_TEXT_CACHE_ENTRIES: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
struct PdfPageTextCacheSignature {
    file_len: u64,
    modified_unix_ms: u128,
}

#[derive(Clone, Debug)]
struct PdfPageTextCacheEntry {
    signature: PdfPageTextCacheSignature,
    text: String,
    last_access_tick: u64,
}

struct PdfPageTextCacheInner {
    entries: HashMap<String, PdfPageTextCacheEntry>,
    next_access_tick: u64,
}

pub struct PdfPageTextCacheState {
    inner: Mutex<PdfPageTextCacheInner>,
}

impl PdfPageTextCacheState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(PdfPageTextCacheInner {
                entries: HashMap::new(),
                next_access_tick: 1,
            }),
        }
    }

    fn build_key(path: &str, page: u32) -> String {
        format!("{}::{}", path, page)
    }

    fn next_tick(inner: &mut PdfPageTextCacheInner) -> u64 {
        let tick = inner.next_access_tick;
        inner.next_access_tick = inner.next_access_tick.saturating_add(1);
        tick
    }

    fn read_signature(path: &str) -> Result<PdfPageTextCacheSignature, String> {
        let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
        let modified_unix_ms = metadata
            .modified()
            .ok()
            .and_then(|timestamp| timestamp.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        Ok(PdfPageTextCacheSignature {
            file_len: metadata.len(),
            modified_unix_ms,
        })
    }

    fn get(&self, path: &str, page: u32) -> Result<Option<String>, String> {
        let signature = Self::read_signature(path)?;
        let key = Self::build_key(path, page);
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| format!("Failed to lock PDF page text cache: {}", e))?;

        let cached_text = match inner.entries.get(&key) {
            Some(entry) if entry.signature == signature => Some(entry.text.clone()),
            _ => None,
        };

        if cached_text.is_some() {
            let next_tick = Self::next_tick(&mut inner);
            if let Some(entry) = inner.entries.get_mut(&key) {
                entry.last_access_tick = next_tick;
            }
        }

        Ok(cached_text)
    }

    fn insert(&self, path: &str, page: u32, text: String) -> Result<(), String> {
        let signature = Self::read_signature(path)?;
        let key = Self::build_key(path, page);
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| format!("Failed to lock PDF page text cache: {}", e))?;

        let tick = Self::next_tick(&mut inner);
        inner.entries.insert(
            key,
            PdfPageTextCacheEntry {
                signature,
                text,
                last_access_tick: tick,
            },
        );

        while inner.entries.len() > MAX_PDF_PAGE_TEXT_CACHE_ENTRIES {
            let Some(oldest_key) = inner
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_access_tick)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            inner.entries.remove(&oldest_key);
        }

        Ok(())
    }
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! Greetings from Rust.", name)
}

#[tauri::command]
async fn scan_directory(path: String) -> Result<FileNode, String> {
    let root_path = Path::new(&path);
    if !root_path.exists() {
        return Err("Path does not exist.".to_string());
    }
    Ok(build_tree(root_path))
}

#[tauri::command]
async fn get_workspace_snapshot(app: AppHandle) -> Result<WorkspaceSnapshot, String> {
    let started = Instant::now();
    let workspace_root = workspace_root_dir(&app)?;
    let snapshot = WorkspaceSnapshot {
        workspace_path: workspace_root.to_string_lossy().to_string(),
        tree: build_tree_with_depth(&workspace_root, 2),
    };
    println!(
        "[startup] get_workspace_snapshot finished in {}ms",
        started.elapsed().as_millis()
    );
    Ok(snapshot)
}

#[tauri::command]
async fn list_directory_children(path: String) -> Result<Vec<FileNode>, String> {
    let started = Instant::now();
    let target = Path::new(&path);
    if !target.exists() {
        return Err("Path does not exist.".to_string());
    }
    if !target.is_dir() {
        return Err("Path is not a directory.".to_string());
    }
    let children = read_tree_children(target, 1);
    println!(
        "[startup] list_directory_children '{}' finished in {}ms",
        path,
        started.elapsed().as_millis()
    );
    println!(
        "[tree] list_directory_children '{}' -> count={} names={:?}",
        path,
        children.len(),
        children
            .iter()
            .map(|child| format!("{}:{}", child.type_name, child.name))
            .collect::<Vec<_>>()
    );
    Ok(children)
}

use tauri::{AppHandle, Manager, RunEvent};

fn is_hidden_path(path: &Path) -> bool {
    path.file_name()
        .map(|n| n.to_string_lossy().starts_with('.'))
        .unwrap_or(false)
}

fn has_visible_children(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return false;
    };

    for entry in entries.filter_map(|entry| entry.ok()) {
        let child = entry.path();
        if !is_hidden_path(&child) {
            return true;
        }
    }

    false
}

fn sort_tree_nodes(nodes: &mut [FileNode]) {
    nodes.sort_by(|a, b| match (a.type_name.as_str(), b.type_name.as_str()) {
        ("folder", "file") => std::cmp::Ordering::Less,
        ("file", "folder") => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
}

fn read_tree_children(path: &Path, depth: usize) -> Vec<FileNode> {
    let mut nodes = Vec::new();
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.filter_map(|e| e.ok()) {
            let child_path = entry.path();
            if is_hidden_path(&child_path) {
                continue;
            }
            nodes.push(build_tree_with_depth(&child_path, depth.saturating_sub(1)));
        }
    }
    sort_tree_nodes(&mut nodes);
    nodes
}

fn build_tree(path: &Path) -> FileNode {
    build_tree_with_depth(path, usize::MAX)
}

fn build_tree_with_depth(path: &Path, depth: usize) -> FileNode {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let is_dir = path.is_dir();
    let has_children = if is_dir { has_visible_children(path) } else { false };
    let children = if is_dir && depth > 0 {
        Some(read_tree_children(path, depth))
    } else {
        None
    };

    FileNode {
        id: path.to_string_lossy().to_string(),
        name: if name.is_empty() {
            path.to_string_lossy().to_string()
        } else {
            name
        },
        path: path.to_string_lossy().to_string(),
        type_name: if is_dir {
            "folder".to_string()
        } else {
            "file".to_string()
        },
        has_children,
        children,
    }
}

fn copy_directory_recursive(source_root: &Path, target_root: &Path) -> Result<(), String> {
    for entry in walkdir::WalkDir::new(source_root)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let src_path = entry.path();
        let rel = src_path
            .strip_prefix(source_root)
            .map_err(|e| e.to_string())?;
        let dst_path = target_root.join(rel);

        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&dst_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = dst_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(src_path, &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn unique_destination_path(target_root: &Path, source_path: &Path) -> PathBuf {
    let fallback_name = if source_path.is_dir() {
        "imported_folder"
    } else {
        "imported_file"
    };
    let file_name = source_path
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback_name);
    let initial = target_root.join(file_name);
    if !initial.exists() {
        return initial;
    }

    let name_path = Path::new(file_name);
    let stem = name_path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback_name);
    let extension = name_path.extension().and_then(|s| s.to_str());

    let mut index = 2usize;
    loop {
        let candidate_name = match extension {
            Some(ext) if !ext.is_empty() => format!("{} ({})", stem, index) + "." + ext,
            _ => format!("{} ({})", stem, index),
        };
        let candidate = target_root.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
        index += 1;
    }
}

fn copy_path_into_root(source_path: &Path, target_root: &Path) -> Result<(), String> {
    let destination = unique_destination_path(target_root, source_path);
    if source_path.is_dir() {
        std::fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
        copy_directory_recursive(source_path, &destination)?;
        return Ok(());
    }

    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(source_path, &destination).map_err(|e| {
        format!(
            "Failed to copy '{}' -> '{}': {}",
            source_path.display(),
            destination.display(),
            e
        )
    })?;
    Ok(())
}

fn workspace_root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !app_data_dir.exists() {
        std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    }

    let workspace_root = app_data_dir.join("workspace");
    if !workspace_root.exists() {
        std::fs::create_dir_all(&workspace_root).map_err(|e| e.to_string())?;
    }

    Ok(workspace_root)
}

fn zotero_import_manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !app_data_dir.exists() {
        std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    }
    Ok(app_data_dir.join("zotero_import_manifest.json"))
}

fn load_zotero_import_manifest(app: &AppHandle) -> Result<Vec<String>, String> {
    let manifest_path = zotero_import_manifest_path(app)?;
    if !manifest_path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
    serde_json::from_str::<Vec<String>>(&content).map_err(|e| e.to_string())
}

fn save_zotero_import_manifest(app: &AppHandle, entries: &[String]) -> Result<(), String> {
    let manifest_path = zotero_import_manifest_path(app)?;
    let payload = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    std::fs::write(manifest_path, payload).map_err(|e| e.to_string())
}

fn normalize_existing_path(path: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(path)
        .map_err(|e| format!("Failed to resolve path '{}': {}", path.display(), e))
}

fn ensure_path_within_workspace(path: &Path, workspace_root: &Path) -> Result<PathBuf, String> {
    let normalized_root = normalize_existing_path(workspace_root)?;
    let normalized_path = normalize_existing_path(path)?;
    if !normalized_path.starts_with(&normalized_root) {
        return Err("Path is outside the workspace.".to_string());
    }
    Ok(normalized_path)
}

fn ensure_non_root_workspace_path(path: &Path, workspace_root: &Path) -> Result<PathBuf, String> {
    let normalized_path = ensure_path_within_workspace(path, workspace_root)?;
    let normalized_root = normalize_existing_path(workspace_root)?;
    if normalized_path == normalized_root {
        return Err("Workspace root cannot be modified by this action.".to_string());
    }
    Ok(normalized_path)
}

#[cfg(target_os = "windows")]
fn to_windows_shell_path(path: &Path) -> String {
    let raw = path.to_string_lossy().to_string();
    if let Some(stripped) = raw.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", stripped);
    }
    if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        return stripped.to_string();
    }
    raw
}

fn validate_entry_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Name cannot be empty.".to_string());
    }
    let invalid_chars = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    if trimmed.chars().any(|ch| invalid_chars.contains(&ch)) {
        return Err("Name contains invalid path characters.".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("Reserved path names are not allowed.".to_string());
    }
    Ok(trimmed.to_string())
}

fn move_to_trash(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let shell_path = to_windows_shell_path(path);
        let escaped = shell_path.replace('\'', "''");
        let script = format!(
            "$ErrorActionPreference='Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; if (Test-Path -LiteralPath '{escaped}' -PathType Container) {{ [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('{escaped}', 'OnlyErrorDialogs', 'SendToRecycleBin') }} elseif (Test-Path -LiteralPath '{escaped}') {{ [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('{escaped}', 'OnlyErrorDialogs', 'SendToRecycleBin') }} else {{ throw 'Path does not exist.' }}"
        );
        let output = Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .output()
            .map_err(|e| format!("Failed to start recycle bin command: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let detail = if !stderr.is_empty() { stderr } else { stdout };
            return Err(format!("Failed to move item to recycle bin: {}", detail));
        }
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let escaped = path.to_string_lossy().replace('"', "\\\"");
        let script = format!("tell application \"Finder\" to delete POSIX file \"{}\"", escaped);
        Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| format!("Failed to move item to trash: {}", e))
            .and_then(|output| {
                if output.status.success() {
                    Ok(())
                } else {
                    Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
                }
            })?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        let output = Command::new("gio")
            .args(["trash", &path.to_string_lossy()])
            .output()
            .map_err(|e| format!("Failed to move item to trash: {}", e))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("Trash is not implemented on this platform.".to_string())
}

fn copy_workspace_entry_internal(source_path: &Path, target_dir_path: &Path) -> Result<FileNode, String> {
    let destination = unique_destination_path(target_dir_path, source_path);
    if source_path.is_dir() {
        std::fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
        copy_directory_recursive(source_path, &destination)?;
    } else {
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(source_path, &destination).map_err(|e| {
            format!(
                "Failed to copy '{}' -> '{}': {}",
                source_path.display(),
                destination.display(),
                e
            )
        })?;
    }

    Ok(build_tree_with_depth(&destination, 1))
}

#[tauri::command]
async fn create_workspace_folder(
    parent_path: String,
    name: String,
    app: AppHandle,
) -> Result<FileNode, String> {
    let workspace_root = workspace_root_dir(&app)?;
    let parent = ensure_path_within_workspace(Path::new(&parent_path), &workspace_root)?;
    if !parent.is_dir() {
        return Err("Parent path is not a directory.".to_string());
    }
    let validated_name = validate_entry_name(&name)?;
    let destination = parent.join(validated_name);
    if destination.exists() {
        return Err("A file or folder with the same name already exists.".to_string());
    }
    std::fs::create_dir_all(&destination).map_err(|e| {
        format!("Failed to create folder '{}': {}", destination.display(), e)
    })?;
    Ok(build_tree_with_depth(&destination, 1))
}

#[tauri::command]
async fn rename_workspace_entry(
    path: String,
    new_name: String,
    app: AppHandle,
) -> Result<FileNode, String> {
    let workspace_root = workspace_root_dir(&app)?;
    let source = ensure_non_root_workspace_path(Path::new(&path), &workspace_root)?;
    let validated_name = validate_entry_name(&new_name)?;
    let parent = source
        .parent()
        .ok_or_else(|| "Target does not have a parent directory.".to_string())?;
    let destination = parent.join(validated_name);
    if destination.exists() && destination != source {
        return Err("A file or folder with the same name already exists.".to_string());
    }
    std::fs::rename(&source, &destination).map_err(|e| {
        format!(
            "Failed to rename '{}' -> '{}': {}",
            source.display(),
            destination.display(),
            e
        )
    })?;
    Ok(build_tree_with_depth(&destination, 1))
}

#[tauri::command]
async fn trash_workspace_entry(path: String, app: AppHandle) -> Result<(), String> {
    let workspace_root = workspace_root_dir(&app)?;
    let target = ensure_non_root_workspace_path(Path::new(&path), &workspace_root)?;
    move_to_trash(&target)
}

#[tauri::command]
async fn copy_workspace_entry(
    source_path: String,
    target_dir_path: String,
    app: AppHandle,
) -> Result<FileNode, String> {
    let workspace_root = workspace_root_dir(&app)?;
    let source = ensure_non_root_workspace_path(Path::new(&source_path), &workspace_root)?;
    let target_dir = ensure_path_within_workspace(Path::new(&target_dir_path), &workspace_root)?;
    if !target_dir.is_dir() {
        return Err("Target path is not a directory.".to_string());
    }
    if source.is_dir() && target_dir.starts_with(&source) {
        return Err("Cannot copy a folder into itself.".to_string());
    }
    copy_workspace_entry_internal(&source, &target_dir)
}

#[tauri::command]
async fn move_workspace_entry(
    source_path: String,
    target_dir_path: String,
    app: AppHandle,
) -> Result<FileNode, String> {
    let workspace_root = workspace_root_dir(&app)?;
    let source = ensure_non_root_workspace_path(Path::new(&source_path), &workspace_root)?;
    let target_dir = ensure_path_within_workspace(Path::new(&target_dir_path), &workspace_root)?;
    if !target_dir.is_dir() {
        return Err("Target path is not a directory.".to_string());
    }
    if source.is_dir() && target_dir.starts_with(&source) {
        return Err("Cannot move a folder into itself.".to_string());
    }

    let destination = unique_destination_path(&target_dir, &source);
    match std::fs::rename(&source, &destination) {
        Ok(_) => Ok(build_tree_with_depth(&destination, 1)),
        Err(_) => {
            let copied = copy_workspace_entry_internal(&source, &target_dir)?;
            if source.is_dir() {
                std::fs::remove_dir_all(&source).map_err(|e| {
                    format!("Failed to remove moved source '{}': {}", source.display(), e)
                })?;
            } else {
                std::fs::remove_file(&source).map_err(|e| {
                    format!("Failed to remove moved source '{}': {}", source.display(), e)
                })?;
            }
            Ok(copied)
        }
    }
}

#[tauri::command]
async fn get_workspace_relative_path(path: String, app: AppHandle) -> Result<String, String> {
    let workspace_root = workspace_root_dir(&app)?;
    let normalized_root = normalize_existing_path(&workspace_root)?;
    let normalized_path = ensure_path_within_workspace(Path::new(&path), &workspace_root)?;
    let relative = normalized_path
        .strip_prefix(&normalized_root)
        .map_err(|e| e.to_string())?;
    let display = relative
        .iter()
        .map(|segment| segment.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/");
    Ok(if display.is_empty() { ".".to_string() } else { display })
}

fn decode_js_string(value: &str) -> String {
    let mut result = String::new();
    let mut escaped = false;
    for ch in value.chars() {
        if escaped {
            match ch {
                'n' => result.push('\n'),
                'r' => result.push('\r'),
                't' => result.push('\t'),
                '\\' => result.push('\\'),
                '"' => result.push('"'),
                other => result.push(other),
            }
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        result.push(ch);
    }
    result
}

fn parse_js_string_literal(input: &str) -> Option<(String, usize)> {
    if !input.starts_with('"') {
        return None;
    }

    let mut raw = String::new();
    let mut escaped = false;
    let mut consumed = 1;
    for ch in input[1..].chars() {
        consumed += ch.len_utf8();
        if escaped {
            raw.push('\\');
            raw.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            return Some((decode_js_string(&raw), consumed));
        }
        raw.push(ch);
    }
    None
}

fn extract_pref_string(prefs: &str, pref_key: &str) -> Option<String> {
    let key_marker = format!("\"{}\"", pref_key);
    for line in prefs.lines() {
        if !line.contains(&key_marker) {
            continue;
        }

        let marker_pos = line.find(&key_marker)?;
        let after_key = line[marker_pos + key_marker.len()..].trim_start();
        if !after_key.starts_with(',') {
            continue;
        }

        let value_start = after_key[1..].trim_start();
        if let Some((value, _)) = parse_js_string_literal(value_start) {
            if !value.trim().is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn zotero_default_data_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let home_path = PathBuf::from(home);
        dirs.push(home_path.join("Zotero"));
        dirs.push(home_path.join(".zotero").join("zotero"));
        dirs.push(
            home_path
                .join(".var")
                .join("app")
                .join("org.zotero.Zotero")
                .join(".zotero")
                .join("zotero"),
        );
        dirs.push(
            home_path
                .join("Library")
                .join("Application Support")
                .join("Zotero"),
        );
    }

    if let Some(appdata) = std::env::var_os("APPDATA") {
        let appdata_path = PathBuf::from(appdata);
        dirs.push(appdata_path.join("Zotero"));
        dirs.push(appdata_path.join("Zotero").join("Zotero"));
    }

    if let Some(custom) = std::env::var_os("ZOTERO_DATA_DIR") {
        dirs.push(PathBuf::from(custom));
    }

    dirs
}

fn zotero_profile_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Some(appdata) = std::env::var_os("APPDATA") {
        let appdata_path = PathBuf::from(appdata);
        roots.push(appdata_path.join("Zotero"));
        roots.push(appdata_path.join("Zotero").join("Zotero"));
    }

    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home_path = PathBuf::from(home);
        roots.push(home_path.join(".zotero").join("zotero"));
        roots.push(
            home_path
                .join(".var")
                .join("app")
                .join("org.zotero.Zotero")
                .join(".zotero")
                .join("zotero"),
        );
        roots.push(
            home_path
                .join("Library")
                .join("Application Support")
                .join("Zotero"),
        );
    }

    roots
}

fn collect_zotero_data_dirs_from_profiles(profile_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for profile_root in profile_roots {
        if !profile_root.exists() {
            continue;
        }

        for entry in walkdir::WalkDir::new(profile_root)
            .max_depth(7)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            if entry.file_name().to_string_lossy().to_lowercase() != "prefs.js" {
                continue;
            }

            if let Ok(content) = read_text_file_auto(entry.path()) {
                if let Some(data_dir) = extract_pref_string(&content, "extensions.zotero.dataDir") {
                    dirs.push(PathBuf::from(data_dir));
                }
            }
        }
    }
    dirs
}

fn count_pdf_files(root: &Path) -> usize {
    walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|entry| {
            if !entry.file_type().is_file() {
                return false;
            }
            entry
                .path()
                .extension()
                .map(|ext| ext.to_string_lossy().to_lowercase() == "pdf")
                .unwrap_or(false)
        })
        .count()
}

fn collect_storage_candidates(input: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![input.join("storage"), input.to_path_buf()];

    if input
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase() != "storage")
        .unwrap_or(true)
    {
        if let Some(parent) = input.parent() {
            if parent
                .file_name()
                .map(|name| name.to_string_lossy().to_lowercase() == "storage")
                .unwrap_or(false)
            {
                candidates.push(parent.to_path_buf());
            }
        }
    }

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|path| {
            let key = path.to_string_lossy().to_lowercase();
            seen.insert(key)
        })
        .collect()
}

fn best_pdf_source_dir(input: &Path) -> Option<(PathBuf, usize)> {
    let mut best: Option<(PathBuf, usize)> = None;
    for candidate in collect_storage_candidates(input) {
        if !candidate.exists() || !candidate.is_dir() {
            continue;
        }
        let pdf_count = count_pdf_files(&candidate);
        if pdf_count == 0 {
            continue;
        }

        match &best {
            Some((_, best_count)) if *best_count >= pdf_count => {}
            _ => best = Some((candidate, pdf_count)),
        }
    }
    best
}

fn resolve_import_storage_source(input: &Path) -> Result<PathBuf, String> {
    if let Some((best, _)) = best_pdf_source_dir(input) {
        return Ok(best);
    }

    let direct_storage = input.join("storage");
    if direct_storage.exists() && direct_storage.is_dir() {
        return Ok(direct_storage);
    }

    if input.exists() && input.is_dir() {
        return Ok(input.to_path_buf());
    }

    Err("Selected folder is not a Zotero data dir or storage dir.".to_string())
}

#[tauri::command]
async fn detect_zotero_storage() -> Result<Vec<ZoteroStorageCandidate>, String> {
    let mut raw_candidates: Vec<(PathBuf, String)> = zotero_default_data_dirs()
        .into_iter()
        .map(|path| (path, "default_data_dir".to_string()))
        .collect();

    for dir in collect_zotero_data_dirs_from_profiles(&zotero_profile_roots()) {
        raw_candidates.push((dir, "prefs_data_dir".to_string()));
    }

    let mut seen = HashSet::new();
    let mut result = Vec::new();

    for (data_dir, source) in raw_candidates {
        let Some((storage_path, pdf_count)) = best_pdf_source_dir(&data_dir) else {
            continue;
        };
        let normalized_storage = storage_path.to_string_lossy().to_lowercase();
        if !seen.insert(normalized_storage) {
            continue;
        }

        result.push(ZoteroStorageCandidate {
            data_dir: data_dir.to_string_lossy().to_string(),
            storage_path: storage_path.to_string_lossy().to_string(),
            source,
            pdf_count,
        });
    }

    result.sort_by(|a, b| b.pdf_count.cmp(&a.pdf_count));
    Ok(result)
}

#[tauri::command]
async fn import_zotero_storage_to_workspace(
    source_storage: Option<String>,
    source_storage_path: Option<String>,
    mode: Option<IngestMode>,
    app: AppHandle,
) -> Result<ZoteroImportResult, String> {
    let source_raw = source_storage_path
        .or(source_storage)
        .ok_or_else(|| "Missing Zotero source path argument.".to_string())?;
    let source_input = PathBuf::from(source_raw.trim());
    if !source_input.exists() {
        return Err("Zotero path does not exist.".to_string());
    }
    if !source_input.is_dir() {
        return Err("Zotero path must be a folder.".to_string());
    }

    let storage_root = resolve_import_storage_source(&source_input)?;
    if !storage_root.exists() || !storage_root.is_dir() {
        return Err("Selected folder is not a Zotero data dir or storage dir.".to_string());
    }

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !app_data_dir.exists() {
        std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    }

    let workspace_root = app_data_dir.join("workspace");
    if !workspace_root.exists() {
        std::fs::create_dir_all(&workspace_root).map_err(|e| e.to_string())?;
    }

    let target_root = workspace_root.clone();
    let legacy_target_root = workspace_root.join("zotero_storage");
    let selected_mode = mode.unwrap_or_default();
    if selected_mode == IngestMode::Overwrite {
        for previous in load_zotero_import_manifest(&app)? {
            let previous_path = PathBuf::from(previous);
            if previous_path.exists() && previous_path.is_file() {
                let _ = std::fs::remove_file(previous_path);
            }
        }
        if legacy_target_root.exists() {
            if legacy_target_root.is_dir() {
                let _ = std::fs::remove_dir_all(&legacy_target_root);
            } else {
                let _ = std::fs::remove_file(&legacy_target_root);
            }
        }
        save_zotero_import_manifest(&app, &[])?;
    }

    let mut copied_pdfs = 0usize;
    let mut skipped_existing = 0usize;
    let mut imported_paths = Vec::new();
    for entry in walkdir::WalkDir::new(&storage_root)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }

        let is_pdf = entry
            .path()
            .extension()
            .map(|ext| ext.to_string_lossy().to_lowercase() == "pdf")
            .unwrap_or(false);
        if !is_pdf {
            continue;
        }

        let preferred_dst = target_root.join(
            entry
                .path()
                .file_name()
                .ok_or_else(|| "PDF file name is missing.".to_string())?,
        );

        if selected_mode == IngestMode::Incremental && preferred_dst.exists() {
            skipped_existing += 1;
            continue;
        }

        let dst = unique_destination_path(&target_root, entry.path());

        std::fs::copy(entry.path(), &dst).map_err(|e| {
            format!(
                "Failed to copy '{}' -> '{}': {}",
                entry.path().display(),
                dst.display(),
                e
            )
        })?;
        copied_pdfs += 1;
        imported_paths.push(dst.to_string_lossy().to_string());
    }

    if copied_pdfs == 0 && skipped_existing == 0 {
        return Err("No PDF files found in Zotero storage.".to_string());
    }

    save_zotero_import_manifest(&app, &imported_paths)?;

    let tree = build_tree_with_depth(&workspace_root, 2);
    Ok(ZoteroImportResult {
        source_storage_path: storage_root.to_string_lossy().to_string(),
        workspace_path: workspace_root.to_string_lossy().to_string(),
        ingest_path: workspace_root.to_string_lossy().to_string(),
        tree,
        copied_pdfs,
        skipped_existing,
    })
}

#[tauri::command]
async fn import_directory_to_workspace(
    source_path: String,
    mode: Option<IngestMode>,
    app: AppHandle,
) -> Result<WorkspaceImportResult, String> {
    let source_root = PathBuf::from(&source_path);
    if !source_root.exists() {
        return Err("Selected source folder does not exist.".to_string());
    }
    if !source_root.is_dir() {
        return Err("Selected path is not a folder.".to_string());
    }

    let workspace_root = workspace_root_dir(&app)?;

    let folder_name = source_root
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("imported_folder");
    let target_root = workspace_root.join(folder_name);
    let selected_mode = mode.unwrap_or_default();

    match selected_mode {
        IngestMode::Overwrite => {
            if target_root.exists() {
                if target_root.is_dir() {
                    std::fs::remove_dir_all(&target_root).map_err(|e| e.to_string())?;
                } else {
                    std::fs::remove_file(&target_root).map_err(|e| e.to_string())?;
                }
            }
            std::fs::create_dir_all(&target_root).map_err(|e| e.to_string())?;
            copy_directory_recursive(&source_root, &target_root)?;
        }
        IngestMode::Incremental => {
            if !target_root.exists() {
                std::fs::create_dir_all(&target_root).map_err(|e| e.to_string())?;
            }
            copy_directory_recursive(&source_root, &target_root)?;
        }
    }

    let tree = build_tree_with_depth(&workspace_root, 2);
    Ok(WorkspaceImportResult {
        source_path: source_root.to_string_lossy().to_string(),
        workspace_path: workspace_root.to_string_lossy().to_string(),
        ingest_path: target_root.to_string_lossy().to_string(),
        tree,
    })
}

#[tauri::command]
async fn import_paths_to_workspace(
    source_paths: Vec<String>,
    mode: Option<IngestMode>,
    app: AppHandle,
) -> Result<WorkspaceImportResult, String> {
    if source_paths.is_empty() {
        return Err("No files or folders selected.".to_string());
    }

    let workspace_root = workspace_root_dir(&app)?;

    let target_root = workspace_root.join("selected_imports");
    let selected_mode = mode.unwrap_or_default();
    if selected_mode == IngestMode::Overwrite && target_root.exists() {
        if target_root.is_dir() {
            std::fs::remove_dir_all(&target_root).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_file(&target_root).map_err(|e| e.to_string())?;
        }
    }
    if !target_root.exists() {
        std::fs::create_dir_all(&target_root).map_err(|e| e.to_string())?;
    }

    for source_raw in &source_paths {
        let source = PathBuf::from(source_raw.trim());
        if !source.exists() {
            return Err(format!(
                "Selected path does not exist: {}",
                source.display()
            ));
        }
        copy_path_into_root(&source, &target_root)?;
    }

    let tree = build_tree_with_depth(&workspace_root, 2);
    Ok(WorkspaceImportResult {
        source_path: source_paths.join("; "),
        workspace_path: workspace_root.to_string_lossy().to_string(),
        ingest_path: target_root.to_string_lossy().to_string(),
        tree,
    })
}

fn inference_settings_file_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !app_data_dir.exists() {
        std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    }
    Ok(app_data_dir.join("inference_settings.json"))
}

fn load_inference_settings_from_disk(app: &AppHandle) -> Result<InferenceSettings, String> {
    let path = inference_settings_file_path(app)?;
    if !path.exists() {
        return Ok(InferenceSettings::default());
    }

    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str::<InferenceSettings>(&content).map_err(|e| e.to_string())
}

fn save_inference_settings_to_disk(
    app: &AppHandle,
    settings: &InferenceSettings,
) -> Result<(), String> {
    let path = inference_settings_file_path(app)?;
    let content = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_inference_settings(
    state: State<'_, InferenceSettingsState>,
) -> Result<InferenceSettings, String> {
    state.get()
}

#[tauri::command]
async fn set_inference_mode(
    mode: InferenceMode,
    state: State<'_, InferenceSettingsState>,
    app: AppHandle,
) -> Result<InferenceSettings, String> {
    let updated = state.set_mode(mode)?;
    save_inference_settings_to_disk(&app, &updated)?;
    Ok(updated)
}

#[tauri::command]
async fn set_thinking_enabled(
    thinking_enabled: bool,
    state: State<'_, InferenceSettingsState>,
    app: AppHandle,
) -> Result<InferenceSettings, String> {
    let updated = state.set_thinking_enabled(thinking_enabled)?;
    save_inference_settings_to_disk(&app, &updated)?;
    Ok(updated)
}

fn reveal_path_in_explorer(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("explorer")
            .args(["/select,", path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .args(["-R", path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        // Try dbus or xdg-open (xdg-open usually opens the file, not folder)
        // For now, just open the parent folder
        use std::process::Command;
        if let Some(parent) = std::path::Path::new(path).parent() {
            Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn reveal_in_explorer(path: String) -> Result<(), String> {
    reveal_path_in_explorer(&path)
}

fn open_path_in_os(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("cmd")
            .args(["/C", "start", "", path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn open_file(path: String) -> Result<(), String> {
    open_path_in_os(&path)
}

#[tauri::command]
async fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
async fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

const MAX_PDF_SELECTION_TRANSLATE_CHARS: usize = 2400;
const PDF_SELECTION_CONTEXT_LIMIT_SHORT: usize = 2200;
const PDF_SELECTION_CONTEXT_LIMIT_LONG: usize = 4200;
const LONG_SELECTION_THRESHOLD_CHARS: usize = 220;
const TRANSLATION_OUTPUT_SENTINEL: &str = "[[[TRANSLATION]]]";

fn normalize_extracted_pdf_text(text: &str) -> String {
    text.lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_pdf_page_text_uncached(path: &str, page: u32) -> Result<String, String> {
    let doc = lopdf::Document::load(path).map_err(|e| e.to_string())?;
    let pages = doc.get_pages();
    if !pages.contains_key(&page) {
        return Err(format!("Page {} not found.", page));
    }

    let text = doc.extract_text(&[page]).map_err(|e| e.to_string())?;
    Ok(normalize_extracted_pdf_text(&text))
}

fn extract_pdf_page_text_cached(
    path: &str,
    page: u32,
    cache: &PdfPageTextCacheState,
) -> Result<String, String> {
    if let Some(cached) = cache.get(path, page)? {
        return Ok(cached);
    }

    let extracted = extract_pdf_page_text_uncached(path, page)?;
    cache.insert(path, page, extracted.clone())?;
    Ok(extracted)
}

#[tauri::command]
async fn extract_pdf_page_text(
    path: String,
    page: u32,
    cache: State<'_, PdfPageTextCacheState>,
) -> Result<String, String> {
    extract_pdf_page_text_cached(&path, page, &cache)
}

#[tauri::command]
async fn get_pdf_page_count(path: String) -> Result<u32, String> {
    let doc = lopdf::Document::load(path).map_err(|e| e.to_string())?;
    u32::try_from(doc.get_pages().len())
        .map_err(|_| "PDF page count exceeds supported range.".to_string())
}

#[tauri::command]
async fn get_card_settings(app: AppHandle) -> Result<CardSettings, String> {
    cards::get_card_settings(&app)
}

#[tauri::command]
async fn set_card_root_path(path: Option<String>, app: AppHandle) -> Result<CardSettings, String> {
    cards::set_card_root_path(&app, path)
}

#[tauri::command]
async fn open_card_root_in_explorer(app: AppHandle) -> Result<(), String> {
    let settings = cards::get_card_settings(&app)?;
    open_path_in_os(&settings.active_root)
}

#[tauri::command]
async fn list_knowledge_cards(app: AppHandle) -> Result<Vec<KnowledgeCardSummary>, String> {
    cards::list_knowledge_cards(&app)
}

#[tauri::command]
async fn read_knowledge_card(card_path: String) -> Result<KnowledgeCardDetail, String> {
    cards::read_knowledge_card(card_path)
}

#[tauri::command]
async fn save_knowledge_card_from_explanation(
    request: SaveKnowledgeCardRequest,
    app: AppHandle,
) -> Result<KnowledgeCardSummary, String> {
    cards::save_knowledge_card_from_explanation(&app, request)
}

#[tauri::command]
async fn check_ollama_status() -> bool {
    let client = reqwest::Client::new();
    client.get("http://localhost:11434").send().await.is_ok()
}

const PRIVATE_OLLAMA_RUNTIME_DIR: &str = "ollama_private_runtime";
const PRIVATE_OLLAMA_RUNTIME_TARGET_VERSION: &str = "0.17.7";

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const PRIVATE_OLLAMA_RUNTIME_ZIP_URL: &str =
    "https://github.com/ollama/ollama/releases/download/v0.17.7/ollama-windows-amd64.zip";

#[cfg(all(target_os = "windows", target_arch = "aarch64"))]
const PRIVATE_OLLAMA_RUNTIME_ZIP_URL: &str =
    "https://github.com/ollama/ollama/releases/download/v0.17.7/ollama-windows-arm64.zip";

fn private_ollama_runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !app_data_dir.exists() {
        std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    }

    let runtime_root = app_data_dir.join(PRIVATE_OLLAMA_RUNTIME_DIR);
    if !runtime_root.exists() {
        std::fs::create_dir_all(&runtime_root).map_err(|e| e.to_string())?;
    }
    Ok(runtime_root)
}

fn private_ollama_runtime_current_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(private_ollama_runtime_root(app)?.join("current"))
}

fn find_ollama_executable_under(root: &Path) -> Option<PathBuf> {
    walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .find_map(|entry| {
            if !entry.file_type().is_file() {
                return None;
            }

            let lower_name = entry.file_name().to_string_lossy().to_lowercase();
            if lower_name == "ollama.exe" {
                Some(entry.path().to_path_buf())
            } else {
                None
            }
        })
}

fn private_ollama_executable_path(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let current_dir = private_ollama_runtime_current_dir(app)?;
    if !current_dir.exists() {
        return Ok(None);
    }
    Ok(find_ollama_executable_under(&current_dir))
}

#[cfg(target_os = "windows")]
fn collect_system_ollama_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("Programs")
                .join("Ollama")
                .join("ollama.exe"),
        );
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(
            PathBuf::from(program_files)
                .join("Ollama")
                .join("ollama.exe"),
        );
    }
    if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
        candidates.push(
            PathBuf::from(program_files_x86)
                .join("Ollama")
                .join("ollama.exe"),
        );
    }

    if let Ok(output) = std::process::Command::new("where").arg("ollama").output() {
        if output.status.success() {
            let resolved = decode_command_output(&output.stdout);
            for line in resolved.lines() {
                let path = line.trim();
                if !path.is_empty() {
                    candidates.push(PathBuf::from(path));
                }
            }
        }
    }

    let mut deduped = Vec::new();
    let mut seen = HashSet::new();
    for candidate in candidates {
        let key = candidate.to_string_lossy().to_lowercase();
        if seen.insert(key) {
            deduped.push(candidate);
        }
    }

    deduped
}

#[cfg(target_os = "windows")]
fn find_system_ollama_executable() -> Option<PathBuf> {
    collect_system_ollama_candidates()
        .into_iter()
        .find(|path| path.exists() && path.is_file())
}

#[cfg(target_os = "windows")]
fn system_ollama_app_path(service_path: &Path) -> Option<PathBuf> {
    service_path
        .parent()
        .map(|parent| parent.join("ollama app.exe"))
        .filter(|path| path.exists() && path.is_file())
}

#[cfg(target_os = "windows")]
fn run_ollama_version_command(executable: &Path) -> Result<String, String> {
    let output = std::process::Command::new(executable)
        .arg("--version")
        .output()
        .map_err(|e| format!("Failed to run '{} --version': {}", executable.display(), e))?;

    let stdout = decode_command_output(&output.stdout);
    let stderr = decode_command_output(&output.stderr);
    let combined = format!("{}\n{}", stdout.trim(), stderr.trim())
        .trim()
        .to_string();
    if combined.is_empty() {
        Err(format!(
            "'{} --version' returned empty output.",
            executable.display()
        ))
    } else {
        Ok(combined)
    }
}

#[cfg(target_os = "windows")]
fn parse_version_after_marker(text: &str, marker: &str) -> Option<String> {
    let start = text.find(marker)? + marker.len();
    let remainder = text[start..].trim_start();
    let version = remainder
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches(|ch: char| ch == '.' || ch == ',' || ch == ';');
    if version.is_empty() {
        None
    } else {
        Some(version.to_string())
    }
}

fn parse_semver_triplet(value: &str) -> Option<(u32, u32, u32)> {
    let normalized = value.trim().trim_start_matches('v');
    let mut parts = normalized.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next().unwrap_or("0").parse::<u32>().ok()?;
    let patch_part = parts.next().unwrap_or("0");
    let patch = patch_part
        .split(|ch: char| !ch.is_ascii_digit())
        .next()
        .unwrap_or("0")
        .parse::<u32>()
        .ok()?;
    Some((major, minor, patch))
}

fn compare_semver_strings(left: &str, right: &str) -> std::cmp::Ordering {
    match (parse_semver_triplet(left), parse_semver_triplet(right)) {
        (Some(left_parts), Some(right_parts)) => left_parts.cmp(&right_parts),
        _ => left.trim().cmp(right.trim()),
    }
}

#[cfg(target_os = "windows")]
fn inspect_system_ollama_installation_windows() -> Result<SystemOllamaInspection, String> {
    let Some(service_path) = find_system_ollama_executable() else {
        return Ok(SystemOllamaInspection::default());
    };

    let service_version_output = run_ollama_version_command(&service_path).ok();
    let app_path = system_ollama_app_path(&service_path);
    let app_version_output = app_path
        .as_ref()
        .and_then(|path| run_ollama_version_command(path).ok());

    Ok(SystemOllamaInspection {
        app_path: app_path.map(|path| path.to_string_lossy().to_string()),
        app_version: app_version_output
            .as_deref()
            .and_then(|text| text.lines().next())
            .map(|line| line.trim().to_string())
            .filter(|text| !text.is_empty()),
        service_path: Some(service_path.to_string_lossy().to_string()),
        service_reported_version: service_version_output
            .as_deref()
            .and_then(|text| parse_version_after_marker(text, "ollama version is")),
        service_client_version: service_version_output
            .as_deref()
            .and_then(|text| parse_version_after_marker(text, "client version is")),
    })
}

fn private_ollama_runtime_info_from_path(
    runtime_root: &Path,
    executable_path: Option<PathBuf>,
) -> PrivateOllamaRuntimeInfo {
    let mut info = PrivateOllamaRuntimeInfo {
        executable_path: executable_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        reported_version: None,
        client_version: None,
        runtime_root: runtime_root.to_string_lossy().to_string(),
    };

    if let Some(executable) = executable_path {
        if let Ok(output) = run_ollama_version_command(&executable) {
            info.reported_version = parse_version_after_marker(&output, "ollama version is");
            info.client_version = parse_version_after_marker(&output, "client version is");
        }
    }

    info
}

fn inspect_private_ollama_runtime_internal(
    app: &AppHandle,
) -> Result<PrivateOllamaRuntimeInfo, String> {
    let runtime_root = private_ollama_runtime_root(app)?;
    let executable = private_ollama_executable_path(app)?;
    Ok(private_ollama_runtime_info_from_path(
        &runtime_root,
        executable,
    ))
}

fn emit_ollama_runtime_progress(
    window: Option<&Window>,
    status: impl Into<String>,
    total: Option<u64>,
    completed: Option<u64>,
) {
    if let Some(window) = window {
        let _ = window.emit(
            "ollama-runtime-progress",
            OllamaRuntimeProgress {
                status: status.into(),
                total,
                completed,
            },
        );
    }
}

fn replace_directory(target_dir: &Path, replacement_dir: &Path) -> Result<(), String> {
    if target_dir.exists() {
        std::fs::remove_dir_all(target_dir)
            .map_err(|e| format!("Failed to remove '{}': {}", target_dir.display(), e))?;
    }
    std::fs::rename(replacement_dir, target_dir).map_err(|e| {
        format!(
            "Failed to activate runtime '{}': {}",
            replacement_dir.display(),
            e
        )
    })
}

fn extract_ollama_runtime_zip(zip_path: &Path, target_dir: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| {
        format!(
            "Failed to open downloaded runtime archive '{}': {}",
            zip_path.display(),
            e
        )
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        format!(
            "Failed to read runtime archive '{}': {}",
            zip_path.display(),
            e
        )
    })?;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let Some(safe_path) = entry.enclosed_name().map(|path| path.to_path_buf()) else {
            continue;
        };
        let output_path = target_dir.join(safe_path);

        if entry.name().ends_with('/') {
            std::fs::create_dir_all(&output_path).map_err(|e| e.to_string())?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let mut output = std::fs::File::create(&output_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut output).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(target_os = "windows")]
async fn update_private_ollama_runtime_internal(
    app: &AppHandle,
    window: Option<&Window>,
) -> Result<PrivateOllamaRuntimeInfo, String> {
    let runtime_root = private_ollama_runtime_root(app)?;
    let download_dir = runtime_root.join("downloads");
    let staging_dir = runtime_root.join("current.new");
    let archive_path = download_dir.join("ollama-runtime.zip");

    if download_dir.exists() {
        std::fs::remove_dir_all(&download_dir).map_err(|e| e.to_string())?;
    }
    if staging_dir.exists() {
        std::fs::remove_dir_all(&staging_dir).map_err(|e| e.to_string())?;
    }

    std::fs::create_dir_all(&download_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&staging_dir).map_err(|e| e.to_string())?;

    emit_ollama_runtime_progress(
        window,
        format!(
            "正在下载应用私有 Ollama {}...",
            PRIVATE_OLLAMA_RUNTIME_TARGET_VERSION
        ),
        None,
        None,
    );
    let client = reqwest::Client::new();
    let response = client
        .get(PRIVATE_OLLAMA_RUNTIME_ZIP_URL)
        .send()
        .await
        .map_err(|e| format!("Failed to download private Ollama runtime: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Private Ollama runtime download failed: {}",
            response.status()
        ));
    }

    let total = response.content_length();
    let mut stream = response.bytes_stream();
    let mut archive_file = std::fs::File::create(&archive_path).map_err(|e| {
        format!(
            "Failed to create runtime archive '{}': {}",
            archive_path.display(),
            e
        )
    })?;
    let mut downloaded = 0u64;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        use std::io::Write as _;
        archive_file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        emit_ollama_runtime_progress(
            window,
            format!(
                "正在下载应用私有 Ollama {}...",
                PRIVATE_OLLAMA_RUNTIME_TARGET_VERSION
            ),
            total,
            Some(downloaded),
        );
    }

    emit_ollama_runtime_progress(window, "正在解压应用私有 Ollama 引擎...", None, None);
    extract_ollama_runtime_zip(&archive_path, &staging_dir)?;

    let current_dir = private_ollama_runtime_current_dir(app)?;
    replace_directory(&current_dir, &staging_dir)?;
    let _ = std::fs::remove_dir_all(&download_dir);

    let executable = private_ollama_executable_path(app)?;
    if executable.is_none() {
        return Err("Downloaded private Ollama runtime does not contain ollama.exe.".to_string());
    }

    let runtime_info = private_ollama_runtime_info_from_path(&runtime_root, executable);
    let effective_version = runtime_info
        .client_version
        .as_deref()
        .or(runtime_info.reported_version.as_deref())
        .ok_or_else(|| {
            "Downloaded private Ollama runtime version could not be determined.".to_string()
        })?;

    if compare_semver_strings(effective_version, PRIVATE_OLLAMA_RUNTIME_TARGET_VERSION).is_lt() {
        return Err(format!(
            "Downloaded private Ollama runtime version {} is lower than required {}.",
            effective_version, PRIVATE_OLLAMA_RUNTIME_TARGET_VERSION
        ));
    }

    emit_ollama_runtime_progress(
        window,
        format!("应用私有 Ollama 已更新到 {}。", effective_version),
        None,
        None,
    );
    Ok(runtime_info)
}

#[cfg(not(target_os = "windows"))]
async fn update_private_ollama_runtime_internal(
    _app: &AppHandle,
    _window: Option<&Window>,
) -> Result<PrivateOllamaRuntimeInfo, String> {
    Err("Private Ollama runtime updates are currently implemented on Windows only.".to_string())
}

#[cfg(target_os = "windows")]
fn find_listening_pid_on_port(port: u16) -> Result<Option<u32>, String> {
    let output = std::process::Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .output()
        .map_err(|e| format!("Failed to inspect TCP listeners: {}", e))?;

    if !output.status.success() {
        return Err(format!("netstat failed with status {}", output.status));
    }

    let text = decode_command_output(&output.stdout);
    let suffix = format!(":{}", port);
    for line in text.lines() {
        let columns: Vec<&str> = line.split_whitespace().collect();
        if columns.len() < 5 {
            continue;
        }
        if !columns[0].eq_ignore_ascii_case("TCP") {
            continue;
        }
        if !columns[1].ends_with(&suffix) {
            continue;
        }
        if !columns[3].eq_ignore_ascii_case("LISTENING") {
            continue;
        }
        if let Ok(pid) = columns[4].parse::<u32>() {
            return Ok(Some(pid));
        }
    }

    Ok(None)
}

#[cfg(target_os = "windows")]
fn process_name_from_pid(pid: u32) -> Result<Option<String>, String> {
    let filter = format!("PID eq {}", pid);
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &filter, "/FO", "CSV", "/NH"])
        .output()
        .map_err(|e| format!("Failed to inspect process {}: {}", pid, e))?;

    if !output.status.success() {
        return Err(format!("tasklist failed with status {}", output.status));
    }

    let text = decode_command_output(&output.stdout);
    let first_line = text.lines().next().unwrap_or("").trim();
    if first_line.is_empty() || first_line.starts_with("INFO:") {
        return Ok(None);
    }

    let normalized = first_line.trim_matches('"');
    let name = normalized.split("\",\"").next().unwrap_or("").trim();
    if name.is_empty() {
        Ok(None)
    } else {
        Ok(Some(name.to_string()))
    }
}

#[cfg(target_os = "windows")]
fn taskkill_image(image_name: &str) -> Result<(), String> {
    let output = std::process::Command::new("taskkill")
        .args(["/IM", image_name, "/F", "/T"])
        .output()
        .map_err(|e| format!("Failed to stop process '{}': {}", image_name, e))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = decode_command_output(&output.stderr);
    let stdout = decode_command_output(&output.stdout);
    let combined = format!("{} {}", stdout.trim(), stderr.trim()).to_lowercase();
    if combined.contains("not found") || combined.contains("no running instance") {
        return Ok(());
    }

    Err(format!(
        "Failed to stop process '{}': {} {}",
        image_name,
        stdout.trim(),
        stderr.trim()
    ))
}

#[cfg(target_os = "windows")]
fn stop_ollama_listener_on_default_port() -> Result<(), String> {
    let Some(pid) = find_listening_pid_on_port(11434)? else {
        return Ok(());
    };

    let process_name = process_name_from_pid(pid)?.ok_or_else(|| {
        format!(
            "Port 11434 is occupied by PID {}, but its process name could not be resolved.",
            pid
        )
    })?;
    let lower_name = process_name.to_lowercase();
    if lower_name != "ollama.exe" && lower_name != "ollama" {
        return Err(format!(
            "Port 11434 is occupied by '{}' (PID {}), refusing to terminate a non-Ollama process.",
            process_name, pid
        ));
    }

    let output = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .output()
        .map_err(|e| format!("Failed to stop Ollama process {}: {}", pid, e))?;

    if !output.status.success() {
        let stderr = decode_command_output(&output.stderr);
        return Err(format!(
            "Failed to stop Ollama process {}: {}",
            pid,
            stderr.trim()
        ));
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn stop_all_ollama_processes() -> Result<(), String> {
    taskkill_image("ollama.exe")?;
    taskkill_image("ollama app.exe")?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn spawn_system_ollama_process(
    executable: &Path,
    models_dir: &Path,
    http_proxy: Option<&String>,
    https_proxy: Option<&String>,
) -> Result<String, String> {
    let mut system_command = std::process::Command::new(executable);
    system_command
        .arg("serve")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .env("HF_ENDPOINT", "https://hf-mirror.com")
        .env("OLLAMA_MODELS", models_dir.to_string_lossy().to_string());

    if let Some(proxy) = http_proxy {
        system_command.env("HTTP_PROXY", proxy);
    }
    if let Some(proxy) = https_proxy {
        system_command.env("HTTPS_PROXY", proxy);
    }

    system_command.spawn().map_err(|e| {
        format!(
            "Failed to start system Ollama '{}': {}",
            executable.display(),
            e
        )
    })?;

    Ok(format!(
        "System Ollama started from {} (models: {})",
        executable.display(),
        models_dir.display()
    ))
}

fn default_private_ollama_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !app_data_dir.exists() {
        std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    }
    let models_dir = app_data_dir.join("ollama_models");
    if !models_dir.exists() {
        std::fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;
    }
    Ok(models_dir)
}

fn is_valid_ollama_models_dir(path: &Path) -> bool {
    path.join("blobs").is_dir() && path.join("manifests").is_dir()
}

fn sniff_local_ollama_models_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(user_profile) = std::env::var_os("USERPROFILE") {
        candidates.push(PathBuf::from(user_profile).join(".ollama").join("models"));
    }

    if let Some(models_dir) = std::env::var_os("OLLAMA_MODELS") {
        candidates.push(PathBuf::from(models_dir));
    }

    #[cfg(target_os = "windows")]
    {
        for drive in b'C'..=b'Z' {
            let root = format!("{}:\\", drive as char);
            let root_path = PathBuf::from(root);
            if !root_path.exists() {
                continue;
            }

            candidates.push(root_path.join("OllamaModels"));
            candidates.push(root_path.join("Models").join("OllamaModels"));
        }
    }

    candidates
        .into_iter()
        .find(|candidate| is_valid_ollama_models_dir(candidate))
}

fn resolve_ollama_models_dir(app: &AppHandle) -> Result<(PathBuf, bool), String> {
    if let Some(existing_models_dir) = sniff_local_ollama_models_dir() {
        return Ok((existing_models_dir, true));
    }

    Ok((default_private_ollama_models_dir(app)?, false))
}

fn spawn_private_ollama_process(app: &AppHandle, models_dir: &Path) -> Result<String, String> {
    let executable = private_ollama_executable_path(app)?
        .ok_or_else(|| "Private Ollama runtime is not available yet.".to_string())?;
    let http_proxy = std::env::var("HTTP_PROXY").ok();
    let https_proxy = std::env::var("HTTPS_PROXY").ok();

    let mut command = std::process::Command::new(&executable);
    command
        .arg("serve")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .env("HF_ENDPOINT", "https://hf-mirror.com")
        .env("OLLAMA_MODELS", models_dir.to_string_lossy().to_string());

    if let Some(proxy) = &http_proxy {
        command.env("HTTP_PROXY", proxy);
    }
    if let Some(proxy) = &https_proxy {
        command.env("HTTPS_PROXY", proxy);
    }

    command.spawn().map_err(|e| {
        format!(
            "Failed to start private Ollama runtime '{}': {}",
            executable.display(),
            e
        )
    })?;

    Ok(format!(
        "Private Ollama started from {} (models: {})",
        executable.display(),
        models_dir.display()
    ))
}

use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[tauri::command]
async fn start_ollama(app: AppHandle, window: Window) -> Result<String, String> {
    // Check for system proxy settings
    let http_proxy = std::env::var("HTTP_PROXY").ok();
    let https_proxy = std::env::var("HTTPS_PROXY").ok();

    if let Some(proxy) = &http_proxy {
        println!("Detected HTTP_PROXY: {}", proxy);
    }
    if let Some(proxy) = &https_proxy {
        println!("Detected HTTPS_PROXY: {}", proxy);
    }

    let (models_dir, reused_local_models_dir) = resolve_ollama_models_dir(&app)?;

    if reused_local_models_dir {
        emit_ollama_runtime_progress(
            Some(&window),
            format!("检测到本地 Ollama 模型库，应用私有引擎将复用：{}", models_dir.display()),
            None,
            None,
        );
    } else {
        emit_ollama_runtime_progress(
            Some(&window),
            format!("未发现可复用的本地模型库，应用私有引擎将使用自有模型库：{}", models_dir.display()),
            None,
            None,
        );
    }

    if let Some(_) = private_ollama_executable_path(&app)? {
        return spawn_private_ollama_process(&app, &models_dir);
    }

    emit_ollama_runtime_progress(
        Some(&window),
        "未发现应用私有 Ollama 引擎，正在使用随应用附带的内置引擎...",
        None,
        None,
    );

    // Use Tauri sidecar API to spawn bundled ollama
    let mut sidecar_command = app
        .shell()
        .sidecar("ollama")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?;

    // Explicitly pass proxy environment variables to the sidecar
    // Note: sidecar might not inherit environment by default on all platforms
    if let Some(proxy) = http_proxy {
        sidecar_command = sidecar_command.env("HTTP_PROXY", proxy);
    }
    if let Some(proxy) = https_proxy {
        sidecar_command = sidecar_command.env("HTTPS_PROXY", proxy);
    }

    // Set HF_ENDPOINT to hf-mirror.com to speed up potential HF downloads
    sidecar_command = sidecar_command.env("HF_ENDPOINT", "https://hf-mirror.com");
    sidecar_command =
        sidecar_command.env("OLLAMA_MODELS", models_dir.to_string_lossy().to_string());

    let (mut rx, _) = sidecar_command
        .args(["serve"])
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    // Spawn a task to monitor the process (optional)
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Terminated(payload) => {
                    println!("Ollama sidecar terminated: {:?}", payload);
                }
                _ => {}
            }
        }
    });

    Ok(format!(
        "Ollama sidecar started (models: {})",
        models_dir.display()
    ))
}

#[tauri::command]
async fn switch_to_system_ollama(app: AppHandle) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let system_ollama = find_system_ollama_executable().ok_or_else(|| {
            "No system-installed Ollama executable was found. Please install Ollama first."
                .to_string()
        })?;

        let http_proxy = std::env::var("HTTP_PROXY").ok();
        let https_proxy = std::env::var("HTTPS_PROXY").ok();
        let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        if !app_data_dir.exists() {
            std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
        }
        let models_dir = app_data_dir.join("ollama_models");
        if !models_dir.exists() {
            std::fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;
        }

        // Clear old bundled sidecars and the desktop tray app first; otherwise the old service
        // may keep or immediately reclaim port 11434 and mask the newly installed version.
        stop_all_ollama_processes()?;
        stop_ollama_listener_on_default_port()?;
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        let result = spawn_system_ollama_process(
            &system_ollama,
            &models_dir,
            http_proxy.as_ref(),
            https_proxy.as_ref(),
        )?;

        for _ in 0..20 {
            if check_ollama_status().await {
                return Ok(result);
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }

        Err(
            "System Ollama was launched but did not become ready on port 11434 in time."
                .to_string(),
        )
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("switch_to_system_ollama is currently only implemented on Windows.".to_string())
    }
}

#[tauri::command]
async fn pull_model_from_modelscope(
    name: String,
    url: String,
    filename: String,
    window: Window,
) -> Result<(), String> {
    use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, RANGE};
    use std::fs::OpenOptions;
    use std::io::{Seek, SeekFrom, Write};
    use tauri::Manager;

    let app_handle = window.app_handle();
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    if !app_data_dir.exists() {
        std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    }

    let temp_dir = app_data_dir.join("temp_models");
    if !temp_dir.exists() {
        std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    }

    let gguf_path = temp_dir.join(&filename);
    let partial_size = std::fs::metadata(&gguf_path)
        .map(|meta| meta.len())
        .unwrap_or(0);

    // 1. Download GGUF
    let client = reqwest::Client::new();
    let mut request = client.get(&url);
    if partial_size > 0 {
        request = request.header(RANGE, format!("bytes={}-", partial_size));
    }
    let res = request
        .send()
        .await
        .map_err(|e| format!("Failed to connect to mirror: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("Mirror download failed: {}", res.status()));
    }

    let status = res.status();
    let total_size = if status == reqwest::StatusCode::PARTIAL_CONTENT {
        parse_total_size_from_content_range(res.headers().get(CONTENT_RANGE))
            .unwrap_or_else(|| partial_size + res.content_length().unwrap_or(0))
    } else {
        res.headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
    };

    let resume_supported = status == reqwest::StatusCode::PARTIAL_CONTENT;
    let already_complete = total_size > 0 && partial_size == total_size;
    let mut downloaded = if resume_supported { partial_size } else { 0 };
    let mut file = if already_complete {
        OpenOptions::new()
            .append(true)
            .open(&gguf_path)
            .map_err(|e| e.to_string())?
    } else if partial_size > 0 && resume_supported {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&gguf_path)
            .map_err(|e| e.to_string())?;
        file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
        file
    } else {
        let _ = std::fs::remove_file(&gguf_path);
        OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&gguf_path)
            .map_err(|e| e.to_string())?
    };

    if already_complete {
        let _ = window.emit(
            "pull-progress",
            &PullProgress {
                status: "Reusing downloaded file from cache...".to_string(),
                model_name: Some(name.clone()),
                source_url: Some(url.clone()),
                digest: None,
                total: Some(total_size),
                completed: Some(total_size),
            },
        );
    }

    let mut stream = res.bytes_stream();
    if !already_complete {
        while let Some(item) = stream.next().await {
            let chunk = item.map_err(|e| e.to_string())?;
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            downloaded += chunk.len() as u64;

            let status_text = if resume_supported && partial_size > 0 {
                format!("Resuming mirror download: {}/{}", downloaded, total_size)
            } else {
                format!("Downloading from mirror: {}/{}", downloaded, total_size)
            };
            let _ = window.emit(
                "pull-progress",
                &PullProgress {
                    status: status_text,
                    model_name: Some(name.clone()),
                    source_url: Some(url.clone()),
                    digest: None,
                    total: Some(total_size),
                    completed: Some(downloaded),
                },
            );
        }
    }

    // 2. Create Modelfile
    let modelfile_path = temp_dir.join("Modelfile");
    let modelfile_content = format!(
        "FROM \"{}\"",
        gguf_path.to_string_lossy().replace("\\", "/")
    );
    std::fs::write(&modelfile_path, modelfile_content).map_err(|e| e.to_string())?;

    // 3. Call Ollama Create API
    let _ = window.emit(
        "pull-progress",
        &PullProgress {
            status: "Importing model into Ollama...".to_string(),
            model_name: Some(name.clone()),
            source_url: Some(url.clone()),
            digest: None,
            total: None,
            completed: None,
        },
    );

    let client = reqwest::Client::new();
    let res = client
        .post("http://localhost:11434/api/create")
        .json(&serde_json::json!({
            "name": name,
            "modelfile": format!("FROM \"{}\"", gguf_path.to_string_lossy().replace("\\", "/")),
            "stream": true
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to call Ollama Create API: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("Ollama Create failed: {}", res.status()));
    }

    // Monitor create progress
    let mut stream = res.bytes_stream();
    while let Some(item) = stream.next().await {
        if let Ok(bytes) = item {
            let _text = decode_text_bytes(&bytes);
            let _ = _text;
        }
    }

    // Cleanup
    let _ = std::fs::remove_file(gguf_path);
    let _ = std::fs::remove_file(modelfile_path);

    let _ = window.emit(
        "pull-progress",
        &PullProgress {
            status: "success".to_string(),
            model_name: Some(name),
            source_url: Some(url),
            digest: None,
            total: Some(total_size),
            completed: Some(total_size),
        },
    );

    Ok(())
}

#[tauri::command]
async fn resolve_hf_gguf(repo: String) -> Result<HfResolveResult, String> {
    let api_url = format!("https://huggingface.co/api/models/{}", repo);
    let client = reqwest::Client::new();
    let res = client
        .get(api_url)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Hugging Face API: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("Hugging Face API error: {}", res.status()));
    }

    let info: HfApiResponse = res.json().await.map_err(|e| e.to_string())?;
    let mut gguf_files: Vec<String> = info
        .siblings
        .into_iter()
        .map(|s| s.rfilename)
        .filter(|f| f.ends_with(".gguf"))
        .collect();

    if gguf_files.is_empty() {
        return Err("No GGUF files found in repo".to_string());
    }

    let preferred = [
        "Q4_K_M.gguf",
        "Q5_K_M.gguf",
        "Q4_0.gguf",
        "Q4_1.gguf",
        "Q3_K_M.gguf",
        "Q8_0.gguf",
        "F16.gguf",
    ];

    let mut selected: Option<String> = None;
    for prefer in preferred {
        if let Some(found) = gguf_files.iter().find(|f| f.ends_with(prefer)) {
            selected = Some(found.clone());
            break;
        }
    }

    let filename = selected.unwrap_or_else(|| gguf_files.remove(0));
    let url = format!("https://hf-mirror.com/{}/resolve/main/{}", repo, filename);

    Ok(HfResolveResult { url, filename })
}

#[tauri::command]
async fn ingest_knowledge_base(
    path: String,
    model: String,
    mode: Option<IngestMode>,
    app: AppHandle,
    window: Window,
) -> Result<usize, String> {
    research_memory::ingest_research_corpus(
        &app,
        &window,
        &path,
        ResearchIngestOptions {
            extract_model: Some(model),
            extract_fast_model: None,
            extract_fallback_model: None,
            allow_auto_pull_extract_model: Some(true),
            extraction_mode: Some("balanced".to_string()),
            embedding_model: None,
            vision_model: None,
            mode,
        },
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ingest_research_corpus(
    app: AppHandle,
    window: Window,
    path: String,
    options: Option<ResearchIngestOptions>,
) -> Result<usize, String> {
    research_memory::ingest_research_corpus(&app, &window, &path, options.unwrap_or_default())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn unindex_research_path(
    app: AppHandle,
    path: String,
) -> Result<usize, String> {
    research_memory::unindex_research_path(&app, &path, None)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn query_knowledge_base(
    query: String,
    app: AppHandle,
    scope_path: Option<String>,
    scope_paper: Option<String>,
) -> Result<Vec<DocumentResult>, String> {
    research_memory::query_knowledge_base(
        &app,
        &query,
        5,
        None,
        research_memory::ResearchSearchScope {
            path: scope_path.as_deref(),
            paper_query: scope_paper.as_deref(),
        },
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn search_research_memory(
    app: AppHandle,
    query: String,
    limit: Option<usize>,
    scope_path: Option<String>,
    scope_paper: Option<String>,
) -> Result<Vec<ResearchSearchHit>, String> {
    research_memory::search_research_memory(
        &app,
        &query,
        limit.unwrap_or(8),
        None,
        research_memory::ResearchSearchScope {
            path: scope_path.as_deref(),
            paper_query: scope_paper.as_deref(),
        },
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_research_graph(
    app: AppHandle,
    view: String,
) -> Result<ResearchGraph, String> {
    research_memory::get_research_graph(&app, &view)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_research_graph_node_detail(
    app: AppHandle,
    node_id: String,
) -> Result<ResearchGraphNodeDetail, String> {
    research_memory::get_research_graph_node_detail(&app, &node_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_research_graph_edge_detail(
    app: AppHandle,
    edge_id: String,
) -> Result<ResearchGraphEdgeDetail, String> {
    research_memory::get_research_graph_edge_detail(&app, &edge_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_extraction_reviews(app: AppHandle) -> Result<Vec<ReviewRecord>, String> {
    research_memory::list_extraction_reviews(&app)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_research_papers(app: AppHandle) -> Result<Vec<ResearchPaperRecord>, String> {
    research_memory::list_research_papers(&app)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn apply_extraction_review(
    app: AppHandle,
    request: ApplyReviewRequest,
) -> Result<usize, String> {
    research_memory::apply_extraction_review(&app, request)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_idea_candidates(app: AppHandle) -> Result<Vec<IdeaCandidate>, String> {
    research_memory::list_idea_candidates(&app)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn compare_papers(
    app: AppHandle,
    left_paper_id: String,
    right_paper_id: String,
    focus: Option<String>,
) -> Result<ComparePapersResult, String> {
    research_memory::compare_papers(&app, &left_paper_id, &right_paper_id, focus.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn analyze_pdf_page_visual(
    app: AppHandle,
    pdf_path: String,
    page: u32,
    model: String,
) -> Result<PageVisualNoteResult, String> {
    research_memory::analyze_pdf_page_visual(&app, &pdf_path, page, &model)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_ollama_models() -> Result<Vec<OllamaModel>, String> {
    let client = reqwest::Client::new();
    let res = client
        .get("http://localhost:11434/api/tags")
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;

    if res.status().is_success() {
        let list: OllamaModelList = res.json().await.map_err(|e| e.to_string())?;
        Ok(list.models)
    } else {
        Err(format!("Ollama API error: {}", res.status()))
    }
}

#[tauri::command]
async fn get_ollama_version() -> Result<OllamaVersionInfo, String> {
    let client = reqwest::Client::new();
    let res = client
        .get("http://localhost:11434/api/version")
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;

    if res.status().is_success() {
        res.json::<OllamaVersionInfo>()
            .await
            .map_err(|e| e.to_string())
    } else {
        Err(format!("Ollama API error: {}", res.status()))
    }
}

#[tauri::command]
async fn inspect_system_ollama_installation() -> Result<SystemOllamaInspection, String> {
    #[cfg(target_os = "windows")]
    {
        inspect_system_ollama_installation_windows()
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(SystemOllamaInspection::default())
    }
}

#[tauri::command]
async fn get_private_ollama_runtime_info(
    app: AppHandle,
) -> Result<PrivateOllamaRuntimeInfo, String> {
    inspect_private_ollama_runtime_internal(&app)
}

#[tauri::command]
async fn activate_private_ollama(
    force_update: Option<bool>,
    app: AppHandle,
    window: Window,
) -> Result<PrivateOllamaRuntimeInfo, String> {
    let should_update = force_update.unwrap_or(false);
    let current_runtime = inspect_private_ollama_runtime_internal(&app)?;

    let runtime_info = if should_update || current_runtime.executable_path.is_none() {
        update_private_ollama_runtime_internal(&app, Some(&window)).await?
    } else {
        current_runtime
    };

    let (models_dir, reused_local_models_dir) = resolve_ollama_models_dir(&app)?;
    if reused_local_models_dir {
        emit_ollama_runtime_progress(
            Some(&window),
            format!("检测到本地 Ollama 模型库，应用私有引擎将复用：{}", models_dir.display()),
            None,
            None,
        );
    } else {
        emit_ollama_runtime_progress(
            Some(&window),
            format!("未发现可复用的本地模型库，应用私有引擎将使用自有模型库：{}", models_dir.display()),
            None,
            None,
        );
    }

    stop_all_ollama_processes()?;
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    let _ = spawn_private_ollama_process(&app, &models_dir)?;

    for _ in 0..20 {
        if check_ollama_status().await {
            return inspect_private_ollama_runtime_internal(&app);
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    Err(format!(
        "Private Ollama runtime '{}' was prepared but did not become ready on port 11434 in time.",
        runtime_info
            .executable_path
            .unwrap_or_else(|| "unknown".to_string())
    ))
}

#[tauri::command]
async fn pull_ollama_model(name: String, window: Window) -> Result<(), String> {
    let client = reqwest::Client::new();
    let res = client
        .post("http://localhost:11434/api/pull")
        .json(&serde_json::json!({ "model": name, "stream": true }))
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("Ollama API error: {}", res.status()));
    }

    let mut stream = res.bytes_stream();

    while let Some(item) = stream.next().await {
        match item {
            Ok(bytes) => {
                let text = decode_command_output(&bytes);
                for line in text.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }

                    if let Ok(payload) = serde_json::from_str::<serde_json::Value>(trimmed) {
                        if let Some(error) = payload.get("error").and_then(|value| value.as_str()) {
                            return Err(format!("Ollama pull failed: {}", error));
                        }
                        if let Ok(mut progress) = serde_json::from_value::<PullProgress>(payload) {
                            if progress.model_name.is_none() {
                                progress.model_name = Some(name.clone());
                            }
                            if progress.source_url.is_none() {
                                progress.source_url = Some(ollama_library_url(&name));
                            }
                            let _ = window.emit("pull-progress", &progress);
                        }
                    }
                }
            }
            Err(e) => return Err(format!("Stream error: {}", e)),
        }
    }

    Ok(())
}

#[tauri::command]
async fn delete_ollama_model(name: String) -> Result<(), String> {
    let client = reqwest::Client::new();
    let response = client
        .delete("http://localhost:11434/api/delete")
        .json(&serde_json::json!({ "name": name }))
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Ollama delete failed: {} {}",
            status,
            body
        ));
    }
    Ok(())
}

fn ollama_library_url(name: &str) -> String {
    let base = name.split(':').next().unwrap_or(name).trim();
    format!("https://ollama.com/library/{}", base)
}

fn parse_total_size_from_content_range(
    header: Option<&reqwest::header::HeaderValue>,
) -> Option<u64> {
    let raw = header?.to_str().ok()?;
    let total = raw.split('/').nth(1)?.trim();
    total.parse::<u64>().ok()
}

fn normalize_optional_path(value: Option<String>) -> Option<String> {
    value.and_then(|v| {
        let trimmed = v.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn build_page_context_snippet(text: &str, term: &str) -> Option<String> {
    let normalized = text.trim();
    if normalized.is_empty() {
        return None;
    }

    let chars: Vec<char> = normalized.chars().collect();
    if let Some(byte_index) = normalized.find(term) {
        let start_chars = normalized[..byte_index].chars().count();
        let term_chars = term.chars().count();
        let begin = start_chars.saturating_sub(300);
        let end = (start_chars + term_chars + 300).min(chars.len());
        return Some(chars[begin..end].iter().collect::<String>());
    }

    let take = chars.len().min(800);
    Some(chars[..take].iter().collect::<String>())
}

fn truncate_chars(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect::<String>()
}

fn split_page_text_into_segments(page_text: &str) -> Vec<String> {
    let normalized = page_text.replace("\r\n", "\n");
    let primary_segments = normalized
        .split("\n\n")
        .flat_map(|block| {
            let trimmed = block.trim();
            if trimmed.is_empty() {
                return Vec::<String>::new();
            }
            if trimmed.chars().count() <= 900 {
                return vec![trimmed.to_string()];
            }

            let mut parts = Vec::new();
            let mut current = String::new();
            for line in trimmed.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let candidate_len = current.chars().count() + line.chars().count() + 1;
                if candidate_len > 900 && !current.is_empty() {
                    parts.push(current.trim().to_string());
                    current.clear();
                }
                if !current.is_empty() {
                    current.push('\n');
                }
                current.push_str(line);
            }
            if !current.trim().is_empty() {
                parts.push(current.trim().to_string());
            }
            parts
        })
        .collect::<Vec<_>>();

    if !primary_segments.is_empty() {
        return primary_segments;
    }

    let single = normalized.trim();
    if single.is_empty() {
        Vec::new()
    } else {
        vec![single.to_string()]
    }
}

fn locate_selection_segment_index(segments: &[String], selected_text: &str) -> Option<usize> {
    let normalized_selected = selected_text.trim();
    if normalized_selected.is_empty() {
        return None;
    }

    segments
        .iter()
        .position(|segment| segment.contains(normalized_selected))
        .or_else(|| {
            let selected_lower = normalized_selected.to_lowercase();
            segments.iter().position(|segment| {
                segment.to_lowercase().contains(&selected_lower)
            })
        })
}

fn build_selection_context_window(
    page_text: &str,
    selected_text: &str,
    context_limit: usize,
) -> String {
    let segments = split_page_text_into_segments(page_text);
    if segments.is_empty() {
        return truncate_chars(page_text, context_limit);
    }

    let Some(index) = locate_selection_segment_index(&segments, selected_text) else {
        return truncate_chars(page_text, context_limit);
    };

    let start = index.saturating_sub(1);
    let end = (index + 2).min(segments.len());
    let joined = segments[start..end].join("\n\n");
    truncate_chars(&joined, context_limit)
}

fn trim_non_empty_model_output(text: String, empty_message: &str) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        Err(empty_message.to_string())
    } else {
        Ok(trimmed.to_string())
    }
}

fn sanitize_chat_output(text: &str) -> String {
    let mut cleaned = text.replace("\r\n", "\n");
    for marker in [
        "<|endoftext|>",
        "<|im_start|>",
        "<|im_end|>",
        "<|end|>",
        "<|user|>",
        "<|assistant|>",
        "<|system|>",
    ] {
        cleaned = cleaned.replace(marker, "");
    }

    for prefix in ["user", "assistant", "system"] {
        let pattern = format!("\n{prefix} ");
        if let Some(index) = cleaned.find(&pattern) {
            cleaned.truncate(index);
        }
    }

    cleaned.trim().to_string()
}

fn is_cjk_char(ch: char) -> bool {
    matches!(ch as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF)
}

fn contains_cjk(text: &str) -> bool {
    text.chars().any(is_cjk_char)
}

fn normalize_translation_compare_text(text: &str) -> String {
    text.chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || is_cjk_char(*ch))
        .flat_map(|ch| ch.to_lowercase())
        .collect::<String>()
}

fn looks_like_untranslated_output(original_text: &str, translated_text: &str) -> bool {
    let original_norm = normalize_translation_compare_text(original_text);
    let translated_norm = normalize_translation_compare_text(translated_text);
    if original_norm.is_empty() || translated_norm.is_empty() {
        return false;
    }

    if original_norm == translated_norm {
        return true;
    }

    if !contains_cjk(translated_text) {
        let original_len = original_norm.chars().count();
        let translated_len = translated_norm.chars().count();
        let min_len = original_len.min(translated_len);
        if min_len == 0 {
            return false;
        }

        let same_positions = original_norm
            .chars()
            .zip(translated_norm.chars())
            .filter(|(left, right)| left == right)
            .count();
        return same_positions * 100 / min_len >= 85;
    }

    false
}

fn validate_translation_output(
    original_text: &str,
    translated_text: String,
) -> Result<String, String> {
    let trimmed = sanitize_translation_output(original_text, &translated_text)
        .ok_or_else(|| "模型返回了空翻译。".to_string())?;
    if looks_like_untranslated_output(original_text, &trimmed) {
        return Err(
            "当前模型未生成有效中文译文，请切换到更强模型后重试，例如 qwen3.5:9b 或 qwen3:8b。"
                .to_string(),
        );
    }
    Ok(trimmed)
}

fn validate_selection_translation_output(
    original_text: &str,
    translated_text: String,
) -> Result<String, String> {
    let trimmed = validate_translation_output(original_text, translated_text)?;
    let original_len = original_text.trim().chars().count();
    let translated_len = trimmed.chars().count();

    if original_len <= 24 && translated_len > 80 {
        return Err("模型输出超出选中文本范围，疑似混入了上下文内容。".to_string());
    }

    if original_len <= 120 && translated_len > original_len * 6 {
        return Err("模型输出明显长于原文，疑似把上下文一起翻译了。".to_string());
    }

    if original_len <= 400 && translated_len > original_len * 9 {
        return Err("模型输出明显长于原文，疑似把上下文一起翻译了。".to_string());
    }

    if original_len > 400 && translated_len > original_len * 12 {
        return Err("模型输出明显长于原文，疑似把上下文一起翻译了。".to_string());
    }

    Ok(trimmed)
}

fn sanitize_translation_output(original_text: &str, translated_text: &str) -> Option<String> {
    let mut cleaned = translated_text.replace("\r\n", "\n").trim().to_string();
    if cleaned.is_empty() {
        return None;
    }

    if let Some(index) = cleaned.rfind(TRANSLATION_OUTPUT_SENTINEL) {
        cleaned = cleaned[index + TRANSLATION_OUTPUT_SENTINEL.len()..]
            .trim()
            .to_string();
    }

    let leak_markers = [
        "\n页面上下文：",
        "\n页面上下文（仅供参考",
        "\n页面上下文（仅用于消歧",
        "\nPage context:",
        "\nPage context (reference only",
        "\n原文：",
        "\nSource text:",
        "\nSource passage:",
        "\n待翻译原文：",
        "\nPage text:",
    ];
    for marker in leak_markers {
        if let Some(index) = cleaned.find(marker) {
            cleaned.truncate(index);
        }
    }

    let prefix_markers = [
        "规则：",
        "Rules:",
        "要求：",
        "Instruction:",
        "Instructions:",
    ];
    if prefix_markers.iter().any(|marker| cleaned.starts_with(marker)) {
        let split_markers = [
            "\n\n译文：",
            "\n\nTranslation:",
            "\n\n[[[TRANSLATION]]]",
            "\n\n虽然",
            "\n\n当",
            "\n\n本",
            "\n\n该",
        ];
        for marker in split_markers {
            if let Some(index) = cleaned.find(marker) {
                cleaned = cleaned[index + 2..].to_string();
                break;
            }
        }
    }

    let standalone_prompt_markers = [
        "Page context (reference only",
        "Page context:",
        "Source passage:",
        "Source text:",
        "Strict rules:",
        "Rules:",
        "页面上下文（仅供参考",
        "页面上下文：",
        "源文本：",
        "原文：",
        "规则：",
        "要求：",
    ];
    for marker in standalone_prompt_markers {
        if let Some(index) = cleaned.find(marker) {
            cleaned.truncate(index);
        }
    }

    if let Some(index) = cleaned.find("译文：") {
        cleaned = cleaned[index + "译文：".len()..].trim().to_string();
    }
    if let Some(index) = cleaned.find("Translation:") {
        cleaned = cleaned[index + "Translation:".len()..].trim().to_string();
    }

    let original_text_trimmed = original_text.trim();
    if !original_text_trimmed.is_empty() {
        let original_with_label = format!("原文：\n{original_text_trimmed}");
        cleaned = cleaned.replace(&original_with_label, "");
        if cleaned.trim_start().starts_with(original_text_trimmed) {
            cleaned = cleaned
                .trim_start()
                .trim_start_matches(original_text_trimmed)
                .trim_start()
                .to_string();
        }
    }

    let cleaned = cleaned
        .trim_matches(|ch: char| ch.is_whitespace() || ch == '"' || ch == '\'' || ch == '`')
        .trim()
        .to_string();

    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

async fn run_ollama_chat(
    model: &str,
    messages: Vec<serde_json::Value>,
    think_enabled: bool,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "think": think_enabled,
        "stream": false
    });

    let url = "http://localhost:11434/api/chat";
    let res = client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to LLM at {}: {}", url, e))?;

    if !res.status().is_success() {
        return Err(format!("LLM API error: {}", res.status()));
    }

    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let message = json.get("message");
    let thinking = message
        .and_then(|value| value.get("thinking"))
        .and_then(|value| value.as_str())
        .or_else(|| json.get("thinking").and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let content = message
        .and_then(|value| value.get("content"))
        .and_then(|value| value.as_str())
        .or_else(|| json.get("response").and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let (reasoning_from_content, cleaned_answer) = content
        .map(split_reasoning_and_answer_from_content)
        .unwrap_or((None, String::new()));
    let final_reasoning = thinking
        .map(|value| value.to_string())
        .or(reasoning_from_content);

    match (final_reasoning, cleaned_answer.trim()) {
        (Some(reasoning), answer) if !answer.is_empty() => Ok(format!(
            "<think>\n{}\n</think>\n\n{}",
            sanitize_chat_output(&reasoning),
            sanitize_chat_output(answer)
        )),
        (Some(reasoning), _) => Ok(format!(
            "<think>\n{}\n</think>",
            sanitize_chat_output(&reasoning)
        )),
        (None, answer) if !answer.is_empty() => Ok(sanitize_chat_output(answer)),
        (None, _) => Err("LLM response did not include content".to_string()),
    }
}

async fn run_ollama_chat_stream(
    window: &Window,
    request_id: &str,
    model: &str,
    messages: Vec<serde_json::Value>,
    think_enabled: bool,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "think": think_enabled,
        "stream": true
    });

    let url = "http://localhost:11434/api/chat";
    let res = client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to LLM at {}: {}", url, e))?;

    if !res.status().is_success() {
        return Err(format!("LLM API error: {}", res.status()));
    }

    let mut raw_answer = String::new();
    let mut reasoning = String::new();
    let mut buffer = String::new();
    let mut stream = res.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(newline_index) = buffer.find('\n') {
            let line = buffer[..newline_index].trim().to_string();
            buffer.drain(..=newline_index);
            if line.is_empty() {
                continue;
            }

            let json: serde_json::Value =
                serde_json::from_str(&line).map_err(|e| e.to_string())?;
            let message = json.get("message");
            let thinking_delta = message
                .and_then(|value| value.get("thinking"))
                .and_then(|value| value.as_str())
                .or_else(|| json.get("thinking").and_then(|value| value.as_str()))
                .unwrap_or("");
            let answer_delta = message
                .and_then(|value| value.get("content"))
                .and_then(|value| value.as_str())
                .or_else(|| json.get("response").and_then(|value| value.as_str()))
                .unwrap_or("");

            if !thinking_delta.is_empty() {
                reasoning.push_str(thinking_delta);
            }

            if !answer_delta.is_empty() {
                raw_answer.push_str(answer_delta);
            }

            if !thinking_delta.is_empty() || !answer_delta.is_empty() {
                let (reasoning_from_content, cleaned_answer) =
                    split_reasoning_and_answer_from_content(&raw_answer);
                let reasoning_display = if reasoning.trim().is_empty() {
                    reasoning_from_content.unwrap_or_default()
                } else {
                    sanitize_chat_output(&reasoning)
                };
                let _ = window.emit(
                    "chat-stream",
                    &ChatStreamEvent {
                        request_id: request_id.to_string(),
                        phase: if cleaned_answer.trim().is_empty() {
                            "thinking".to_string()
                        } else {
                            "answer".to_string()
                        },
                        reasoning: reasoning_display,
                        answer: cleaned_answer,
                    },
                );
            }

            if json
                .get("done")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
            {
                let _ = window.emit(
                    "chat-stream",
                    &ChatStreamEvent {
                        request_id: request_id.to_string(),
                        phase: "done".to_string(),
                        reasoning: if reasoning.trim().is_empty() {
                            split_reasoning_and_answer_from_content(&raw_answer)
                                .0
                                .unwrap_or_default()
                        } else {
                            sanitize_chat_output(&reasoning)
                        },
                        answer: split_reasoning_and_answer_from_content(&raw_answer).1,
                    },
                );
            }
        }
    }

    if !buffer.trim().is_empty() {
        let json: serde_json::Value =
            serde_json::from_str(buffer.trim()).map_err(|e| e.to_string())?;
        let message = json.get("message");
        let thinking_delta = message
            .and_then(|value| value.get("thinking"))
            .and_then(|value| value.as_str())
            .or_else(|| json.get("thinking").and_then(|value| value.as_str()))
            .unwrap_or("");
        let answer_delta = message
            .and_then(|value| value.get("content"))
            .and_then(|value| value.as_str())
            .or_else(|| json.get("response").and_then(|value| value.as_str()))
            .unwrap_or("");

        if !thinking_delta.is_empty() {
            reasoning.push_str(thinking_delta);
        }

        if !answer_delta.is_empty() {
            raw_answer.push_str(answer_delta);
        }

        if !thinking_delta.is_empty() || !answer_delta.is_empty() {
            let (reasoning_from_content, cleaned_answer) =
                split_reasoning_and_answer_from_content(&raw_answer);
            let reasoning_display = if reasoning.trim().is_empty() {
                reasoning_from_content.unwrap_or_default()
            } else {
                sanitize_chat_output(&reasoning)
            };
            let _ = window.emit(
                "chat-stream",
                &ChatStreamEvent {
                    request_id: request_id.to_string(),
                    phase: if cleaned_answer.trim().is_empty() {
                        "thinking".to_string()
                    } else {
                        "answer".to_string()
                    },
                    reasoning: reasoning_display,
                    answer: cleaned_answer,
                },
            );
        }
    }

    let (reasoning_from_content, cleaned_answer) = split_reasoning_and_answer_from_content(&raw_answer);
    let final_reasoning = if reasoning.trim().is_empty() {
        reasoning_from_content
    } else {
        Some(sanitize_chat_output(&reasoning))
    };

    let final_answer = cleaned_answer.trim();
    match (final_reasoning, final_answer.is_empty()) {
        (None, true) => Err("LLM response did not include content".to_string()),
        (Some(reasoning), false) => Ok(format!(
            "<think>\n{}\n</think>\n\n{}",
            sanitize_chat_output(&reasoning),
            sanitize_chat_output(final_answer)
        )),
        (Some(reasoning), true) => Ok(format!(
            "<think>\n{}\n</think>",
            sanitize_chat_output(&reasoning)
        )),
        (None, false) => Ok(sanitize_chat_output(final_answer)),
    }
}

fn is_translation_generate_model(model: &str) -> bool {
    let normalized = model.trim().to_lowercase();
    normalized.contains("tencent-hy-mt")
        || normalized.contains("hunyuan-translation")
        || normalized.contains("hy-mt")
}

fn thinking_capable_model(model: &str) -> bool {
    let normalized = model.trim().to_lowercase();
    normalized.contains("qwen3")
        || normalized.contains("qwen3.5")
        || normalized.contains("deepseek-r1")
        || normalized.contains("reason")
}

fn split_reasoning_and_answer_from_content(content: &str) -> (Option<String>, String) {
    let mut cleaned = sanitize_chat_output(content);

    if let Some(close_index) = cleaned.find("</think>") {
        if !cleaned[..close_index].contains("<think>") {
            cleaned = cleaned[close_index + "</think>".len()..].trim().to_string();
        }
    }

    if let Some(open_index) = cleaned.find("<think>") {
        let think_start = open_index + "<think>".len();
        if let Some(close_rel) = cleaned[think_start..].find("</think>") {
            let close_index = think_start + close_rel;
            let reasoning = cleaned[think_start..close_index].trim();
            let before = cleaned[..open_index].trim();
            let after = cleaned[close_index + "</think>".len()..].trim();
            let answer = if before.is_empty() {
                after.to_string()
            } else if after.is_empty() {
                before.to_string()
            } else {
                format!("{before}\n\n{after}")
            };
            return (
                if reasoning.is_empty() {
                    None
                } else {
                    Some(reasoning.to_string())
                },
                answer,
            );
        }
    }

    (None, cleaned)
}

async fn run_ollama_generate(model: &str, prompt: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false
    });

    let url = "http://localhost:11434/api/generate";
    let res = client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to LLM at {}: {}", url, e))?;

    if !res.status().is_success() {
        return Err(format!("LLM API error: {}", res.status()));
    }

    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    json.get("response")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "LLM response did not include generated text".to_string())
}

async fn run_translation_model(
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, String> {
    if is_translation_generate_model(model) {
        let prompt = format!(
            "{system_prompt}\n\n{user_prompt}\n\nOnly output the final translation after the sentinel line below. Do not repeat the prompt, rules, source text, or page context.\n{TRANSLATION_OUTPUT_SENTINEL}"
        );
        return run_ollama_generate(model, &prompt).await;
    }

    run_ollama_chat(
        model,
        vec![
            serde_json::json!({
                "role": "system",
                "content": system_prompt
            }),
            serde_json::json!({
                "role": "user",
                "content": user_prompt
            }),
        ],
        false,
    )
    .await
}

async fn chat_via_ollama(
    window: &Window,
    request_id: &str,
    query: &str,
    context: &str,
    model: &str,
    image_path: Option<&str>,
    thinking_enabled: bool,
) -> Result<String, String> {
    let system_prompt = if thinking_enabled && thinking_capable_model(model) {
        "你是科研助手。除非用户明确要求其他语言，否则必须始终使用中文 Markdown 回答。对于较复杂的问题，可以先给出简短思考过程，再给出最终答案。思考过程优先中文，也允许英文；内容精炼且相关。优先利用检索上下文与用户当前文档作答，但不要被其机械束缚；如果上下文不足，可以结合你已有的通用知识补充回答，并明确区分哪些结论来自上下文、哪些是基于通用知识的补充或推断。不要因为上下文不完整就直接拒答。"
    } else {
        "你是科研助手。除非用户明确要求其他语言，否则必须始终使用中文 Markdown 回答。优先利用检索上下文与用户当前文档作答，但如果上下文不足，可以结合通用知识补充回答，并明确区分哪些内容来自上下文、哪些是补充说明或推断。不要因为上下文不完整就直接拒答。"
    };
    let prompt = format!(
        "请回答下面的问题。\n\n要求：\n1. 优先使用检索上下文中的证据。\n2. 如果上下文不足以完整回答，可以结合你的通用知识继续回答，但要在答案里明确说明“根据上下文”与“补充说明/推断”的区别。\n3. 如果上下文为空，也不要机械地说无法回答；应尽量先直接解释问题，再指出当前上下文未提供哪些特定证据。\n4. 如果给出了具体论文或片段范围，优先围绕该范围作答。\n\n检索上下文：\n{}\n\n问题：\n{}",
        context, query
    );

    let user_message = if let Some(path) = image_path {
        let image_bytes =
            std::fs::read(path).map_err(|e| format!("Failed to read image '{}': {}", path, e))?;
        let image_b64 = STANDARD.encode(image_bytes);
        serde_json::json!({
            "role": "user",
            "content": prompt,
            "images": [image_b64]
        })
    } else {
        serde_json::json!({
            "role": "user",
            "content": prompt
        })
    };

    run_ollama_chat_stream(
        window,
        request_id,
        model,
        vec![
            serde_json::json!({
                "role": "system",
                "content": system_prompt
            }),
            user_message,
        ],
        thinking_enabled,
    )
    .await
}

async fn translate_pdf_selection_text(
    selected_text: &str,
    page_context: Option<&str>,
    model: &str,
) -> Result<String, String> {
    let context_block = page_context
        .map(|text| truncate_chars(text, 1200))
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| "当前页上下文不可用。".to_string());
    let user_prompt = format!(
        "请把下面来自学术 PDF 的选中文本翻译成中文。\n\n要求：\n1. 只输出中文译文，不要前言，不要解释。\n2. 优先直译，并结合当前页语境做必要消歧。\n3. 专有名词保留英文原文放在括号中。\n4. 不扩写，不做百科说明。\n5. 公式、变量名、URL、DOI、代码片段尽量保持原样。\n\n当前页上下文（仅用于消歧）：\n{context_block}\n\n待翻译原文：\n{selected_text}"
    );

    run_ollama_chat(
        model,
        vec![
            serde_json::json!({
                "role": "system",
                "content": "你是学术 PDF 阅读助手中的精准翻译器。你的任务是把用户选中的原文准确翻译成中文，只输出译文正文。"
            }),
            serde_json::json!({
                "role": "user",
                "content": user_prompt
            }),
        ],
        false,
    )
    .await
    .and_then(|text| trim_non_empty_model_output(text, "模型返回了空翻译。"))
}

async fn translate_pdf_page_markdown(page_text: &str, model: &str) -> Result<String, String> {
    let user_prompt = format!(
        "请把下面这一整页学术 PDF 文本翻译成中文 Markdown。\n\n要求：\n1. 只输出 Markdown 正文，不要写前言或总结。\n2. 尽量保留原有段落和小标题结构。\n3. 不总结，不省略主干文本。\n4. 公式、变量名、URL、DOI、代码片段尽量保留原样。\n5. 如果某些行明显是碎片化 OCR 或提取噪声，可在不改变主干信息的前提下做最少整理。\n\n待翻译页面文本：\n{page_text}"
    );

    run_ollama_chat(
        model,
        vec![
            serde_json::json!({
                "role": "system",
                "content": "你是学术论文整页翻译助手。请忠实翻译为中文 Markdown，保留段落层次，不要总结。"
            }),
            serde_json::json!({
                "role": "user",
                "content": user_prompt
            }),
        ],
        false,
    )
    .await
    .and_then(|text| trim_non_empty_model_output(text, "模型返回了空翻译。"))
}

async fn translate_pdf_selection_text_v2(
    selected_text: &str,
    page_context: Option<&str>,
    model: &str,
) -> Result<String, String> {
    let selection_len = selected_text.trim().chars().count();
    let context_limit = if selection_len > LONG_SELECTION_THRESHOLD_CHARS {
        PDF_SELECTION_CONTEXT_LIMIT_LONG
    } else {
        PDF_SELECTION_CONTEXT_LIMIT_SHORT
    };
    let context_block = page_context
        .map(|text| build_selection_context_window(text, selected_text, context_limit))
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| "No page context is available.".to_string());
    let primary_prompt = if selection_len > LONG_SELECTION_THRESHOLD_CHARS {
        format!(
            "Translate only the selected source passage below into Simplified Chinese.\n\nRules:\n1. Translate the entire source passage faithfully into Chinese.\n2. Output only the translation of the source passage.\n3. Do not translate, repeat, or summarize the page context.\n4. Use the page context only to disambiguate terminology, pronouns, and sentence relations.\n5. Keep formulas, variable names, URLs, DOI, and code fragments unchanged.\n6. Preserve paragraph boundaries when the source passage spans multiple sentences or lines.\n7. No explanation, no notes, no preface.\n\nPage context (reference only, never translate it):\n{context_block}\n\nSource passage (translate this part only):\n{selected_text}"
        )
    } else {
        format!(
            "Translate only the source text below into Simplified Chinese.\n\nRules:\n1. Output only the translation of the source text.\n2. Do not translate, repeat, or summarize the page context.\n3. Use the page context only to disambiguate terms.\n4. Do not copy the English source unless it is a formula, variable name, URL, DOI, or code fragment.\n5. No explanation, no notes, no preface.\n6. The output must stay proportional to the source text length.\n\nPage context (reference only, never translate it):\n{context_block}\n\nSource text (translate this part only):\n{selected_text}"
        )
    };

    let primary_result = run_translation_model(
        model,
        if selection_len > LONG_SELECTION_THRESHOLD_CHARS {
            "You are a precise academic translator. Translate the full user-selected source passage into Simplified Chinese. Never translate the page context. Never add explanations or summaries."
        } else {
            "You are a precise academic translator. Translate only the user-selected source text into Simplified Chinese. Never translate the page context. Never return the original English sentence unchanged."
        },
        &primary_prompt,
    )
    .await
    .and_then(|text| validate_selection_translation_output(selected_text, text));

    if let Ok(validated) = primary_result {
        return Ok(validated);
    }

    let retry_prompt = if selection_len > LONG_SELECTION_THRESHOLD_CHARS {
        format!(
            "The previous attempt failed because it included too much non-source content.\n\nRetry and translate only the selected source passage into natural Simplified Chinese.\n\nStrict rules:\n1. Translate the entire selected source passage and nothing else.\n2. Do not translate or paraphrase the page context.\n3. Keep formulas, tensor names, URLs, DOI, and code identifiers as-is.\n4. Preserve paragraph and sentence structure as much as possible.\n5. No explanation. No bullet points. No preface.\n\nPage context (reference only):\n{context_block}\n\nSource passage:\n{selected_text}"
        )
    } else {
        format!(
            "The previous attempt failed because it included too much non-source content.\n\nTry again and translate only the selected source text into natural Simplified Chinese.\n\nStrict rules:\n1. Translate only the source text.\n2. Do not translate or paraphrase the page context.\n3. Keep formulas, tensor names, URLs, DOI, and code identifiers as-is.\n4. If a proper noun must stay in English, keep a short Chinese translation and put the English in parentheses.\n5. No explanation. No bullet points. No preface.\n6. Keep the output length close to the source text length.\n\nPage context (reference only):\n{context_block}\n\nSource text:\n{selected_text}"
        )
    };

    run_translation_model(
        model,
        if selection_len > LONG_SELECTION_THRESHOLD_CHARS {
            "You are an academic English-to-Chinese translator. You must return a valid Simplified Chinese translation of only the selected source passage, not the page context."
        } else {
            "You are an academic English-to-Chinese translator. You must return a valid Simplified Chinese translation of only the selected source text, not the page context."
        },
        &retry_prompt,
    )
    .await
    .and_then(|text| validate_selection_translation_output(selected_text, text))
}

async fn translate_pdf_page_markdown_v2(page_text: &str, model: &str) -> Result<String, String> {
    let primary_prompt = format!(
        "Translate the following full PDF page into Simplified Chinese Markdown.\n\nRules:\n1. Output Markdown only.\n2. Preserve headings, paragraph structure, and list structure whenever present.\n3. Do not summarize or omit the main content.\n4. Keep formulas, variable names, URLs, DOI, and code snippets unchanged.\n5. Translate normal English prose into Chinese rather than copying it.\n\nPage text:\n{page_text}"
    );

    let primary_result = run_translation_model(
        model,
        "You are an academic PDF page translator. Return Simplified Chinese Markdown and do not leave normal English prose untranslated.",
        &primary_prompt,
    )
    .await
    .and_then(|text| validate_translation_output(page_text, text));

    if let Ok(validated) = primary_result {
        return Ok(validated);
    }

    let retry_prompt = format!(
        "The previous attempt copied too much English. Retry and translate the page into Simplified Chinese Markdown.\n\nStrict rules:\n1. Translate all normal English prose into Chinese.\n2. Keep formulas, variable names, URLs, DOI, and code snippets unchanged.\n3. Preserve section structure and paragraph breaks.\n4. Do not summarize.\n\nPage text:\n{page_text}"
    );

    run_translation_model(
        model,
        "You must produce a valid Simplified Chinese Markdown translation of the source page.",
        &retry_prompt,
    )
    .await
    .and_then(|text| validate_translation_output(page_text, text))
}

async fn summarize_term_for_beginner(
    term: &str,
    page_context: Option<&str>,
    reference_extract: Option<&str>,
    model: &str,
    treat_as_plain_english_word: bool,
) -> Result<String, String> {
    let context_block = page_context.unwrap_or("No page context was extracted from the PDF page.");
    let reference_block = reference_extract.unwrap_or("No external reference extract was found.");
    let generic_word_hint = if treat_as_plain_english_word {
        "This term looks like a common English word rather than a named academic concept. Prioritize giving the direct Chinese meaning first, then briefly explain what it means in the current sentence. Do not force it into a research concept."
    } else {
        "If the term is clearly a technical concept in the paper, explain the concept first, then connect it to the current page context."
    };
    let user_prompt = format!(
        "You are given a selected term from an academic PDF. The external encyclopedia extract may be unrelated because of homonyms, for example songs, movies, entertainers, or other pop-culture entries. If you judge that the encyclopedia extract is unrelated to academic, scientific, computer-science, or bioinformatics context, ignore it completely.\n\n{generic_word_hint}\n\nWrite the answer in Chinese only. Keep it short, plain, and useful for a beginner researcher. If the selected term is just a common English word such as different, make, or the, give the Chinese translation directly and briefly explain its role in the current sentence. Do not force a research interpretation. Do not use bullet points. Do not invent results that are not in the page context.\n\nSelected term:\n{term}\n\nExternal encyclopedia extract:\n{reference_block}\n\nPDF page context:\n{context_block}"
    );

    run_ollama_chat(
        model,
        vec![
            serde_json::json!({
                "role": "system",
                "content": "You are a research reading assistant. Always answer in concise Chinese that a beginner can understand."
            }),
            serde_json::json!({
                "role": "user",
                "content": user_prompt
            }),
        ],
        false,
    )
    .await
    .map(|text| text.trim().to_string())
}

fn is_plain_ascii_lowercase_word(term: &str) -> bool {
    let normalized = term.trim();
    !normalized.is_empty()
        && normalized.len() <= 18
        && normalized.bytes().all(|byte| byte.is_ascii_lowercase())
}

fn is_common_everyday_english_word(term: &str) -> bool {
    let normalized = term.trim().to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "a" | "an"
            | "the"
            | "and"
            | "or"
            | "but"
            | "to"
            | "of"
            | "in"
            | "on"
            | "at"
            | "for"
            | "from"
            | "with"
            | "without"
            | "by"
            | "as"
            | "into"
            | "over"
            | "under"
            | "between"
            | "among"
            | "before"
            | "after"
            | "different"
            | "same"
            | "other"
            | "another"
            | "each"
            | "every"
            | "some"
            | "many"
            | "few"
            | "more"
            | "most"
            | "less"
            | "large"
            | "small"
            | "make"
            | "made"
            | "use"
            | "used"
            | "using"
            | "show"
            | "shown"
            | "find"
            | "found"
            | "give"
            | "given"
            | "take"
            | "taken"
            | "good"
            | "bad"
            | "new"
            | "old"
            | "high"
            | "low"
    )
}

fn is_likely_entertainment_reference(reference: &encyclopedia::ReferenceEntry) -> bool {
    let haystack = format!(
        "{} {} {}",
        reference.title, reference.provider, reference.extract
    )
    .to_lowercase();
    [
        "song",
        "single",
        "album",
        "singer",
        "band",
        "music",
        "movie",
        "film",
        "tv series",
        "actor",
        "actress",
        "celebrity",
        "歌曲",
        "单曲",
        "专辑",
        "歌手",
        "乐队",
        "音乐",
        "电影",
        "电视剧",
        "演员",
        "娱乐人物",
    ]
    .iter()
    .any(|keyword| haystack.contains(keyword))
}

fn should_ignore_reference_for_term(term: &str, reference: &encyclopedia::ReferenceEntry) -> bool {
    is_plain_ascii_lowercase_word(term) && is_likely_entertainment_reference(reference)
}

#[tauri::command]
async fn explain_pdf_selection(
    request: ExplainPdfSelectionRequest,
    cache: State<'_, PdfPageTextCacheState>,
) -> Result<ExplainPdfSelectionResult, String> {
    let term = request.term.trim().to_string();
    if term.is_empty() {
        return Err("Term must not be empty.".to_string());
    }

    let page_text = extract_pdf_page_text_cached(&request.pdf_path, request.page, &cache)?;
    let context_snippet = build_page_context_snippet(&page_text, &term);
    let treat_as_plain_english_word = is_common_everyday_english_word(&term);
    let mut reference = if treat_as_plain_english_word {
        None
    } else {
        encyclopedia::lookup_term(&term, request.mode).await?
    };
    if let Some(entry) = reference.as_ref() {
        if should_ignore_reference_for_term(&term, entry) {
            println!(
                "Ignored unrelated encyclopedia entry for term '{}': [{}] {}",
                term, entry.provider, entry.title
            );
            reference = None;
        }
    }
    let reference_extract = reference.as_ref().map(|entry| entry.extract.as_str());
    let model_result = summarize_term_for_beginner(
        &term,
        context_snippet.as_deref(),
        reference_extract,
        &request.model,
        treat_as_plain_english_word,
    )
    .await;

    let (plain_summary, source_status) = match (model_result, reference.as_ref()) {
        (Ok(summary), Some(_)) => {
            if summary.trim().is_empty() {
                (
                    reference
                        .as_ref()
                        .map(|entry| entry.extract.clone())
                        .unwrap_or_default(),
                    "source_only".to_string(),
                )
            } else {
                (summary, "source+model".to_string())
            }
        }
        (Ok(summary), None) => {
            if summary.trim().is_empty() {
                return Err("Model returned an empty explanation.".to_string());
            }
            (summary, "model_only".to_string())
        }
        (Err(error), Some(entry)) => {
            println!("Explanation model fallback used: {}", error);
            (entry.extract.clone(), "source_only".to_string())
        }
        (Err(error), None) => return Err(error),
    };

    Ok(ExplainPdfSelectionResult {
        term,
        plain_summary,
        source_title: reference.as_ref().map(|entry| entry.title.clone()),
        source_url: reference.as_ref().map(|entry| entry.url.clone()),
        source_provider: reference.as_ref().map(|entry| entry.provider.clone()),
        source_lang: reference.as_ref().and_then(|entry| entry.language.clone()),
        source_extract: reference.as_ref().map(|entry| entry.extract.clone()),
        page_context_snippet: context_snippet,
        source_status,
        generated_at: cards::current_timestamp_iso_utc(),
        lookup_mode: request.mode,
    })
}

#[tauri::command]
async fn translate_pdf_selection(
    request: TranslatePdfSelectionRequest,
    cache: State<'_, PdfPageTextCacheState>,
) -> Result<TranslatePdfSelectionResult, String> {
    let original_text = request.text.trim().to_string();
    if original_text.is_empty() {
        return Err("没有可翻译的文本。".to_string());
    }

    if original_text.chars().count() > MAX_PDF_SELECTION_TRANSLATE_CHARS {
        return Err("选中文本过长，请使用“翻译本页”。".to_string());
    }

    let page_context = extract_pdf_page_text_cached(&request.pdf_path, request.page, &cache).ok();
    let translated_text =
        translate_pdf_selection_text_v2(&original_text, page_context.as_deref(), &request.model)
            .await?;

    Ok(TranslatePdfSelectionResult {
        original_text,
        translated_text,
        page: request.page,
        generated_at: cards::current_timestamp_iso_utc(),
        model_used: request.model,
    })
}

#[tauri::command]
async fn translate_pdf_page(
    request: TranslatePdfPageRequest,
    cache: State<'_, PdfPageTextCacheState>,
) -> Result<TranslatePdfPageResult, String> {
    let page_text = extract_pdf_page_text_cached(&request.pdf_path, request.page, &cache)?;
    let source_text_length = page_text.chars().count();

    if page_text.trim().is_empty() {
        return Ok(TranslatePdfPageResult {
            page: request.page,
            translated_markdown: "当前页没有可翻译文本，OCR 后可重试。".to_string(),
            source_text_length: 0,
            generated_at: cards::current_timestamp_iso_utc(),
            model_used: request.model,
        });
    }

    let translated_markdown = translate_pdf_page_markdown_v2(&page_text, &request.model).await?;
    Ok(TranslatePdfPageResult {
        page: request.page,
        translated_markdown,
        source_text_length,
        generated_at: cards::current_timestamp_iso_utc(),
        model_used: request.model,
    })
}

fn normalize_lookup_text(value: &str) -> String {
    value.trim().to_lowercase()
}

fn choose_best_paper_match(
    papers: &[ResearchPaperRecord],
    scope_paper: Option<&str>,
    fallback_path: Option<&str>,
) -> Result<ResearchPaperRecord, String> {
    let normalized_scope = scope_paper
        .map(normalize_lookup_text)
        .filter(|value| !value.is_empty());
    let normalized_path = fallback_path
        .map(normalize_lookup_text)
        .filter(|value| !value.is_empty());

    if let Some(scope_query) = normalized_scope.as_deref() {
        if let Some(exact) = papers.iter().find(|paper| {
            normalize_lookup_text(&paper.title) == scope_query
                || normalize_lookup_text(&paper.path) == scope_query
        }) {
            return Ok(exact.clone());
        }

        let fuzzy_matches = papers
            .iter()
            .filter(|paper| {
                normalize_lookup_text(&paper.title).contains(scope_query)
                    || normalize_lookup_text(&paper.path).contains(scope_query)
            })
            .cloned()
            .collect::<Vec<_>>();
        if fuzzy_matches.len() == 1 {
            return Ok(fuzzy_matches[0].clone());
        }
        if fuzzy_matches.len() > 1 {
            return Err(format!(
                "匹配到多篇论文：'{}'。请从 @paper 列表中明确选择目标论文。",
                scope_paper.unwrap_or_default().trim()
            ));
        }
        return Err(format!(
            "未找到目标论文：'{}'。请确认论文已导入并从 @paper 列表中选择。",
            scope_paper.unwrap_or_default().trim()
        ));
    }

    if let Some(path_query) = normalized_path.as_deref() {
        if let Some(exact) = papers
            .iter()
            .find(|paper| normalize_lookup_text(&paper.path) == path_query)
        {
            return Ok(exact.clone());
        }
    }

    Err("当前没有可用的目标论文。请先选中文献，或使用 @paper 指定论文。".to_string())
}

async fn resolve_brief_target_paper(
    app: &AppHandle,
    request: &GenerateBriefReportRequest,
) -> Result<ResearchPaperRecord, String> {
    let papers = research_memory::list_research_papers(app)
        .await
        .map_err(|e| e.to_string())?;
    let fallback_path = request
        .paper_path
        .as_deref()
        .or(request.active_pdf_path.as_deref());
    let paper =
        choose_best_paper_match(&papers, request.scope_paper.as_deref(), fallback_path)?;
    if paper.chunk_count == 0 {
        return Err(format!(
            "目标论文“{}”尚未建立可检索内容，请先完成 ingest。",
            paper.title
        ));
    }
    Ok(paper)
}

fn format_brief_hits_section(title: &str, hits: &[ResearchSearchHit]) -> String {
    if hits.is_empty() {
        return format!("### {title}\n- 当前未检索到直接证据。");
    }

    let items = hits
        .iter()
        .map(|hit| {
            format!(
                "- [p.{}-{} | score {:.2}] {}",
                hit.page_start,
                hit.page_end,
                hit.score,
                truncate_chars(hit.snippet.trim(), 360)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("### {title}\n{items}")
}

async fn build_brief_context(
    app: &AppHandle,
    paper: &ResearchPaperRecord,
) -> Result<(String, usize), String> {
    let scoped_queries = [
        ("Abstract / Summary", "abstract summary overview main idea"),
        ("Task / Challenge / Motivation", "task challenge motivation problem limitation bottleneck"),
        ("Contribution / Innovation", "contribution innovation propose proposed novelty"),
        ("Method / Pipeline / Module", "method pipeline framework module architecture algorithm"),
        ("Experiments / Baseline / Dataset", "experiment baseline dataset sota benchmark"),
        ("Ablation", "ablation ablation study component removal"),
        ("Limitation / Future Work", "limitation future work discussion weakness"),
    ];
    let scope = research_memory::ResearchSearchScope {
        path: Some(paper.path.as_str()),
        paper_query: None,
    };

    let mut unique_hits = HashMap::<String, ResearchSearchHit>::new();
    let mut section_blocks = Vec::new();

    for (section_title, query) in scoped_queries {
        let hits = research_memory::search_research_memory(app, query, 4, None, scope.clone())
            .await
            .map_err(|e| e.to_string())?;
        for hit in &hits {
            unique_hits
                .entry(hit.id.clone())
                .or_insert_with(|| hit.clone());
        }
        section_blocks.push(format_brief_hits_section(section_title, &hits));
    }

    let mut graph_node_counts = HashMap::<String, usize>::new();
    for hit in unique_hits.values() {
        for node in &hit.related_graph_nodes {
            *graph_node_counts.entry(node.clone()).or_insert(0) += 1;
        }
    }

    let mut graph_nodes = graph_node_counts.into_iter().collect::<Vec<_>>();
    graph_nodes.sort_by(|left, right| {
        right
            .1
            .cmp(&left.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    graph_nodes.truncate(10);

    let graph_summary = if graph_nodes.is_empty() {
        "图谱线索不足，当前主要依赖论文检索片段。".to_string()
    } else {
        graph_nodes
            .iter()
            .map(|(label, count)| format!("- {} ({} 条命中关联)", label, count))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let evidence_count = unique_hits.len();
    let evidence_hint = if evidence_count < 6 {
        "当前证据有限，部分栏目可能只能标注为“未明确说明”或“检索证据不足”。"
    } else {
        "当前证据覆盖尚可，但仍需避免超出原文证据的推断。"
    };

    let context = format!(
        "## 目标论文\n- 标题：{}\n- 路径：{}\n- Chunk 数：{}\n- 候选概念数：{}\n- 图谱状态：{}\n- 更新时间：{}\n\n## 证据覆盖提示\n{}\n\n## 图谱线索\n{}\n\n## 分主题检索证据\n{}",
        paper.title,
        paper.path,
        paper.chunk_count,
        paper.candidate_count,
        if paper.is_in_graph {
            "已有图谱候选"
        } else {
            "暂无稳定图谱候选"
        },
        paper.updated_at,
        evidence_hint,
        graph_summary,
        section_blocks.join("\n\n")
    );

    Ok((context, evidence_count))
}

fn build_brief_prompt(
    paper: &ResearchPaperRecord,
    context: &str,
    evidence_count: usize,
    user_instruction: Option<&str>,
) -> String {
    let instruction_block = user_instruction
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("## 用户附加要求\n{}\n", value))
        .unwrap_or_default();
    let evidence_notice = if evidence_count < 6 {
        "请在简报开头补一句：当前证据有限，部分栏目可能缺失。"
    } else {
        "无需额外强调证据稀少，但仍要保留缺失说明规则。"
    };

    format!(
        "你需要为一篇论文生成“核心 Markdown 简报”。\n\n要求：\n1. 全文用中文输出，但保留必要英文标签辅助定位。\n2. 必须严格按下面模板输出，不得改一级标题顺序。\n3. 优先依据“图谱线索”和“分主题检索证据”填写内容。\n4. 如果论文没有明确说明某项信息，保留该栏目并写“论文未明确说明”或“当前检索证据不足”。\n5. 不要虚构年份、会议、数据集、baseline、提升幅度、消融数值。\n6. “作者承认的局限”与“基于证据的谨慎推断”要区分表述。\n7. 如果论文未明确拆分多个 challenge 或 module，也要保留对应栏目并说明“未明确拆分”。\n8. 若没有可核验消融结果，明确写“论文未给出可核验的定量变化”。\n9. 不要输出 JSON，不要输出额外前言。\n10. {evidence_notice}\n\n{instruction_block}## 论文上下文\n{context}\n\n## 输出模板\n# Core Brief\n\n> 只在证据有限时加入一句提示：当前证据有限，部分栏目可能缺失。\n\n## 文献基础信息\n- 论文标题：{title}\n- 发表年份与会议/期刊：\n\n## 1. Abstract\n- Task (研究任务)：\n- Technical Challenge (前人面临的技术挑战)：\n- Key Insight / Motivation (核心洞察)：\n- Technical Contributions (具体技术贡献)：\n  - Contribution 1： -> 好处：\n  - Contribution 2： -> 好处：\n\n## 2. Introduction\n- Technical Challenge 1 的前世今生：\n  - Previous Method (前人方法)：\n  - Failure Cases / Limitation (缺陷)：\n  - Technical Reason (深层技术原因)：\n- Technical Challenge 2 的前世今生：\n  - Previous Method：\n  - Failure Cases / Limitation：\n  - Technical Reason：\n- Our Pipeline (我们的解决方案)：\n  - Key Innovation：\n  - 针对 Challenge 1 的解法：\n  - 针对 Challenge 2 的解法：\n\n## 3. Method\n- Overview (全局概览)：任务输入是 []，输出是 []，整体分为 [] 个步骤。\n- Pipeline Module 1：\n  - Motivation：\n  - 做法：\n  - 为什么能 work (Technical Advantage)：\n- Pipeline Module 2：\n  - Motivation：\n  - 做法：\n  - 为什么能 work (Technical Advantage)：\n\n## 4. Experiments\n- Comparison (对比实验)：\n- Ablation Studies (消融实验)：\n  - 模块 A 对性能的影响：\n  - 模块 B 对性能的影响：\n\n## 5. Limitation\n- 作者承认的缺陷：\n- 基于证据的谨慎推断：",
        title = paper.title
    )
}

#[tauri::command]
async fn generate_brief_report(
    window: Window,
    app: AppHandle,
    request: GenerateBriefReportRequest,
    settings_state: State<'_, InferenceSettingsState>,
) -> Result<String, String> {
    let emit_progress = |phase: &str, message: &str| {
        let _ = window.emit(
            "brief-progress",
            &BriefProgressEvent {
                request_id: request.request_id.clone(),
                phase: phase.to_string(),
                message: message.to_string(),
            },
        );
    };

    emit_progress("locating", "正在定位目标论文...");
    let paper = resolve_brief_target_paper(&app, &request).await?;
    emit_progress("retrieving", "正在检索图谱与摘要证据...");
    let (context, evidence_count) = build_brief_context(&app, &paper).await?;
    emit_progress("generating", "正在生成核心简报...");
    let prompt = build_brief_prompt(
        &paper,
        &context,
        evidence_count,
        request.user_instruction.as_deref(),
    );

    let settings = settings_state.get()?;
    run_ollama_chat(
        &request.model,
        vec![
            serde_json::json!({
                "role": "system",
                "content": "你是科研论文精读助手。你的职责是根据检索证据生成结构化核心简报。你必须保守、可核验、禁止编造缺失事实。"
            }),
            serde_json::json!({
                "role": "user",
                "content": prompt
            }),
        ],
        settings.thinking_enabled,
    )
    .await
    .and_then(|text| trim_non_empty_model_output(text, "模型返回了空简报。"))
    .map(|text| {
        emit_progress("done", "核心简报已生成。");
        text
    })
}

async fn route_chat_completion(
    window: &Window,
    request_id: &str,
    query: &str,
    context: &str,
    model: &str,
    image_path: Option<&str>,
    mode: InferenceMode,
    thinking_enabled: bool,
) -> Result<String, String> {
    match mode {
        InferenceMode::SingleMm => {
            chat_via_ollama(window, request_id, query, context, model, image_path, thinking_enabled).await
        }
        InferenceMode::DualPipeline => {
            // Skeleton only: dual pipeline currently falls back to single-model chat.
            // Future implementation can split text and vision inference, then merge evidence.
            chat_via_ollama(window, request_id, query, context, model, image_path, thinking_enabled).await
        }
    }
}

#[tauri::command]
async fn chat_with_llm(
    window: Window,
    query: String,
    context: String,
    model: String,
    image_path: Option<String>,
    request_id: String,
    settings_state: State<'_, InferenceSettingsState>,
) -> Result<String, String> {
    let settings = settings_state.get()?;
    let normalized_image_path = normalize_optional_path(image_path);
    route_chat_completion(
        &window,
        &request_id,
        &query,
        &context,
        &model,
        normalized_image_path.as_deref(),
        settings.mode,
        settings.thinking_enabled,
    )
    .await
}

#[tauri::command]
async fn get_mobile_companion_status(
    app: AppHandle,
    state: State<'_, mobile::MobileCompanionState>,
) -> Result<mobile::MobileCompanionStatus, String> {
    mobile::get_mobile_companion_status(&app, &state)
}

#[tauri::command]
async fn refresh_mobile_pair_code(
    app: AppHandle,
    state: State<'_, mobile::MobileCompanionState>,
) -> Result<mobile::MobileCompanionStatus, String> {
    mobile::refresh_mobile_pair_code(&app, &state)
}

#[tauri::command]
async fn list_mobile_inbox_items(
    app: AppHandle,
) -> Result<Vec<mobile::DesktopMobileInboxItem>, String> {
    mobile::list_mobile_inbox_items(&app)
}

#[tauri::command]
async fn set_mobile_inbox_item_status(
    app: AppHandle,
    item_id: String,
    processed: bool,
) -> Result<mobile::DesktopMobileInboxItem, String> {
    mobile::set_mobile_inbox_item_status(&app, &item_id, processed)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let inference_settings_state = InferenceSettingsState::new();
    let mobile_companion_state = mobile::MobileCompanionState::new();
    let pdf_page_text_cache_state = PdfPageTextCacheState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(inference_settings_state)
        .manage(mobile_companion_state)
        .manage(pdf_page_text_cache_state)
        .setup(|app| {
            let started = Instant::now();
            let handle = app.handle().clone();

            // Load inference settings and persist defaults if file does not exist yet.
            match load_inference_settings_from_disk(&handle) {
                Ok(settings) => {
                    let state = handle.state::<InferenceSettingsState>();
                    if let Err(e) = state.replace(settings.clone()) {
                        println!("Failed to apply inference settings: {}", e);
                    }
                    if let Err(e) = save_inference_settings_to_disk(&handle, &settings) {
                        println!("Failed to persist inference settings: {}", e);
                    }
                }
                Err(e) => println!("Failed to load inference settings: {}", e),
            }

            let research_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = research_memory::initialize(&research_handle).await {
                    println!("Failed to initialize research memory: {}", e);
                    return;
                }
                if let Err(e) = research_memory::sync_index_state(&research_handle, None).await {
                    println!("Failed to sync research memory index state: {}", e);
                }
            });

            let mobile_state = handle
                .state::<mobile::MobileCompanionState>()
                .inner()
                .clone();
            if let Err(error) = mobile::initialize_mobile_companion(handle.clone(), mobile_state) {
                println!("Failed to initialize mobile companion service: {}", error);
            }
            println!("[startup] tauri setup finished in {}ms", started.elapsed().as_millis());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            scan_directory,
            get_workspace_snapshot,
            list_directory_children,
            create_workspace_folder,
            rename_workspace_entry,
            trash_workspace_entry,
            copy_workspace_entry,
            move_workspace_entry,
            get_workspace_relative_path,
            import_directory_to_workspace,
            import_paths_to_workspace,
            import_zotero_storage_to_workspace,
            detect_zotero_storage,
            ingest_knowledge_base,
            ingest_research_corpus,
            unindex_research_path,
            query_knowledge_base,
            search_research_memory,
            get_research_graph,
            get_research_graph_node_detail,
            get_research_graph_edge_detail,
            list_research_papers,
            list_extraction_reviews,
            apply_extraction_review,
            list_idea_candidates,
            compare_papers,
            analyze_pdf_page_visual,
            get_ollama_models,
            delete_ollama_model,
            get_ollama_version,
            inspect_system_ollama_installation,
            get_private_ollama_runtime_info,
            activate_private_ollama,
            pull_ollama_model,
            pull_model_from_modelscope,
            resolve_hf_gguf,
            get_inference_settings,
            set_inference_mode,
            set_thinking_enabled,
            chat_with_llm,
            generate_brief_report,
            explain_pdf_selection,
            reveal_in_explorer,
            open_file,
            read_file_base64,
            write_text_file,
            extract_pdf_page_text,
            get_pdf_page_count,
            get_card_settings,
            set_card_root_path,
            open_card_root_in_explorer,
            list_knowledge_cards,
            read_knowledge_card,
            save_knowledge_card_from_explanation,
            translate_pdf_selection,
            translate_pdf_page,
            check_ollama_status,
            start_ollama,
            switch_to_system_ollama,
            get_mobile_companion_status,
            refresh_mobile_pair_code,
            list_mobile_inbox_items,
            set_mobile_inbox_item_status
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let RunEvent::Exit = event {
                // Kill all child processes when the app exits
                // This is a forceful way to ensure development server and other spawned processes die
                #[cfg(debug_assertions)]
                {
                    #[cfg(target_os = "windows")]
                    {
                        let _ = std::process::Command::new("taskkill")
                            .args(["/F", "/IM", "node.exe"])
                            .spawn();
                    }
                }
            }
        });
}
