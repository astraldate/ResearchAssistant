// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use tauri::{State, Emitter, Window};
use serde::{Deserialize, Serialize};
use futures_util::StreamExt;
use std::collections::HashSet;
use std::sync::Mutex;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::path::{Path, PathBuf};

mod rag;
use rag::{Document, IngestMode, IngestProgress, RagState};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileNode {
    pub id: String,
    pub name: String,
    pub path: String,
    pub type_name: String, // "file" or "folder"
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
pub struct PullProgress {
    pub status: String,
    pub digest: Option<String>,
    pub total: Option<u64>,
    pub completed: Option<u64>,
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
}

impl Default for InferenceSettings {
    fn default() -> Self {
        Self {
            mode: InferenceMode::SingleMm,
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

    pub fn replace(&self, settings: InferenceSettings) -> Result<(), String> {
        let mut guard = self
            .settings
            .lock()
            .map_err(|e| format!("Failed to lock inference settings: {}", e))?;
        *guard = settings;
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

use tauri::{AppHandle, Manager, RunEvent};

fn build_tree(path: &Path) -> FileNode {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let is_dir = path.is_dir();

    let mut children = if is_dir { Some(Vec::new()) } else { None };

    if is_dir {
        if let Ok(entries) = std::fs::read_dir(path) {
            let mut nodes = Vec::new();
            for entry in entries.filter_map(|e| e.ok()) {
                let p = entry.path();
                if p.file_name()
                    .map(|n| n.to_string_lossy().starts_with('.'))
                    .unwrap_or(false)
                {
                    continue;
                }
                nodes.push(build_tree(&p));
            }
            nodes.sort_by(|a, b| match (a.type_name.as_str(), b.type_name.as_str()) {
                ("folder", "file") => std::cmp::Ordering::Less,
                ("file", "folder") => std::cmp::Ordering::Greater,
                _ => a.name.cmp(&b.name),
            });
            children = Some(nodes);
        }
    }

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
        children,
    }
}

fn copy_directory_recursive(source_root: &Path, target_root: &Path) -> Result<(), String> {
    for entry in walkdir::WalkDir::new(source_root).into_iter().filter_map(|e| e.ok()) {
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
            if entry
                .file_name()
                .to_string_lossy()
                .to_lowercase()
                != "prefs.js"
            {
                continue;
            }

            if let Ok(content) = std::fs::read_to_string(entry.path()) {
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
    source_storage_path: String,
    mode: Option<IngestMode>,
    app: AppHandle,
) -> Result<ZoteroImportResult, String> {
    let source_input = PathBuf::from(source_storage_path.trim());
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

    let target_root = workspace_root.join("zotero_storage");
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

    let mut copied_pdfs = 0usize;
    let mut skipped_existing = 0usize;
    for entry in walkdir::WalkDir::new(&storage_root).into_iter().filter_map(|e| e.ok()) {
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

        let rel = entry
            .path()
            .strip_prefix(&storage_root)
            .map_err(|e| e.to_string())?;
        let dst = target_root.join(rel);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        if selected_mode == IngestMode::Incremental && dst.exists() {
            skipped_existing += 1;
            continue;
        }

        std::fs::copy(entry.path(), &dst)
            .map_err(|e| format!("Failed to copy '{}' -> '{}': {}", entry.path().display(), dst.display(), e))?;
        copied_pdfs += 1;
    }

    if copied_pdfs == 0 && skipped_existing == 0 {
        return Err("No PDF files found in Zotero storage.".to_string());
    }

    let tree = build_tree(&target_root);
    Ok(ZoteroImportResult {
        source_storage_path: storage_root.to_string_lossy().to_string(),
        workspace_path: target_root.to_string_lossy().to_string(),
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

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !app_data_dir.exists() {
        std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    }

    let workspace_root = app_data_dir.join("workspace");
    if !workspace_root.exists() {
        std::fs::create_dir_all(&workspace_root).map_err(|e| e.to_string())?;
    }

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

    let tree = build_tree(&target_root);
    Ok(WorkspaceImportResult {
        source_path: source_root.to_string_lossy().to_string(),
        workspace_path: target_root.to_string_lossy().to_string(),
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

fn save_inference_settings_to_disk(app: &AppHandle, settings: &InferenceSettings) -> Result<(), String> {
    let path = inference_settings_file_path(app)?;
    let content = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_inference_settings(state: State<'_, InferenceSettingsState>) -> Result<InferenceSettings, String> {
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
async fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
         // Try dbus or xdg-open (xdg-open usually opens the file, not folder)
         // For now, just open the parent folder
         use std::process::Command;
         if let Some(parent) = std::path::Path::new(&path).parent() {
             Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| e.to_string())?;
         }
    }
    Ok(())
}

#[tauri::command]
async fn open_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
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

fn extract_text_from_pdf_operation(op: &lopdf::content::Operation) -> Option<String> {
    if op.operator != "Tj" && op.operator != "TJ" {
        return None;
    }

    let mut text = String::new();
    for arg in &op.operands {
        match arg {
            lopdf::Object::String(bytes, _) => {
                text.push_str(&String::from_utf8_lossy(bytes));
            }
            lopdf::Object::Array(arr) => {
                for item in arr {
                    if let lopdf::Object::String(bytes, _) = item {
                        text.push_str(&String::from_utf8_lossy(bytes));
                    }
                }
            }
            _ => {}
        }
    }

    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

#[tauri::command]
async fn extract_pdf_page_text(path: String, page: u32) -> Result<String, String> {
    let page_index = page.saturating_sub(1) as usize;
    let doc = lopdf::Document::load(&path).map_err(|e| e.to_string())?;
    let pages = doc.get_pages();
    let page_id = pages
        .iter()
        .nth(page_index)
        .map(|(_, id)| *id)
        .ok_or_else(|| format!("Page {} not found.", page))?;

    let raw_content = doc.get_page_content(page_id).map_err(|e| e.to_string())?;
    let content = lopdf::content::Content::decode(&raw_content).map_err(|e| e.to_string())?;
    let mut text = String::new();
    for operation in &content.operations {
        if let Some(fragment) = extract_text_from_pdf_operation(operation) {
            text.push_str(&fragment);
            text.push(' ');
        }
    }

    Ok(text.trim().to_string())
}

#[tauri::command]
async fn check_ollama_status() -> bool {
    let client = reqwest::Client::new();
    client.get("http://localhost:11434")
        .send()
        .await
        .is_ok()
}

use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

#[tauri::command]
async fn start_ollama(app: AppHandle) -> Result<String, String> {
    // Check for system proxy settings
    let http_proxy = std::env::var("HTTP_PROXY").ok();
    let https_proxy = std::env::var("HTTPS_PROXY").ok();
    
    if let Some(proxy) = &http_proxy {
        println!("Detected HTTP_PROXY: {}", proxy);
    }
    if let Some(proxy) = &https_proxy {
        println!("Detected HTTPS_PROXY: {}", proxy);
    }

    // Keep Ollama models in app data dir to avoid repeated downloads.
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !app_data_dir.exists() {
        std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    }
    let models_dir = app_data_dir.join("ollama_models");
    if !models_dir.exists() {
        std::fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;
    }

    // Use Tauri sidecar API to spawn bundled ollama
    let mut sidecar_command = app.shell().sidecar("ollama")
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
    sidecar_command = sidecar_command.env("OLLAMA_MODELS", models_dir.to_string_lossy().to_string());

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

    Ok("Ollama sidecar started".to_string())
}

#[tauri::command]
async fn pull_model_from_modelscope(name: String, url: String, filename: String, window: Window) -> Result<(), String> {
    use std::io::Write;
    use tauri::Manager;

    let app_handle = window.app_handle();
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    
    if !app_data_dir.exists() {
        std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    }

    let temp_dir = app_data_dir.join("temp_models");
    if !temp_dir.exists() {
        std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    }

    let gguf_path = temp_dir.join(&filename);
    
    // 1. Download GGUF
    let client = reqwest::Client::new();
    let res = client.get(&url).send().await.map_err(|e| format!("Failed to connect to mirror: {}", e))?;
    
    if !res.status().is_success() {
        return Err(format!("Mirror download failed: {}", res.status()));
    }

    let total_size = res.content_length().unwrap_or(0);
    let mut stream = res.bytes_stream();
    let mut file = std::fs::File::create(&gguf_path).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;

        // Emit progress
        let _ = window.emit("pull-progress", &PullProgress {
            status: format!("Downloading from mirror: {}/{}", downloaded, total_size),
            digest: None,
            total: Some(total_size),
            completed: Some(downloaded),
        });
    }

    // 2. Create Modelfile
    let modelfile_path = temp_dir.join("Modelfile");
    let modelfile_content = format!("FROM \"{}\"", gguf_path.to_string_lossy().replace("\\", "/"));
    std::fs::write(&modelfile_path, modelfile_content).map_err(|e| e.to_string())?;

    // 3. Call Ollama Create API
    let _ = window.emit("pull-progress", &PullProgress {
        status: "Importing model into Ollama...".to_string(),
        digest: None,
        total: None,
        completed: None,
    });

    let client = reqwest::Client::new();
    let res = client.post("http://localhost:11434/api/create")
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
            if let Ok(_text) = String::from_utf8(bytes.to_vec()) {
                // Parse JSON progress if needed, or just keep "Importing..."
            }
        }
    }

    // Cleanup
    let _ = std::fs::remove_file(gguf_path);
    let _ = std::fs::remove_file(modelfile_path);

    Ok(())
}

#[tauri::command]
async fn resolve_hf_gguf(repo: String) -> Result<HfResolveResult, String> {
    let api_url = format!("https://huggingface.co/api/models/{}", repo);
    let client = reqwest::Client::new();
    let res = client.get(api_url)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Hugging Face API: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("Hugging Face API error: {}", res.status()));
    }

    let info: HfApiResponse = res.json().await.map_err(|e| e.to_string())?;
    let mut gguf_files: Vec<String> = info.siblings
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
    state: State<'_, RagState>,
    app: AppHandle,
    window: Window,
) -> Result<usize, String> {
    let selected_mode = mode.unwrap_or_default();
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel::<IngestProgress>();
    let progress_window = window.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(progress) = progress_rx.recv().await {
            let _ = progress_window.emit("ingest-progress", &progress);
        }
    });

    let count = state
        .ingest_directory(&path, &model, selected_mode, Some(progress_tx))
        .await
        .map_err(|e| e.to_string())?;
    
    // Save to disk
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        if !app_data_dir.exists() {
            let _ = std::fs::create_dir_all(&app_data_dir);
        }
        let db_path = app_data_dir.join("knowledge_base.json");
        if let Err(e) = state.save(db_path.to_str().unwrap()).await {
            println!("Failed to save database: {}", e);
        }
    }
    
    Ok(count)
}

#[tauri::command]
async fn query_knowledge_base(query: String, state: State<'_, RagState>) -> Result<Vec<Document>, String> {
    state.search(&query, 5).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_ollama_models() -> Result<Vec<OllamaModel>, String> {
    let client = reqwest::Client::new();
    let res = client.get("http://localhost:11434/api/tags")
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
async fn pull_ollama_model(name: String, window: Window) -> Result<(), String> {
    let client = reqwest::Client::new();
    let res = client.post("http://localhost:11434/api/pull")
        .json(&serde_json::json!({ "name": name, "stream": true }))
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
                // Ollama can send multiple JSON objects in one chunk
                if let Ok(text) = String::from_utf8(bytes.to_vec()) {
                    for line in text.lines() {
                        if !line.trim().is_empty() {
                            if let Ok(progress) = serde_json::from_str::<PullProgress>(line) {
                                let _ = window.emit("pull-progress", &progress);
                            }
                        }
                    }
                }
            }
            Err(e) => return Err(format!("Stream error: {}", e)),
        }
    }

    Ok(())
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

async fn chat_via_ollama(
    query: &str,
    context: &str,
    model: &str,
    image_path: Option<&str>,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let prompt = format!(
        "Answer the question using the context below. If the answer is not in the context, say so.\n\nContext:\n{}\n\nQuestion:\n{}",
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

    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": "You are a helpful research assistant." },
            user_message
        ],
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
    json.get("message")
        .and_then(|v| v.get("content"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "LLM response did not include content".to_string())
}

async fn route_chat_completion(
    query: &str,
    context: &str,
    model: &str,
    image_path: Option<&str>,
    mode: InferenceMode,
) -> Result<String, String> {
    match mode {
        InferenceMode::SingleMm => chat_via_ollama(query, context, model, image_path).await,
        InferenceMode::DualPipeline => {
            // Skeleton only: dual pipeline currently falls back to single-model chat.
            // Future implementation can split text and vision inference, then merge evidence.
            chat_via_ollama(query, context, model, image_path).await
        }
    }
}

#[tauri::command]
async fn chat_with_llm(
    query: String,
    context: String,
    model: String,
    image_path: Option<String>,
    settings_state: State<'_, InferenceSettingsState>,
) -> Result<String, String> {
    let settings = settings_state.get()?;
    let normalized_image_path = normalize_optional_path(image_path);
    route_chat_completion(
        &query,
        &context,
        &model,
        normalized_image_path.as_deref(),
        settings.mode,
    )
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let rag_state = RagState::new();
    let inference_settings_state = InferenceSettingsState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(rag_state)
        .manage(inference_settings_state)
        .setup(|app| {
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
            
            // Try to load existing database
            if let Ok(app_data_dir) = handle.path().app_data_dir() {
                 let db_path = app_data_dir.join("knowledge_base.json");
                 if db_path.exists() {
                     let path_str = db_path.to_string_lossy().to_string();
                     let load_handle = handle.clone();
                     tauri::async_runtime::spawn(async move {
                         let state = load_handle.state::<RagState>();
                         if let Err(e) = state.load(&path_str).await {
                             println!("Failed to load database: {}", e);
                         } else {
                             println!("Loaded database from {}", path_str);
                         }
                     });
                 }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet, 
            scan_directory, 
            import_directory_to_workspace,
            import_zotero_storage_to_workspace,
            detect_zotero_storage,
            ingest_knowledge_base, 
            query_knowledge_base,
            get_ollama_models,
            pull_ollama_model,
            pull_model_from_modelscope,
            resolve_hf_gguf,
            get_inference_settings,
            set_inference_mode,
            chat_with_llm,
            reveal_in_explorer,
            open_file,
            read_file_base64,
            write_text_file,
            extract_pdf_page_text,
            check_ollama_status,
            start_ollama
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



