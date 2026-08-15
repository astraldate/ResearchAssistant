use axum::{
    body::{Body, Bytes},
    extract::{Path as AxumPath, Query, State as AxumState},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::net::{IpAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, watch};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::cards::{self, KnowledgeCardDetail};
use crate::chat_queue::{ChatPriority, ChatQueuePermit, LlmChatQueueState};
use crate::encyclopedia::TermLookupMode;
use crate::research_memory::{self, ResearchSearchScope};

const MOBILE_API_VERSION: &str = "2026-08-10.v2";
const MOBILE_SERVICE_NAME: &str = "Research Assistant Desktop";
const MOBILE_STATE_FILE_NAME: &str = "mobile_companion.json";
const REVIEW_STATE_DIR_NAME: &str = "review_state";
const REVIEW_STATE_FILE_NAME: &str = "reviews.json";
const MOBILE_INBOX_DIR_NAME: &str = "mobile_inbox";
const MOBILE_INBOX_ASSET_DIR_NAME: &str = "assets";
const MOBILE_CHAT_DIR_NAME: &str = "mobile_chat_threads";
const MOBILE_CHAT_SETTINGS_FILE_NAME: &str = "mobile_chat_settings.json";
const DEMO_LIBRARY_FILE_NAME: &str = "demo_library.json";
const MOBILE_CHAT_DEFAULT_MODEL: &str = "qwen3.5:9b";
const MOBILE_TRANSLATION_DEFAULT_MODEL: &str = "MedAIBase/Tencent-HY-MT1.5:1.8b-q4_K_M";
const MOBILE_CHAT_HISTORY_LIMIT: usize = 12;
const MOBILE_CHAT_RETRIEVAL_LIMIT: usize = 5;
const MOBILE_CHAT_QUEUE_TIMEOUT_SECS: u64 = 45;
const MOBILE_CHAT_CANCEL_TTL_SECS: u64 = 10;
const MOBILE_CHAT_STREAM_CLOSED: &str = "移动端流连接已关闭。";
const MOBILE_PORT_CANDIDATES: [u16; 5] = [38465, 38466, 38467, 38468, 38469];

#[cfg(target_os = "windows")]
fn suppress_command_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn suppress_command_window(_command: &mut Command) {}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairedDeviceSummary {
    pub device_id: String,
    pub device_name: String,
    pub paired_at: String,
    pub last_seen_at: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileCompanionStatus {
    pub api_version: String,
    pub service_name: String,
    pub pair_code: String,
    pub listener_port: u16,
    pub base_urls: Vec<String>,
    pub paired_devices: Vec<PairedDeviceSummary>,
    pub inbox_count: usize,
    pub review_record_count: usize,
    pub card_count: usize,
    pub running: bool,
    pub last_error: Option<String>,
    pub inbox_dir: String,
    pub review_state_dir: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileHealthResponse {
    pub api_version: String,
    pub service_name: String,
    pub running: bool,
    pub base_urls: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobilePairRequest {
    pub pair_code: String,
    pub device_name: String,
    pub app_version: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobilePairResponse {
    pub api_version: String,
    pub service_name: String,
    pub device_id: String,
    pub device_token: String,
    pub paired_at: String,
    pub base_urls: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileCardRecord {
    pub id: String,
    pub term: String,
    pub title: String,
    pub created_at: String,
    pub preview: String,
    pub markdown: String,
    pub source_provider: Option<String>,
    pub source_status: String,
    pub lookup_mode: String,
    pub has_pdf: bool,
    pub pdf_path: Option<String>,
    pub pdf_page: Option<u32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileNoteRecord {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub source_paper: Option<String>,
    pub preview: String,
    pub markdown: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileDeleteResponse {
    pub id: String,
    pub deleted: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileCardWriteRequest {
    pub term: String,
    #[serde(default)]
    pub title: String,
    pub markdown: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileNoteWriteRequest {
    pub title: String,
    pub markdown: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobilePaperRecord {
    pub paper_id: String,
    pub title: String,
    pub paper_type: String,
    pub updated_at: String,
    pub has_pdf: bool,
    pub source_type: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct DemoLibrarySettings {
    enabled: bool,
    visible_file_names: Vec<String>,
}

impl Default for DemoLibrarySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            visible_file_names: vec![
                "Tan 等 - 2025 - Integration of Single-Cell Analysis and Bulk RNA Sequencing Data Using Multi-Level Attention Graph N.pdf".to_string(),
                "Tejada-Lapuerta 等 - 2025 - Causal machine learning for single-cell genomics.pdf".to_string(),
                "Raj 等 - 2012 - A network diffusion model of disease progression in dementia.pdf".to_string(),
                "Liu 等 - 2024 - TP-GNN Continuous Dynamic Graph Neural Network for Graph Classification.pdf".to_string(),
                "Ali 等 - 2025 - Graph neural networks in alzheimer's disease diagnosis a review of unimodal and multimodal advances.pdf".to_string(),
                "2024 - Self-explainable graph neural network for alzheimer disease and related dementias risk prediction a.pdf".to_string(),
            ],
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReviewRating {
    Again,
    Hard,
    Good,
    Easy,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReviewHistoryEntry {
    pub event_id: String,
    pub rating: ReviewRating,
    pub reviewed_at: String,
    pub device_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRecord {
    pub card_id: String,
    pub due_at: String,
    pub interval_days: f32,
    pub ease_factor: f32,
    pub lapses: u32,
    pub consecutive_successes: u32,
    pub total_reviews: u32,
    pub last_rating: Option<ReviewRating>,
    pub last_reviewed_at: Option<String>,
    pub history: Vec<ReviewHistoryEntry>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileReviewEvent {
    pub event_id: String,
    pub card_id: String,
    pub rating: ReviewRating,
    pub reviewed_at: String,
    pub device_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSyncRequest {
    pub events: Vec<MobileReviewEvent>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSyncResponse {
    pub accepted_event_ids: Vec<String>,
    pub review_records: Vec<ReviewRecord>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MobileCaptureKind {
    Image,
    Url,
    Note,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MobileInboxStatus {
    Received,
    Processed,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileInboxItemInput {
    pub capture_kind: MobileCaptureKind,
    pub title: Option<String>,
    pub note: Option<String>,
    pub url: Option<String>,
    pub file_name: Option<String>,
    pub mime_type: Option<String>,
    pub asset_base64: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileInboxItem {
    pub id: String,
    pub capture_kind: MobileCaptureKind,
    pub status: MobileInboxStatus,
    pub title: Option<String>,
    pub note: Option<String>,
    pub url: Option<String>,
    pub file_name: Option<String>,
    pub mime_type: Option<String>,
    pub stored_asset_path: Option<String>,
    pub device_id: String,
    pub created_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMobileInboxItem {
    pub id: String,
    pub capture_kind: MobileCaptureKind,
    pub status: MobileInboxStatus,
    pub title: Option<String>,
    pub note: Option<String>,
    pub url: Option<String>,
    pub file_name: Option<String>,
    pub mime_type: Option<String>,
    pub stored_asset_path: Option<String>,
    pub device_id: String,
    pub created_at: String,
    pub record_path: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileBootstrapResponse {
    pub service: MobileCompanionStatus,
    pub cards: Vec<MobileCardRecord>,
    pub notes: Vec<MobileNoteRecord>,
    pub review_records: Vec<ReviewRecord>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MobileChatRole {
    User,
    Assistant,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MobileChatSource {
    Mobile,
    Desktop,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MobileChatMessageStatus {
    Complete,
    Streaming,
    Error,
    Interrupted,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MobileChatThreadStatus {
    Idle,
    Streaming,
    Error,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MobilePdfSourceType {
    Card,
    Paper,
    WorkspacePdf,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobilePdfSource {
    pub source_type: MobilePdfSourceType,
    pub source_id: String,
    pub page: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileCitation {
    pub label: String,
    pub paper_id: String,
    pub title: String,
    pub page_start: i64,
    pub page_end: i64,
    pub snippet: String,
    pub source_type: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileInnovationAnalysis {
    pub concept_a: String,
    pub concept_b: String,
    #[serde(default)]
    pub concept_a_expansion: Option<String>,
    #[serde(default)]
    pub concept_b_expansion: Option<String>,
    #[serde(default)]
    pub evidence_status: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileInnovationIntentRequest {
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MobileInnovationIntent {
    pub detected: bool,
    pub concept_a: Option<String>,
    pub concept_b: Option<String>,
    pub concept_a_expansion: Option<String>,
    pub concept_b_expansion: Option<String>,
    pub concept_a_role: Option<String>,
    pub concept_b_role: Option<String>,
    pub ambiguity_note: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobilePdfTranslateSelectionRequest {
    #[serde(flatten)]
    pub source: MobilePdfSource,
    pub text: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobilePdfTranslatePageRequest {
    #[serde(flatten)]
    pub source: MobilePdfSource,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobilePdfExplainSelectionRequest {
    #[serde(flatten)]
    pub source: MobilePdfSource,
    pub term: String,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub lookup_mode: TermLookupMode,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobilePdfSaveExplanationCardRequest {
    #[serde(flatten)]
    pub source: MobilePdfSource,
    pub selected_text: String,
    pub explanation: MobilePdfExplanationPayload,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobilePdfExplanationPayload {
    pub term: String,
    pub plain_summary: String,
    pub source_title: Option<String>,
    pub source_url: Option<String>,
    pub source_provider: Option<String>,
    pub source_lang: Option<String>,
    pub source_extract: Option<String>,
    pub page_context_snippet: Option<String>,
    pub source_status: String,
    pub lookup_mode: TermLookupMode,
    #[serde(default)]
    pub model_used: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileChatMessage {
    pub message_id: String,
    pub role: MobileChatRole,
    pub content: String,
    pub created_at: String,
    pub source: MobileChatSource,
    pub status: MobileChatMessageStatus,
    #[serde(default)]
    pub citations: Vec<MobileCitation>,
    #[serde(default)]
    pub innovation_analysis: Option<MobileInnovationAnalysis>,
    #[serde(default)]
    pub idea_id: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub paper_context: Option<MobileChatPaperContext>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileChatPaperContext {
    pub source_type: String,
    pub source_id: String,
    pub title: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileChatThread {
    pub thread_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub model: String,
    pub status: MobileChatThreadStatus,
    pub messages: Vec<MobileChatMessage>,
    pub last_error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileChatThreadSummary {
    pub thread_id: String,
    pub title: String,
    pub updated_at: String,
    pub model: String,
    pub status: MobileChatThreadStatus,
    pub last_message_preview: String,
    pub message_count: usize,
    pub last_error: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileChatSendRequest {
    pub message: String,
    #[serde(default)]
    pub client_request_id: Option<String>,
    #[serde(default)]
    pub use_retrieval: Option<bool>,
    #[serde(default)]
    pub thinking_enabled: Option<bool>,
    #[serde(default)]
    pub innovation_analysis: Option<MobileInnovationAnalysis>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub paper_context: Option<MobileChatPaperContext>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct MobileChatCancelRequest {
    client_request_id: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct MobileChatCancelResponse {
    client_request_id: String,
    cancelled: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct MobileChatSettings {
    #[serde(default = "default_mobile_chat_model")]
    model: String,
    #[serde(default = "default_mobile_translation_model")]
    translation_model: String,
}

fn default_mobile_chat_model() -> String {
    MOBILE_CHAT_DEFAULT_MODEL.to_string()
}

fn default_mobile_translation_model() -> String {
    MOBILE_TRANSLATION_DEFAULT_MODEL.to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct StoredMobileCompanionState {
    pair_code: String,
    paired_devices: Vec<PairedDeviceRecord>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct PairedDeviceRecord {
    device_id: String,
    device_name: String,
    token: String,
    paired_at: String,
    last_seen_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct StoredReviewState {
    records: HashMap<String, ReviewRecord>,
    applied_event_ids: HashSet<String>,
}

#[derive(Clone, Debug, Default)]
struct MobileCompanionRuntime {
    pair_code: String,
    paired_devices: Vec<PairedDeviceRecord>,
    listener_port: u16,
    base_urls: Vec<String>,
    running: bool,
    last_error: Option<String>,
}

#[derive(Clone, Default)]
pub struct MobileCompanionState {
    inner: Arc<Mutex<MobileCompanionRuntime>>,
}

#[derive(Clone)]
struct MobileRouterState {
    app: AppHandle,
    mobile_state: MobileCompanionState,
    chat_queue: LlmChatQueueState,
    chat_cancellations: MobileChatCancellationRegistry,
}

type MobileChatCancellationRegistry = Arc<Mutex<HashMap<String, MobileChatCancellationEntry>>>;

#[derive(Clone)]
enum MobileChatCancellationEntry {
    Pending(watch::Sender<bool>),
    Active(watch::Sender<bool>),
}

#[derive(Default)]
struct MobileChatTaskContext {
    thread_id: Option<String>,
    assistant_id: Option<String>,
}

impl MobileCompanionState {
    pub fn new() -> Self {
        Self::default()
    }

    fn snapshot(&self) -> Result<MobileCompanionRuntime, String> {
        self.inner
            .lock()
            .map(|guard| guard.clone())
            .map_err(|error| format!("Failed to lock mobile companion state: {}", error))
    }
}

pub fn initialize_mobile_companion(
    app: AppHandle,
    state: MobileCompanionState,
) -> Result<(), String> {
    ensure_mobile_dirs(&app)?;
    recover_interrupted_mobile_chat_threads(&app)?;

    let mut stored = read_stored_mobile_state(&app)?;
    if stored.pair_code.trim().is_empty() {
        stored.pair_code = generate_pair_code();
        write_stored_mobile_state(&app, &stored)?;
    }

    {
        let mut runtime = state
            .inner
            .lock()
            .map_err(|error| format!("Failed to lock mobile companion runtime: {}", error))?;
        runtime.pair_code = stored.pair_code.clone();
        runtime.paired_devices = stored.paired_devices.clone();
        runtime.listener_port = 0;
        runtime.base_urls.clear();
        runtime.running = false;
        runtime.last_error = None;
    }

    match bind_mobile_listener() {
        Ok((listener, port)) => {
            let base_urls = detect_base_urls(port);
            {
                let mut runtime = state.inner.lock().map_err(|error| {
                    format!("Failed to lock mobile companion runtime: {}", error)
                })?;
                runtime.listener_port = port;
                runtime.base_urls = base_urls;
                runtime.running = true;
                runtime.last_error = None;
            }

            let app_handle = app.clone();
            let state_handle = state.clone();
            configure_tailscale_tcp_serve_background(state.clone(), port);
            tauri::async_runtime::spawn(async move {
                let listener = match TcpListener::from_std(listener) {
                    Ok(value) => value,
                    Err(error) => {
                        if let Ok(mut runtime) = state_handle.inner.lock() {
                            runtime.running = false;
                            runtime.last_error = Some(format!(
                                "Failed to attach mobile companion listener to Tokio runtime: {}",
                                error
                            ));
                        }
                        return;
                    }
                };
                let router_state = MobileRouterState {
                    chat_queue: app_handle.state::<LlmChatQueueState>().inner().clone(),
                    app: app_handle.clone(),
                    mobile_state: state_handle.clone(),
                    chat_cancellations: Arc::new(Mutex::new(HashMap::new())),
                };
                if let Err(error) = axum::serve(listener, build_mobile_router(router_state)).await {
                    if let Ok(mut runtime) = state_handle.inner.lock() {
                        runtime.running = false;
                        runtime.last_error =
                            Some(format!("Mobile companion axum service stopped: {}", error));
                    }
                }
            });
        }
        Err(error) => {
            let mut runtime = state.inner.lock().map_err(|lock_error| {
                format!("Failed to lock mobile companion runtime: {}", lock_error)
            })?;
            runtime.running = false;
            runtime.last_error = Some(error);
        }
    }

    Ok(())
}

pub fn get_mobile_companion_status(
    app: &AppHandle,
    state: &MobileCompanionState,
) -> Result<MobileCompanionStatus, String> {
    build_mobile_status(app, state)
}

pub fn refresh_mobile_pair_code(
    app: &AppHandle,
    state: &MobileCompanionState,
) -> Result<MobileCompanionStatus, String> {
    {
        let mut runtime = state
            .inner
            .lock()
            .map_err(|error| format!("Failed to lock mobile companion runtime: {}", error))?;
        runtime.pair_code = generate_pair_code();
    }
    persist_runtime_state(app, state)?;
    build_mobile_status(app, state)
}

pub fn list_mobile_inbox_items(app: &AppHandle) -> Result<Vec<DesktopMobileInboxItem>, String> {
    ensure_mobile_dirs(app)?;
    let mut items = Vec::new();

    for path in mobile_inbox_record_paths(app)? {
        let item = match read_mobile_inbox_item_file(&path) {
            Ok(value) => value,
            Err(error) => {
                eprintln!(
                    "Failed to load mobile inbox item '{}': {}",
                    path.display(),
                    error
                );
                continue;
            }
        };
        items.push(map_desktop_mobile_inbox_item(item, path));
    }

    items.sort_by(|left, right| {
        mobile_inbox_status_rank(left.status)
            .cmp(&mobile_inbox_status_rank(right.status))
            .then_with(|| right.created_at.cmp(&left.created_at))
    });
    Ok(items)
}

pub fn set_mobile_inbox_item_status(
    app: &AppHandle,
    item_id: &str,
    processed: bool,
) -> Result<DesktopMobileInboxItem, String> {
    ensure_mobile_dirs(app)?;
    let normalized_id = item_id.trim();
    if normalized_id.is_empty() {
        return Err("Inbox item id must not be empty.".to_string());
    }

    let (mut item, path) = find_mobile_inbox_item_by_id(app, normalized_id)?;
    item.status = if processed {
        MobileInboxStatus::Processed
    } else {
        MobileInboxStatus::Received
    };
    write_mobile_inbox_item_file(&path, &item)?;
    Ok(map_desktop_mobile_inbox_item(item, path))
}

fn build_mobile_router(state: MobileRouterState) -> Router {
    Router::new()
        .route("/api/mobile/v1/health", get(axum_mobile_health))
        .route("/api/mobile/v1/pair", post(axum_mobile_pair))
        .route("/api/mobile/v1/bootstrap", get(axum_mobile_bootstrap))
        .route(
            "/api/mobile/v1/review-events",
            post(axum_mobile_review_events),
        )
        .route("/api/mobile/v1/inbox/items", post(axum_mobile_inbox_item))
        .route("/api/mobile/v1/papers", get(axum_mobile_papers))
        .route("/api/mobile/v1/cards", post(axum_create_mobile_card))
        .route(
            "/api/mobile/v1/cards/{card_id}/pdf",
            get(axum_mobile_card_pdf),
        )
        .route(
            "/api/mobile/v1/cards/{card_id}",
            patch(axum_update_mobile_card).delete(axum_delete_mobile_card),
        )
        .route("/api/mobile/v1/notes", post(axum_create_mobile_note))
        .route(
            "/api/mobile/v1/notes/{note_id}",
            patch(axum_update_mobile_note).delete(axum_delete_mobile_note),
        )
        .route(
            "/api/mobile/v1/papers/{paper_id}/pdf",
            get(axum_mobile_paper_pdf),
        )
        .route(
            "/api/mobile/v1/workspace-pdfs/{pdf_id}/pdf",
            get(axum_mobile_workspace_pdf),
        )
        .route("/api/mobile/v1/pdf-viewer", get(axum_mobile_pdf_viewer))
        .route(
            "/api/mobile/v1/pdf-viewer/pdf-content",
            get(axum_mobile_pdf_viewer_content),
        )
        .route(
            "/api/mobile/v1/pdf-viewer/assets/{asset}",
            get(axum_mobile_pdf_viewer_asset),
        )
        .route(
            "/api/mobile/v1/pdf/translate-selection",
            post(axum_mobile_pdf_translate_selection),
        )
        .route(
            "/api/mobile/v1/pdf/translate-page",
            post(axum_mobile_pdf_translate_page),
        )
        .route(
            "/api/mobile/v1/pdf/explain-selection",
            post(axum_mobile_pdf_explain_selection),
        )
        .route(
            "/api/mobile/v1/pdf/save-explanation-card",
            post(axum_mobile_pdf_save_explanation_card),
        )
        .route("/api/mobile/v1/chat/threads", get(axum_list_chat_threads))
        .route(
            "/api/mobile/v1/chat/innovation-intent",
            post(axum_mobile_innovation_intent),
        )
        .route(
            "/api/mobile/v1/chat/cancel",
            post(axum_cancel_mobile_chat_generation),
        )
        .route(
            "/api/mobile/v1/chat/threads/{thread_id}",
            get(axum_read_chat_thread).delete(axum_delete_chat_thread),
        )
        .route(
            "/api/mobile/v1/chat/threads/stream",
            post(axum_create_chat_thread_stream),
        )
        .route(
            "/api/mobile/v1/chat/threads/{thread_id}/messages/stream",
            post(axum_continue_chat_thread_stream),
        )
        .route(
            "/api/mobile/v1/chat/threads/{thread_id}/innovation-results/{message_id}",
            delete(axum_delete_mobile_innovation_result),
        )
        .route(
            "/api/mobile/v1/ideas/{idea_id}",
            delete(axum_delete_mobile_idea),
        )
        .with_state(state)
}

async fn axum_mobile_health(AxumState(state): AxumState<MobileRouterState>) -> impl IntoResponse {
    let snapshot = state
        .mobile_state
        .snapshot()
        .unwrap_or_else(|_| MobileCompanionRuntime::default());
    Json(MobileHealthResponse {
        api_version: MOBILE_API_VERSION.to_string(),
        service_name: MOBILE_SERVICE_NAME.to_string(),
        running: snapshot.running,
        base_urls: detect_base_urls(snapshot.listener_port),
    })
}

async fn axum_mobile_pair(
    AxumState(state): AxumState<MobileRouterState>,
    Json(payload): Json<MobilePairRequest>,
) -> Response {
    match pair_device(&state.app, &state.mobile_state, payload) {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => (StatusCode::FORBIDDEN, error).into_response(),
    }
}

async fn axum_mobile_bootstrap(
    AxumState(state): AxumState<MobileRouterState>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    match load_bootstrap_payload(&state.app, &state.mobile_state) {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
    }
}

async fn axum_mobile_review_events(
    AxumState(state): AxumState<MobileRouterState>,
    headers: HeaderMap,
    Json(payload): Json<ReviewSyncRequest>,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    match apply_review_events(&state.app, payload) {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
    }
}

async fn axum_mobile_inbox_item(
    AxumState(state): AxumState<MobileRouterState>,
    headers: HeaderMap,
    Json(payload): Json<MobileInboxItemInput>,
) -> Response {
    let device = match authorize_headers(&state.app, &state.mobile_state, &headers) {
        Ok(device) => device,
        Err(error) => return (StatusCode::UNAUTHORIZED, error).into_response(),
    };
    match store_inbox_item(&state.app, &device.device_id, payload) {
        Ok(item) => (StatusCode::OK, Json(item)).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
    }
}

async fn axum_mobile_papers(
    AxumState(state): AxumState<MobileRouterState>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    match load_mobile_papers(&state.app).await {
        Ok(papers) => (StatusCode::OK, Json(papers)).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
    }
}

async fn axum_mobile_card_pdf(
    AxumState(state): AxumState<MobileRouterState>,
    AxumPath(card_id): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    match resolve_card_pdf_download(&state.app, &card_id) {
        Ok(download) => match build_pdf_download_response(download, &headers) {
            Ok(response) => response,
            Err((status, error)) => (status, error).into_response(),
        },
        Err(error) => (StatusCode::NOT_FOUND, error).into_response(),
    }
}

async fn axum_create_mobile_card(
    AxumState(state): AxumState<MobileRouterState>,
    headers: HeaderMap,
    Json(payload): Json<MobileCardWriteRequest>,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    match create_mobile_card(&state.app, payload) {
        Ok(card) => (StatusCode::CREATED, Json(card)).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}

async fn axum_update_mobile_card(
    AxumState(state): AxumState<MobileRouterState>,
    AxumPath(card_id): AxumPath<String>,
    headers: HeaderMap,
    Json(payload): Json<MobileCardWriteRequest>,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    match update_mobile_card(&state.app, &card_id, payload) {
        Ok(card) => (StatusCode::OK, Json(card)).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}

async fn axum_delete_mobile_card(
    AxumState(state): AxumState<MobileRouterState>,
    AxumPath(card_id): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    match delete_mobile_card(&state.app, &card_id) {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => (StatusCode::NOT_FOUND, error).into_response(),
    }
}

async fn axum_delete_mobile_note(
    AxumState(state): AxumState<MobileRouterState>,
    AxumPath(note_id): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    match delete_mobile_note(&state.app, &note_id) {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => (StatusCode::NOT_FOUND, error).into_response(),
    }
}

async fn axum_create_mobile_note(
    AxumState(state): AxumState<MobileRouterState>,
    headers: HeaderMap,
    Json(payload): Json<MobileNoteWriteRequest>,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    match create_mobile_note(&state.app, payload) {
        Ok(note) => (StatusCode::CREATED, Json(note)).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}

async fn axum_update_mobile_note(
    AxumState(state): AxumState<MobileRouterState>,
    AxumPath(note_id): AxumPath<String>,
    headers: HeaderMap,
    Json(payload): Json<MobileNoteWriteRequest>,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    match update_mobile_note(&state.app, &note_id, payload) {
        Ok(note) => (StatusCode::OK, Json(note)).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}

async fn axum_mobile_paper_pdf(
    AxumState(state): AxumState<MobileRouterState>,
    AxumPath(paper_id): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    match resolve_paper_pdf_download(&state.app, &paper_id).await {
        Ok(download) => match build_pdf_download_response(download, &headers) {
            Ok(response) => response,
            Err((status, error)) => (status, error).into_response(),
        },
        Err(error) => (StatusCode::NOT_FOUND, error).into_response(),
    }
}

async fn axum_mobile_workspace_pdf(
    AxumState(state): AxumState<MobileRouterState>,
    AxumPath(pdf_id): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    match resolve_workspace_pdf_download(&state.app, &pdf_id) {
        Ok(download) => match build_pdf_download_response(download, &headers) {
            Ok(response) => response,
            Err((status, error)) => (status, error).into_response(),
        },
        Err(error) => (StatusCode::NOT_FOUND, error).into_response(),
    }
}

async fn axum_mobile_pdf_viewer(
    AxumState(state): AxumState<MobileRouterState>,
    Query(source): Query<MobilePdfSource>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    if source.page == 0 {
        return (StatusCode::BAD_REQUEST, "页码必须从 1 开始。").into_response();
    }
    if let Err(error) = resolve_mobile_pdf_source(&state.app, &source).await {
        return (StatusCode::NOT_FOUND, error).into_response();
    }
    let token = match bearer_token_from_headers(&headers) {
        Some(token) => token,
        None => return (StatusCode::UNAUTHORIZED, "缺少设备 Token。").into_response(),
    };
    let html = render_mobile_pdf_viewer_html(&source, &token);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .header(
            "content-security-policy",
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:",
        )
        .body(Body::from(html))
        .unwrap_or_else(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response())
}

async fn axum_mobile_pdf_viewer_content(
    AxumState(state): AxumState<MobileRouterState>,
    Query(source): Query<MobilePdfSource>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    match resolve_mobile_pdf_source(&state.app, &source).await {
        Ok(download) => match build_pdf_download_response(download, &headers) {
            Ok(response) => response,
            Err((status, error)) => (status, error).into_response(),
        },
        Err(error) => (StatusCode::NOT_FOUND, error).into_response(),
    }
}

async fn axum_mobile_pdf_viewer_asset(
    AxumState(state): AxumState<MobileRouterState>,
    AxumPath(asset): AxumPath<String>,
) -> Response {
    let (file_name, content_type) = match asset.as_str() {
        "pdf.min.js" => ("pdf.min.js", "application/javascript; charset=utf-8"),
        "pdf.worker.min.js" => ("pdf.worker.min.js", "application/javascript; charset=utf-8"),
        _ => return (StatusCode::NOT_FOUND, "资源不存在。").into_response(),
    };
    match read_pdfjs_asset(&state.app, file_name) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type)
            .header("cache-control", "public, max-age=31536000, immutable")
            .body(Body::from(bytes))
            .unwrap_or_else(|error| {
                (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
            }),
        Err(error) => (StatusCode::NOT_FOUND, error).into_response(),
    }
}

async fn axum_mobile_pdf_translate_selection(
    AxumState(state): AxumState<MobileRouterState>,
    headers: HeaderMap,
    Json(payload): Json<MobilePdfTranslateSelectionRequest>,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    let download = match resolve_mobile_pdf_source(&state.app, &payload.source).await {
        Ok(download) => download,
        Err(error) => return (StatusCode::BAD_REQUEST, error).into_response(),
    };
    let permit = match acquire_mobile_model_permit(&state).await {
        Ok(permit) => permit,
        Err(error) => return (StatusCode::SERVICE_UNAVAILABLE, error).into_response(),
    };
    let request = crate::TranslatePdfSelectionRequest {
        text: payload.text,
        pdf_path: download.path.to_string_lossy().to_string(),
        page: payload.source.page,
        model: get_mobile_translation_model(&state.app),
    };
    let cache = state.app.state::<crate::PdfPageTextCacheState>();
    let result = crate::translate_pdf_selection_with_cache(request, cache.inner()).await;
    permit.release().await;
    match result {
        Ok(result) => (
            StatusCode::OK,
            Json(json!({
                "originalText": result.original_text,
                "translatedText": result.translated_text,
                "page": result.page,
                "generatedAt": result.generated_at,
                "modelUsed": result.model_used,
                "promptVersionUsed": result.prompt_version_used,
            })),
        )
            .into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}

async fn axum_mobile_pdf_translate_page(
    AxumState(state): AxumState<MobileRouterState>,
    headers: HeaderMap,
    Json(payload): Json<MobilePdfTranslatePageRequest>,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    let download = match resolve_mobile_pdf_source(&state.app, &payload.source).await {
        Ok(download) => download,
        Err(error) => return (StatusCode::BAD_REQUEST, error).into_response(),
    };
    let permit = match acquire_mobile_model_permit(&state).await {
        Ok(permit) => permit,
        Err(error) => return (StatusCode::SERVICE_UNAVAILABLE, error).into_response(),
    };
    let request = crate::TranslatePdfPageRequest {
        pdf_path: download.path.to_string_lossy().to_string(),
        page: payload.source.page,
        model: get_mobile_translation_model(&state.app),
    };
    let cache = state.app.state::<crate::PdfPageTextCacheState>();
    let result = crate::translate_pdf_page_with_cache(request, cache.inner()).await;
    permit.release().await;
    match result {
        Ok(result) => (
            StatusCode::OK,
            Json(json!({
                "page": result.page,
                "translatedMarkdown": result.translated_markdown,
                "sourceTextLength": result.source_text_length,
                "generatedAt": result.generated_at,
                "modelUsed": result.model_used,
            })),
        )
            .into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}

async fn axum_mobile_pdf_explain_selection(
    AxumState(state): AxumState<MobileRouterState>,
    headers: HeaderMap,
    Json(payload): Json<MobilePdfExplainSelectionRequest>,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    let download = match resolve_mobile_pdf_source(&state.app, &payload.source).await {
        Ok(download) => download,
        Err(error) => return (StatusCode::BAD_REQUEST, error).into_response(),
    };
    let permit = match acquire_mobile_model_permit(&state).await {
        Ok(permit) => permit,
        Err(error) => return (StatusCode::SERVICE_UNAVAILABLE, error).into_response(),
    };
    let request = crate::ExplainPdfSelectionRequest {
        term: payload.term,
        pdf_path: download.path.to_string_lossy().to_string(),
        page: payload.source.page,
        model: get_mobile_chat_model(&state.app),
        context: payload.context,
        mode: payload.lookup_mode,
    };
    let model_used = request.model.clone();
    let cache = state.app.state::<crate::PdfPageTextCacheState>();
    let result = crate::explain_pdf_selection_with_cache(request, cache.inner()).await;
    permit.release().await;
    match result {
        Ok(result) => (
            StatusCode::OK,
            Json(json!({
                "term": result.term,
                "plainSummary": result.plain_summary,
                "sourceTitle": result.source_title,
                "sourceUrl": result.source_url,
                "sourceProvider": result.source_provider,
                "sourceLang": result.source_lang,
                "sourceExtract": result.source_extract,
                "pageContextSnippet": result.page_context_snippet,
                "sourceStatus": result.source_status,
                "generatedAt": result.generated_at,
                "lookupMode": result.lookup_mode,
                "modelUsed": model_used
            })),
        )
            .into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}

async fn axum_mobile_pdf_save_explanation_card(
    AxumState(state): AxumState<MobileRouterState>,
    headers: HeaderMap,
    Json(payload): Json<MobilePdfSaveExplanationCardRequest>,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    let download = match resolve_mobile_pdf_source(&state.app, &payload.source).await {
        Ok(download) => download,
        Err(error) => return (StatusCode::BAD_REQUEST, error).into_response(),
    };
    let explanation = payload.explanation;
    let explanation_model = explanation
        .model_used
        .clone()
        .unwrap_or_else(|| get_mobile_chat_model(&state.app));
    let request = cards::SaveKnowledgeCardRequest {
        term: explanation.term,
        selected_text: payload.selected_text,
        plain_summary: explanation.plain_summary,
        source_title: explanation.source_title,
        source_url: explanation.source_url,
        source_provider: explanation.source_provider,
        source_lang: explanation.source_lang,
        source_extract: explanation.source_extract,
        page_context_snippet: explanation.page_context_snippet,
        pdf_path: Some(download.path.to_string_lossy().to_string()),
        pdf_page: Some(payload.source.page),
        source_status: explanation.source_status,
        model: explanation_model,
        lookup_mode: explanation.lookup_mode,
    };
    match cards::save_knowledge_card_from_explanation(&state.app, request) {
        Ok(card) => (
            StatusCode::OK,
            Json(json!({
                "id": card.id,
                "term": card.term,
                "title": card.title,
                "createdAt": card.created_at,
                "preview": card.preview,
                "pdfPage": card.pdf_page,
            })),
        )
            .into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
    }
}

async fn axum_list_chat_threads(
    AxumState(state): AxumState<MobileRouterState>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    match list_mobile_chat_threads(&state.app) {
        Ok(threads) => (StatusCode::OK, Json(threads)).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
    }
}

async fn axum_read_chat_thread(
    AxumState(state): AxumState<MobileRouterState>,
    AxumPath(thread_id): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    match read_mobile_chat_thread(&state.app, &thread_id) {
        Ok(thread) => (StatusCode::OK, Json(thread)).into_response(),
        Err(error) => (StatusCode::NOT_FOUND, error).into_response(),
    }
}

async fn axum_delete_chat_thread(
    AxumState(state): AxumState<MobileRouterState>,
    AxumPath(thread_id): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    match delete_mobile_chat_thread(&state.app, &thread_id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => (StatusCode::NOT_FOUND, error).into_response(),
    }
}

async fn axum_delete_mobile_innovation_result(
    AxumState(state): AxumState<MobileRouterState>,
    AxumPath((thread_id, message_id)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    match delete_mobile_innovation_result(&state.app, &thread_id, &message_id) {
        Ok(thread) => (StatusCode::OK, Json(thread)).into_response(),
        Err(error) => (StatusCode::NOT_FOUND, error).into_response(),
    }
}

async fn axum_delete_mobile_idea(
    AxumState(state): AxumState<MobileRouterState>,
    AxumPath(idea_id): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    match research_memory::delete_idea_candidate(&state.app, &idea_id).await {
        Ok((thread_id, message_id)) => {
            if let (Some(thread_id), Some(message_id)) = (thread_id, message_id) {
                let _ = clear_mobile_thread_idea_id(&state.app, &thread_id, &message_id);
            }
            (
                StatusCode::OK,
                Json(MobileDeleteResponse {
                    id: idea_id,
                    deleted: true,
                }),
            )
                .into_response()
        }
        Err(error) => (StatusCode::NOT_FOUND, error.to_string()).into_response(),
    }
}

async fn axum_create_chat_thread_stream(
    AxumState(state): AxumState<MobileRouterState>,
    headers: HeaderMap,
    Json(payload): Json<MobileChatSendRequest>,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    stream_mobile_chat_response(state, None, payload)
}

async fn axum_continue_chat_thread_stream(
    AxumState(state): AxumState<MobileRouterState>,
    AxumPath(thread_id): AxumPath<String>,
    headers: HeaderMap,
    Json(payload): Json<MobileChatSendRequest>,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    stream_mobile_chat_response(state, Some(thread_id), payload)
}

async fn axum_cancel_mobile_chat_generation(
    AxumState(state): AxumState<MobileRouterState>,
    headers: HeaderMap,
    Json(payload): Json<MobileChatCancelRequest>,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    let request_id = payload.client_request_id.trim();
    if !is_valid_mobile_chat_request_id(request_id) {
        return (StatusCode::BAD_REQUEST, "取消请求 ID 无效。").into_response();
    }
    let cancelled = match state.chat_cancellations.lock() {
        Ok(mut cancellations) => {
            if let Some(entry) = cancellations.get(request_id) {
                cancellation_sender(entry).send_replace(true);
            } else {
                // 手机可能在流式请求刚发出时立即点击停止；保留一次取消信号，
                // 等生成请求到达后直接消费，避免出现“先取消、后启动”的竞态。
                let (sender, receiver) = watch::channel(true);
                drop(receiver);
                cancellations.insert(
                    request_id.to_string(),
                    MobileChatCancellationEntry::Pending(sender),
                );
                let cancellations = state.chat_cancellations.clone();
                let request_id = request_id.to_string();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(MOBILE_CHAT_CANCEL_TTL_SECS)).await;
                    if let Ok(mut entries) = cancellations.lock() {
                        let is_unclaimed = matches!(
                            entries.get(&request_id),
                            Some(MobileChatCancellationEntry::Pending(_))
                        );
                        if is_unclaimed {
                            entries.remove(&request_id);
                        }
                    }
                });
            }
            true
        }
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "无法访问桌面端生成任务状态。",
            )
                .into_response();
        }
    };
    (
        StatusCode::OK,
        Json(MobileChatCancelResponse {
            client_request_id: request_id.to_string(),
            cancelled,
        }),
    )
        .into_response()
}

async fn axum_mobile_innovation_intent(
    AxumState(state): AxumState<MobileRouterState>,
    headers: HeaderMap,
    Json(payload): Json<MobileInnovationIntentRequest>,
) -> Response {
    if let Err(error) = authorize_headers(&state.app, &state.mobile_state, &headers) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    let message = payload.message.trim();
    if message.is_empty() {
        return (StatusCode::BAD_REQUEST, "消息不能为空。").into_response();
    }
    let fallback = heuristic_innovation_intent(message);
    if !fallback.detected {
        return (StatusCode::OK, Json(fallback)).into_response();
    }
    let permit = match acquire_mobile_model_permit(&state).await {
        Ok(permit) => permit,
        Err(_) => return (StatusCode::OK, Json(fallback)).into_response(),
    };
    let result =
        detect_mobile_innovation_intent_with_model(&get_mobile_chat_model(&state.app), message)
            .await;
    permit.release().await;
    (StatusCode::OK, Json(result.unwrap_or(fallback))).into_response()
}

fn heuristic_innovation_intent(message: &str) -> MobileInnovationIntent {
    let normalized = message.trim();
    let candidate = normalized.contains('+')
        || normalized.contains('＋')
        || normalized.contains("结合")
        || (normalized.contains('在')
            && normalized.contains('上')
            && (normalized.contains("使用") || normalized.contains("应用")));
    if !candidate {
        return MobileInnovationIntent::default();
    }
    let mut concept_a = None;
    let mut concept_b = None;
    for separator in ["+", "＋", "结合"] {
        if let Some((left, right)) = normalized.split_once(separator) {
            concept_a = clean_innovation_concept(left);
            concept_b = clean_innovation_concept(right);
            break;
        }
    }
    if concept_a.is_none() || concept_b.is_none() {
        if let Some(after_in) = normalized.split_once('在').map(|(_, value)| value) {
            for separator in ["上使用", "上应用"] {
                if let Some((left, right)) = after_in.split_once(separator) {
                    concept_a = clean_innovation_concept(left);
                    concept_b = clean_innovation_concept(right);
                    break;
                }
            }
        }
    }
    MobileInnovationIntent {
        detected: true,
        concept_a,
        concept_b,
        concept_a_role: Some("研究对象或问题".to_string()),
        concept_b_role: Some("方法或技术".to_string()),
        ambiguity_note: Some("请确认两个概念及缩写含义后再开始分析。".to_string()),
        ..MobileInnovationIntent::default()
    }
}

fn clean_innovation_concept(value: &str) -> Option<String> {
    let cleaned = value
        .trim_matches(|character: char| {
            character.is_whitespace() || "，。！？、:：;；()（）[]【】\"'".contains(character)
        })
        .trim_start_matches("能否")
        .trim_start_matches("是否可以")
        .trim_end_matches("分析")
        .trim_end_matches("研究")
        .trim()
        .to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

async fn detect_mobile_innovation_intent_with_model(
    model: &str,
    message: &str,
) -> Result<MobileInnovationIntent, String> {
    let response = reqwest::Client::new()
        .post("http://localhost:11434/api/chat")
        .json(&json!({
            "model": model,
            "stream": false,
            "format": "json",
            "think": false,
            "messages": [
                {"role":"system","content":"识别用户是否要求把两个科研概念组合起来做创新分析。只输出 JSON，字段必须为 detected、conceptA、conceptB、conceptAExpansion、conceptBExpansion、conceptARole、conceptBRole、ambiguityNote。缩写必须给出最可能全称；存在歧义时写入 ambiguityNote，不得静默确定。conceptARole 推荐为研究对象或问题，conceptBRole 推荐为方法或技术。"},
                {"role":"user","content":message}
            ]
        }))
        .send()
        .await
        .map_err(|error| format!("无法连接桌面模型：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("桌面模型返回状态码 {}", response.status()));
    }
    let value: serde_json::Value = response.json().await.map_err(|error| error.to_string())?;
    let content = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .ok_or_else(|| "模型没有返回意图 JSON。".to_string())?;
    let normalized = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str(normalized).map_err(|error| format!("意图 JSON 无效：{error}"))
}

fn authorize_headers(
    app: &AppHandle,
    state: &MobileCompanionState,
    headers: &HeaderMap,
) -> Result<PairedDeviceRecord, String> {
    let mapped = headers
        .iter()
        .filter_map(|(key, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (key.as_str().to_ascii_lowercase(), value.to_string()))
        })
        .collect::<HashMap<_, _>>();
    authorize_request(app, state, &mapped)
}

fn stream_mobile_chat_response(
    state: MobileRouterState,
    thread_id: Option<String>,
    payload: MobileChatSendRequest,
) -> Response {
    if payload.message.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "Message must not be empty.").into_response();
    }

    let request_id = match normalize_mobile_chat_request_id(payload.client_request_id.as_deref()) {
        Ok(value) => value,
        Err(error) => return (StatusCode::BAD_REQUEST, error).into_response(),
    };
    let cancel_receiver =
        match register_mobile_chat_generation(&state.chat_cancellations, &request_id) {
            Ok(receiver) => receiver,
            Err(MobileChatRegistrationError::Conflict) => {
                return (
                    StatusCode::CONFLICT,
                    "该移动生成请求 ID 正在使用，请勿重复提交。",
                )
                    .into_response();
            }
            Err(MobileChatRegistrationError::Unavailable) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "无法注册桌面端生成任务。",
                )
                    .into_response();
            }
        };

    let (sender, receiver) = mpsc::channel::<Result<Bytes, Infallible>>(64);
    let cancellation_state = state.chat_cancellations.clone();
    tauri::async_runtime::spawn(async move {
        run_mobile_chat_stream_task(state, thread_id, payload, sender, cancel_receiver).await;
        remove_mobile_chat_generation(&cancellation_state, &request_id);
    });
    let stream = stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|item| (item, receiver))
    });

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/x-ndjson; charset=utf-8")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[derive(Debug, PartialEq, Eq)]
enum MobileChatRegistrationError {
    Conflict,
    Unavailable,
}

fn is_valid_mobile_chat_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn normalize_mobile_chat_request_id(value: Option<&str>) -> Result<String, String> {
    match value.map(str::trim) {
        None => Ok(Uuid::new_v4().simple().to_string()),
        Some(value) if is_valid_mobile_chat_request_id(value) => Ok(value.to_string()),
        Some(_) => Err("移动生成请求 ID 无效。".to_string()),
    }
}

fn cancellation_sender(entry: &MobileChatCancellationEntry) -> &watch::Sender<bool> {
    match entry {
        MobileChatCancellationEntry::Pending(sender)
        | MobileChatCancellationEntry::Active(sender) => sender,
    }
}

fn register_mobile_chat_generation(
    registry: &MobileChatCancellationRegistry,
    request_id: &str,
) -> Result<watch::Receiver<bool>, MobileChatRegistrationError> {
    let mut entries = registry
        .lock()
        .map_err(|_| MobileChatRegistrationError::Unavailable)?;
    match entries.remove(request_id) {
        Some(MobileChatCancellationEntry::Pending(sender)) => {
            let receiver = sender.subscribe();
            entries.insert(
                request_id.to_string(),
                MobileChatCancellationEntry::Active(sender),
            );
            Ok(receiver)
        }
        Some(entry @ MobileChatCancellationEntry::Active(_)) => {
            entries.insert(request_id.to_string(), entry);
            Err(MobileChatRegistrationError::Conflict)
        }
        None => {
            let (sender, receiver) = watch::channel(false);
            entries.insert(
                request_id.to_string(),
                MobileChatCancellationEntry::Active(sender),
            );
            Ok(receiver)
        }
    }
}

fn remove_mobile_chat_generation(
    registry: &MobileChatCancellationRegistry,
    request_id: &str,
) -> bool {
    registry
        .lock()
        .map(|mut entries| entries.remove(request_id).is_some())
        .unwrap_or(false)
}

fn bind_mobile_listener() -> Result<(std::net::TcpListener, u16), String> {
    for port in MOBILE_PORT_CANDIDATES {
        match std::net::TcpListener::bind(("0.0.0.0", port)) {
            Ok(listener) => {
                listener
                    .set_nonblocking(true)
                    .map_err(|error| error.to_string())?;
                return Ok((listener, port));
            }
            Err(_) => continue,
        }
    }

    Err("No available mobile companion port was found in the configured range.".to_string())
}

fn detect_base_urls(port: u16) -> Vec<String> {
    let mut urls = Vec::new();
    for ip in detect_tailscale_ips() {
        push_unique_url(&mut urls, ip, port);
    }
    for ip in collect_lan_ips_from_system() {
        push_unique_url(&mut urls, ip, port);
    }
    if let Some(ip) = infer_lan_ip() {
        push_unique_url(&mut urls, ip, port);
    }
    push_unique_url(&mut urls, "127.0.0.1".to_string(), port);
    urls
}

fn collect_lan_ips_from_system() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let output = {
            let mut command = Command::new("ipconfig.exe");
            suppress_command_window(&mut command);
            command.output()
        };
        if let Ok(output) = output {
            if output.status.success() {
                return parse_private_lan_ips(&String::from_utf8_lossy(&output.stdout));
            }
        }
    }
    Vec::new()
}

fn parse_private_lan_ips(text: &str) -> Vec<String> {
    let mut ips = Vec::new();
    let ipv4_lines = text
        .lines()
        .filter(|line| line.to_ascii_lowercase().contains("ipv4"))
        .collect::<Vec<_>>()
        .join("\n");
    for token in ipv4_lines.split(|character: char| !character.is_ascii_digit() && character != '.')
    {
        let Ok(IpAddr::V4(ip)) = token.parse::<IpAddr>() else {
            continue;
        };
        let octets = ip.octets();
        let is_private = octets[0] == 10
            || (octets[0] == 172 && (16..=31).contains(&octets[1]))
            || (octets[0] == 192 && octets[1] == 168);
        if is_private && !ip.is_loopback() {
            let value = ip.to_string();
            if !ips.contains(&value) {
                ips.push(value);
            }
        }
    }
    ips
}

fn configure_tailscale_tcp_serve_background(state: MobileCompanionState, port: u16) {
    tauri::async_runtime::spawn_blocking(move || {
        if detect_tailscale_ips().is_empty() {
            return;
        }

        if let Err(error) = configure_tailscale_tcp_serve(port) {
            if let Ok(mut runtime) = state.inner.lock() {
                let prefix = runtime
                    .last_error
                    .take()
                    .map(|previous| format!("{previous}; "))
                    .unwrap_or_default();
                runtime.last_error = Some(format!("{prefix}Tailscale Serve 自动配置失败：{error}"));
            }
        }
    });
}

fn configure_tailscale_tcp_serve(port: u16) -> Result<(), String> {
    let command =
        find_tailscale_command().ok_or_else(|| "未找到 tailscale 可执行文件。".to_string())?;
    let output = run_command_with_timeout(
        {
            let mut command_builder = Command::new(&command);
            command_builder
                .arg("serve")
                .arg("--yes")
                .arg("--bg")
                .arg(format!("--tcp={port}"))
                .arg(port.to_string());
            command_builder
        },
        Duration::from_secs(8),
    )?;
    if !output.status.success() {
        return Err(command_failure_message(&output));
    }

    let status_output = run_command_with_timeout(
        {
            let mut command_builder = Command::new(&command);
            command_builder.args(["serve", "status"]);
            command_builder
        },
        Duration::from_secs(4),
    )?;
    if !status_output.status.success() {
        return Err(command_failure_message(&status_output));
    }
    let status_text = String::from_utf8_lossy(&status_output.stdout);
    let expected_loopback = format!("127.0.0.1:{port}");
    if !status_text.contains(&expected_loopback) {
        return Err(format!(
            "Serve 状态未包含本机转发目标 {expected_loopback}。"
        ));
    }
    Ok(())
}

fn run_command_with_timeout(mut command: Command, timeout: Duration) -> Result<Output, String> {
    suppress_command_window(&mut command);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动命令失败：{error}"))?;
    let started_at = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|error| format!("读取命令输出失败：{error}"));
            }
            Ok(None) => {
                if started_at.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("命令执行超时。".to_string());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(format!("等待命令结束失败：{error}")),
        }
    }
}

fn command_failure_message(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("退出码 {:?}", output.status.code())
    }
}

fn find_tailscale_command() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let candidates = windows_tailscale_command_candidates();
        candidates
            .iter()
            .find(|path| path.exists())
            .cloned()
            .or_else(|| {
                candidates
                    .into_iter()
                    .find(|path| path.components().count() == 1)
            })
    }

    #[cfg(not(target_os = "windows"))]
    {
        Some(PathBuf::from("tailscale"))
    }
}

fn push_unique_url(urls: &mut Vec<String>, ip: String, port: u16) {
    let url = format!("http://{}:{}", ip, port);
    if !urls.contains(&url) {
        urls.push(url);
    }
}

fn detect_tailscale_ips() -> Vec<String> {
    let mut ips = collect_tailscale_ips_from_system();
    if let Some(ip) = infer_tailscale_ip_from_route() {
        if !ips.contains(&ip) {
            ips.push(ip);
        }
    }
    ips
}

fn infer_tailscale_ip_from_route() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("100.100.100.100:53").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if is_tailscale_ip(ip) {
        Some(ip.to_string())
    } else {
        None
    }
}

fn collect_tailscale_ips_from_system() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        for command in windows_tailscale_command_candidates() {
            let output = {
                let mut command_builder = Command::new(&command);
                suppress_command_window(&mut command_builder);
                command_builder.args(["ip", "-4"]).output()
            };
            if let Ok(output) = output {
                if output.status.success() {
                    let ips = parse_tailscale_ips(&String::from_utf8_lossy(&output.stdout));
                    if !ips.is_empty() {
                        return ips;
                    }
                }
            }
        }

        let output = {
            let mut command_builder = Command::new("powershell.exe");
            suppress_command_window(&mut command_builder);
            command_builder.args([
                "-NoProfile",
                "-Command",
                "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -match '^100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.' } | Select-Object -ExpandProperty IPAddress",
            ])
            .output()
        };
        if let Ok(output) = output {
            if output.status.success() {
                let ips = parse_tailscale_ips(&String::from_utf8_lossy(&output.stdout));
                if !ips.is_empty() {
                    return ips;
                }
            }
        }

        let output = {
            let mut command_builder = Command::new("netsh");
            suppress_command_window(&mut command_builder);
            command_builder
                .args(["interface", "ipv4", "show", "addresses"])
                .output()
        };
        if let Ok(output) = output {
            if output.status.success() {
                let ips = parse_tailscale_ips_from_interface_text(&String::from_utf8_lossy(
                    &output.stdout,
                ));
                if !ips.is_empty() {
                    return ips;
                }
            }
        }

        let output = {
            let mut command_builder = Command::new("ipconfig");
            suppress_command_window(&mut command_builder);
            command_builder.output()
        };
        if let Ok(output) = output {
            if output.status.success() {
                return parse_tailscale_ips_from_interface_text(&String::from_utf8_lossy(
                    &output.stdout,
                ));
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("sh")
            .args(["-c", "ip -4 addr show 2>/dev/null || ifconfig 2>/dev/null"])
            .output();
        if let Ok(output) = output {
            if output.status.success() {
                return parse_tailscale_ips(&String::from_utf8_lossy(&output.stdout));
            }
        }
    }

    Vec::new()
}

#[cfg(target_os = "windows")]
fn windows_tailscale_command_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from("tailscale.exe")];
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        candidates.push(
            PathBuf::from(program_files)
                .join("Tailscale")
                .join("tailscale.exe"),
        );
    }
    if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
        candidates.push(
            PathBuf::from(program_files_x86)
                .join("Tailscale")
                .join("tailscale.exe"),
        );
    }
    candidates
}

fn parse_tailscale_ips_from_interface_text(text: &str) -> Vec<String> {
    let ipv4_lines = text
        .lines()
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            lower.contains("ipv4") || lower.contains("ip address")
        })
        .collect::<Vec<_>>()
        .join("\n");
    parse_tailscale_ips(&ipv4_lines)
}

fn parse_tailscale_ips(text: &str) -> Vec<String> {
    let mut ips = Vec::new();
    for token in text.split(|character: char| !character.is_ascii_digit() && character != '.') {
        let Ok(ip) = token.parse::<IpAddr>() else {
            continue;
        };
        if is_tailscale_ip(ip) {
            let value = ip.to_string();
            if !ips.contains(&value) {
                ips.push(value);
            }
        }
    }
    ips
}

fn is_tailscale_ip(ip: IpAddr) -> bool {
    let IpAddr::V4(ipv4) = ip else {
        return false;
    };
    let octets = ipv4.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

fn infer_lan_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if ip.is_loopback() {
        None
    } else {
        Some(ip.to_string())
    }
}

fn build_mobile_status(
    app: &AppHandle,
    state: &MobileCompanionState,
) -> Result<MobileCompanionStatus, String> {
    ensure_mobile_dirs(app)?;
    let snapshot = refresh_runtime_base_urls(state)?;
    let cards = cards::list_knowledge_cards(app)?;
    let review_state = read_review_state(app)?;
    let inbox_dir = mobile_inbox_dir(app)?;
    let review_dir = review_state_dir(app)?;

    Ok(MobileCompanionStatus {
        api_version: MOBILE_API_VERSION.to_string(),
        service_name: MOBILE_SERVICE_NAME.to_string(),
        pair_code: snapshot.pair_code,
        listener_port: snapshot.listener_port,
        base_urls: snapshot.base_urls,
        paired_devices: snapshot
            .paired_devices
            .into_iter()
            .map(|device| PairedDeviceSummary {
                device_id: device.device_id,
                device_name: device.device_name,
                paired_at: device.paired_at,
                last_seen_at: device.last_seen_at,
            })
            .collect(),
        inbox_count: count_inbox_items(&inbox_dir)?,
        review_record_count: review_state.records.len(),
        card_count: cards.len(),
        running: snapshot.running,
        last_error: snapshot.last_error,
        inbox_dir: inbox_dir.to_string_lossy().to_string(),
        review_state_dir: review_dir.to_string_lossy().to_string(),
    })
}

fn refresh_runtime_base_urls(
    state: &MobileCompanionState,
) -> Result<MobileCompanionRuntime, String> {
    let mut runtime = state
        .inner
        .lock()
        .map_err(|error| format!("Failed to lock mobile companion runtime: {}", error))?;
    if runtime.running && runtime.listener_port > 0 {
        runtime.base_urls = detect_base_urls(runtime.listener_port);
    }
    Ok(runtime.clone())
}

fn pair_device(
    app: &AppHandle,
    state: &MobileCompanionState,
    request: MobilePairRequest,
) -> Result<MobilePairResponse, String> {
    let trimmed_code = request.pair_code.trim();
    let trimmed_name = request.device_name.trim();
    if trimmed_name.is_empty() {
        return Err("Device name must not be empty.".to_string());
    }

    let paired_at = cards::current_timestamp_iso_utc();
    let (device_id, token, base_urls) = {
        let mut runtime = state
            .inner
            .lock()
            .map_err(|error| format!("Failed to lock mobile companion runtime: {}", error))?;
        if runtime.pair_code.trim() != trimmed_code {
            return Err("Pair code is invalid.".to_string());
        }

        let device_id = Uuid::new_v4().simple().to_string();
        let token = Uuid::new_v4().simple().to_string();
        runtime.paired_devices.push(PairedDeviceRecord {
            device_id: device_id.clone(),
            device_name: trimmed_name.to_string(),
            token: token.clone(),
            paired_at: paired_at.clone(),
            last_seen_at: Some(paired_at.clone()),
        });
        (device_id, token, runtime.base_urls.clone())
    };

    persist_runtime_state(app, state)?;
    Ok(MobilePairResponse {
        api_version: MOBILE_API_VERSION.to_string(),
        service_name: MOBILE_SERVICE_NAME.to_string(),
        device_id,
        device_token: token,
        paired_at,
        base_urls,
    })
}

fn authorize_request(
    app: &AppHandle,
    state: &MobileCompanionState,
    headers: &HashMap<String, String>,
) -> Result<PairedDeviceRecord, String> {
    let token = headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Missing bearer token.".to_string())?;

    let current_timestamp = cards::current_timestamp_iso_utc();
    let device = {
        let mut runtime = state
            .inner
            .lock()
            .map_err(|error| format!("Failed to lock mobile companion runtime: {}", error))?;
        let device = runtime
            .paired_devices
            .iter_mut()
            .find(|device| device.token == token)
            .ok_or_else(|| "Bearer token is invalid.".to_string())?;
        device.last_seen_at = Some(current_timestamp.clone());
        device.clone()
    };

    persist_runtime_state(app, state)?;
    Ok(device)
}

fn load_bootstrap_payload(
    app: &AppHandle,
    state: &MobileCompanionState,
) -> Result<MobileBootstrapResponse, String> {
    Ok(MobileBootstrapResponse {
        service: build_mobile_status(app, state)?,
        cards: load_mobile_cards(app)?,
        notes: load_mobile_notes(app)?,
        review_records: sorted_review_records(
            read_review_state(app)?.records.into_values().collect(),
        ),
    })
}

fn load_mobile_notes(app: &AppHandle) -> Result<Vec<MobileNoteRecord>, String> {
    crate::list_paper_note_drafts_shared(app)?
        .into_iter()
        .map(|summary| {
            let id = Path::new(&summary.path)
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "笔记文件名无效。".to_string())?
                .to_string();
            let detail = crate::read_paper_note_draft_shared(app, &summary.path)?;
            Ok(map_mobile_note_detail(id, detail))
        })
        .collect()
}

fn validate_mobile_markdown(title: &str, markdown: &str) -> Result<(), String> {
    if title.trim().is_empty() {
        return Err("标题不能为空。".to_string());
    }
    if title.trim().chars().count() > 180 {
        return Err("标题不能超过 180 个字符。".to_string());
    }
    if markdown.trim().is_empty() {
        return Err("Markdown 正文不能为空。".to_string());
    }
    if markdown.chars().count() > 60_000 {
        return Err("Markdown 正文不能超过 60000 个字符。".to_string());
    }
    Ok(())
}

fn create_mobile_card(
    app: &AppHandle,
    payload: MobileCardWriteRequest,
) -> Result<MobileCardRecord, String> {
    let term = payload.term.trim();
    let title = if payload.title.trim().is_empty() {
        term
    } else {
        payload.title.trim()
    };
    if term.is_empty() || term.chars().count() > 120 {
        return Err("术语不能为空且不能超过 120 个字符。".to_string());
    }
    validate_mobile_markdown(title, &payload.markdown)?;
    cards::create_manual_knowledge_card(app, term, title, &payload.markdown).map(map_card_detail)
}

fn update_mobile_card(
    app: &AppHandle,
    card_id: &str,
    payload: MobileCardWriteRequest,
) -> Result<MobileCardRecord, String> {
    let normalized_id = card_id.trim();
    let summary = cards::list_knowledge_cards(app)?
        .into_iter()
        .find(|card| card.id == normalized_id)
        .ok_or_else(|| "未找到要编辑的知识卡片。".to_string())?;
    let term = payload.term.trim();
    let title = if payload.title.trim().is_empty() {
        term
    } else {
        payload.title.trim()
    };
    if term.is_empty() || term.chars().count() > 120 {
        return Err("术语不能为空且不能超过 120 个字符。".to_string());
    }
    validate_mobile_markdown(title, &payload.markdown)?;
    cards::update_knowledge_card(cards::UpdateKnowledgeCardRequest {
        card_path: summary.path,
        title: title.to_string(),
        body: payload.markdown,
        term: Some(term.to_string()),
    })
    .map(map_card_detail)
}

fn create_mobile_note(
    app: &AppHandle,
    payload: MobileNoteWriteRequest,
) -> Result<MobileNoteRecord, String> {
    validate_mobile_markdown(&payload.title, &payload.markdown)?;
    let detail = crate::create_manual_paper_note_draft_shared(
        app,
        payload.title.trim(),
        payload.markdown.trim(),
    )?;
    let id = Path::new(&detail.path)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "笔记文件名无效。".to_string())?
        .to_string();
    Ok(map_mobile_note_detail(id, detail))
}

fn update_mobile_note(
    app: &AppHandle,
    note_id: &str,
    payload: MobileNoteWriteRequest,
) -> Result<MobileNoteRecord, String> {
    validate_mobile_markdown(&payload.title, &payload.markdown)?;
    let normalized_id = note_id.trim();
    let summary = crate::list_paper_note_drafts_shared(app)?
        .into_iter()
        .find(|note| {
            Path::new(&note.path)
                .file_name()
                .and_then(|value| value.to_str())
                == Some(normalized_id)
        })
        .ok_or_else(|| "未找到要编辑的论文笔记。".to_string())?;
    let detail = crate::update_mobile_paper_note_draft_shared(
        app,
        &summary.path,
        payload.title.trim(),
        payload.markdown.trim(),
    )?;
    Ok(map_mobile_note_detail(normalized_id.to_string(), detail))
}

fn map_mobile_note_detail(id: String, detail: crate::PaperDraftDetail) -> MobileNoteRecord {
    MobileNoteRecord {
        id,
        title: detail.title,
        created_at: detail.created_at,
        source_paper: detail.source_paper.and_then(|value| {
            Path::new(&value)
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        }),
        preview: detail.preview_text,
        markdown: strip_mobile_markdown_frontmatter(&detail.content).to_string(),
    }
}

fn delete_mobile_card(app: &AppHandle, card_id: &str) -> Result<MobileDeleteResponse, String> {
    let normalized_id = card_id.trim();
    let summary = cards::list_knowledge_cards(app)?
        .into_iter()
        .find(|card| card.id == normalized_id)
        .ok_or_else(|| "未找到要删除的知识卡片。".to_string())?;
    cards::delete_knowledge_card(summary.path)?;

    let mut review_state = read_review_state(app)?;
    review_state.records.remove(normalized_id);
    write_review_state(app, &review_state)?;
    Ok(MobileDeleteResponse {
        id: normalized_id.to_string(),
        deleted: true,
    })
}

fn delete_mobile_note(app: &AppHandle, note_id: &str) -> Result<MobileDeleteResponse, String> {
    let normalized_id = note_id.trim();
    let summary = crate::list_paper_note_drafts_shared(app)?
        .into_iter()
        .find(|note| {
            Path::new(&note.path)
                .file_name()
                .and_then(|value| value.to_str())
                == Some(normalized_id)
        })
        .ok_or_else(|| "未找到要删除的论文笔记。".to_string())?;
    crate::delete_paper_note_draft_shared(app, &summary.path)?;
    Ok(MobileDeleteResponse {
        id: normalized_id.to_string(),
        deleted: true,
    })
}

fn load_mobile_cards(app: &AppHandle) -> Result<Vec<MobileCardRecord>, String> {
    let summaries = cards::list_knowledge_cards(app)?;
    let mut result = Vec::with_capacity(summaries.len());
    for summary in summaries {
        let detail = cards::read_knowledge_card(summary.path.clone())?;
        result.push(map_card_detail(detail));
    }
    Ok(result)
}

fn map_card_detail(detail: KnowledgeCardDetail) -> MobileCardRecord {
    let has_pdf = detail
        .meta
        .pdf_path
        .as_deref()
        .map(has_existing_pdf)
        .unwrap_or(false);
    MobileCardRecord {
        id: detail.meta.id,
        term: detail.meta.term,
        title: detail.meta.title,
        created_at: detail.meta.created_at,
        preview: detail.meta.preview,
        markdown: strip_mobile_markdown_frontmatter(&detail.markdown).to_string(),
        source_provider: detail.meta.source_provider,
        source_status: detail.meta.source_status,
        lookup_mode: lookup_mode_key(detail.meta.lookup_mode).to_string(),
        has_pdf,
        pdf_path: None,
        pdf_page: detail.meta.pdf_page,
    }
}

fn strip_mobile_markdown_frontmatter(content: &str) -> &str {
    let normalized = content.trim_start_matches('\u{feff}');
    if let Some(rest) = normalized.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---") {
            return rest[end + 4..].trim_start_matches(['\r', '\n']);
        }
    }
    normalized
}

async fn load_mobile_papers(app: &AppHandle) -> Result<Vec<MobilePaperRecord>, String> {
    let demo_library = load_demo_library_settings(app)?;
    let papers = research_memory::list_research_papers(app)
        .await
        .map_err(|error| error.to_string())?;
    let indexed_paths = papers
        .iter()
        .filter(|paper| is_demo_visible_path(&paper.path, &demo_library))
        .map(|paper| paper.path.clone())
        .collect::<HashSet<_>>();
    let mut result = papers
        .into_iter()
        .filter(|paper| is_demo_visible_path(&paper.path, &demo_library))
        .map(|paper| MobilePaperRecord {
            paper_id: paper.paper_id,
            title: paper.title,
            paper_type: paper.paper_type,
            updated_at: paper.updated_at,
            has_pdf: has_existing_pdf(&paper.path),
            source_type: "paper".to_string(),
        })
        .collect::<Vec<_>>();
    result.extend(collect_workspace_pdf_records(
        app,
        &indexed_paths,
        &demo_library,
    )?);
    result.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.title.cmp(&right.title))
    });
    Ok(result)
}

struct PdfDownload {
    path: PathBuf,
    file_name: String,
    page_hint: Option<u32>,
}

fn resolve_card_pdf_download(app: &AppHandle, card_id: &str) -> Result<PdfDownload, String> {
    let normalized_id = card_id.trim();
    if normalized_id.is_empty() {
        return Err("Card id must not be empty.".to_string());
    }

    let summary = cards::list_knowledge_cards(app)?
        .into_iter()
        .find(|card| card.id == normalized_id)
        .ok_or_else(|| "Card was not found.".to_string())?;
    let pdf_path = summary
        .pdf_path
        .as_deref()
        .ok_or_else(|| "Card does not have an associated PDF.".to_string())?;
    let path = resolve_existing_pdf_path(pdf_path)?;
    Ok(PdfDownload {
        path,
        file_name: safe_pdf_file_name(&summary.title, normalized_id),
        page_hint: summary.pdf_page,
    })
}

async fn resolve_paper_pdf_download(
    app: &AppHandle,
    paper_id: &str,
) -> Result<PdfDownload, String> {
    let normalized_id = paper_id.trim();
    if normalized_id.is_empty() {
        return Err("Paper id must not be empty.".to_string());
    }

    let paper = research_memory::list_research_papers(app)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|paper| paper.paper_id == normalized_id)
        .ok_or_else(|| "Paper was not found.".to_string())?;
    let path = resolve_existing_pdf_path(&paper.path)?;
    Ok(PdfDownload {
        path,
        file_name: safe_pdf_file_name(&paper.title, normalized_id),
        page_hint: None,
    })
}

fn resolve_workspace_pdf_download(app: &AppHandle, pdf_id: &str) -> Result<PdfDownload, String> {
    let normalized_id = pdf_id.trim();
    if normalized_id.is_empty() {
        return Err("Workspace PDF id must not be empty.".to_string());
    }

    let workspace_root = mobile_workspace_root_dir(app)?;
    for entry in WalkDir::new(&workspace_root)
        .into_iter()
        .filter_map(|entry| entry.ok())
    {
        let path = entry.path();
        if !entry.file_type().is_file() || !is_pdf_path(path.to_string_lossy().as_ref()) {
            continue;
        }
        if workspace_pdf_id(path) == normalized_id {
            let title = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("document");
            return Ok(PdfDownload {
                path: path.to_path_buf(),
                file_name: safe_pdf_file_name(title, normalized_id),
                page_hint: None,
            });
        }
    }

    Err("Workspace PDF was not found.".to_string())
}

fn build_pdf_download_response(
    download: PdfDownload,
    headers: &HeaderMap,
) -> Result<Response, (StatusCode, String)> {
    let file_size = fs::metadata(&download.path)
        .map_err(|error| {
            (
                StatusCode::NOT_FOUND,
                format!("无法读取 PDF 文件信息：{error}"),
            )
        })?
        .len();
    let requested_range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(|value| parse_pdf_byte_range(value, file_size))
        .transpose()?;
    let (status, start, end) = match requested_range {
        Some((start, end)) => (StatusCode::PARTIAL_CONTENT, start, end),
        None if file_size > 0 => (StatusCode::OK, 0, file_size - 1),
        None => (StatusCode::OK, 0, 0),
    };
    let body_length = if file_size == 0 { 0 } else { end - start + 1 };
    let mut file = fs::File::open(&download.path)
        .map_err(|error| (StatusCode::NOT_FOUND, format!("无法读取 PDF 文件：{error}")))?;
    if start > 0 {
        file.seek(SeekFrom::Start(start)).map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("无法定位 PDF 数据：{error}"),
            )
        })?;
    }
    let body_size = usize::try_from(body_length).map_err(|_| {
        (
            StatusCode::PAYLOAD_TOO_LARGE,
            "PDF 分段数据过大，无法发送。".to_string(),
        )
    })?;
    let mut bytes = vec![0_u8; body_size];
    file.read_exact(&mut bytes).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("读取 PDF 数据失败：{error}"),
        )
    })?;
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/pdf")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, body_length.to_string())
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", download.file_name),
        )
        .header("x-ra-file-name", download.file_name);
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{file_size}"),
        );
    }
    if let Some(page) = download.page_hint {
        builder = builder.header("x-ra-pdf-page", page.to_string());
    }
    builder
        .body(Body::from(bytes))
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
}

fn parse_pdf_byte_range(value: &str, file_size: u64) -> Result<(u64, u64), (StatusCode, String)> {
    if file_size == 0 {
        return Err((
            StatusCode::RANGE_NOT_SATISFIABLE,
            "空 PDF 不支持分段读取。".to_string(),
        ));
    }
    let range = value.trim().strip_prefix("bytes=").ok_or_else(|| {
        (
            StatusCode::RANGE_NOT_SATISFIABLE,
            "PDF Range 请求格式无效。".to_string(),
        )
    })?;
    if range.contains(',') {
        return Err((
            StatusCode::RANGE_NOT_SATISFIABLE,
            "暂不支持多段 PDF Range 请求。".to_string(),
        ));
    }
    let (start_text, end_text) = range.split_once('-').ok_or_else(|| {
        (
            StatusCode::RANGE_NOT_SATISFIABLE,
            "PDF Range 请求格式无效。".to_string(),
        )
    })?;
    let (start, end) = if start_text.is_empty() {
        let suffix_length = end_text.parse::<u64>().map_err(|_| {
            (
                StatusCode::RANGE_NOT_SATISFIABLE,
                "PDF Range 后缀长度无效。".to_string(),
            )
        })?;
        if suffix_length == 0 {
            return Err((
                StatusCode::RANGE_NOT_SATISFIABLE,
                "PDF Range 后缀长度必须大于 0。".to_string(),
            ));
        }
        (file_size.saturating_sub(suffix_length), file_size - 1)
    } else {
        let start = start_text.parse::<u64>().map_err(|_| {
            (
                StatusCode::RANGE_NOT_SATISFIABLE,
                "PDF Range 起始位置无效。".to_string(),
            )
        })?;
        let end = if end_text.is_empty() {
            file_size - 1
        } else {
            end_text.parse::<u64>().map_err(|_| {
                (
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    "PDF Range 结束位置无效。".to_string(),
                )
            })?
        };
        (start, end.min(file_size - 1))
    };
    if start >= file_size || start > end {
        return Err((
            StatusCode::RANGE_NOT_SATISFIABLE,
            "PDF Range 超出文件范围。".to_string(),
        ));
    }
    Ok((start, end))
}

async fn resolve_mobile_pdf_source(
    app: &AppHandle,
    source: &MobilePdfSource,
) -> Result<PdfDownload, String> {
    if source.page == 0 {
        return Err("页码必须从 1 开始。".to_string());
    }
    match source.source_type {
        MobilePdfSourceType::Card => resolve_card_pdf_download(app, &source.source_id),
        MobilePdfSourceType::Paper => resolve_paper_pdf_download(app, &source.source_id).await,
        MobilePdfSourceType::WorkspacePdf => resolve_workspace_pdf_download(app, &source.source_id),
    }
}

fn bearer_token_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

async fn acquire_mobile_model_permit(state: &MobileRouterState) -> Result<ChatQueuePermit, String> {
    state
        .chat_queue
        .acquire_timeout(
            ChatPriority::Mobile,
            tokio::time::Duration::from_secs(MOBILE_CHAT_QUEUE_TIMEOUT_SECS),
        )
        .await
        .ok_or_else(|| "模型队列等待超过 45 秒，请稍后重试。".to_string())
}

fn read_pdfjs_asset(app: &AppHandle, file_name: &str) -> Result<Vec<u8>, String> {
    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("pdfjs")
        .join(file_name);
    let development_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("node_modules")
        .join("pdfjs-dist")
        .join("legacy")
        .join("build")
        .join(file_name);
    let path = if resource_path.is_file() {
        resource_path
    } else {
        development_path
    };
    fs::read(&path).map_err(|error| format!("无法读取 PDF.js 资源 '{}': {error}", path.display()))
}

fn render_mobile_pdf_viewer_html(source: &MobilePdfSource, token: &str) -> String {
    let config = serde_json::to_string(&json!({
        "sourceType": source.source_type,
        "sourceId": source.source_id,
        "token": token,
        "initialPage": source.page,
    }))
    .unwrap_or_else(|_| "{}".to_string())
    .replace("</", "<\\/");
    r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=4,user-scalable=yes">
<style>
html,body{margin:0;background:#e5e7eb;color:#111827;font-family:system-ui,sans-serif;-webkit-text-size-adjust:none;text-size-adjust:none}#toolbar{position:sticky;top:0;z-index:20;display:flex;justify-content:center;align-items:center;gap:8px;padding:7px;background:#fff;border-bottom:1px solid #d1d5db;-webkit-user-select:none;user-select:none}button{border:0;border-radius:8px;padding:7px 10px;background:#e5e7eb;color:#111827;white-space:nowrap}button:disabled{opacity:.5}button.active{background:#0f766e;color:#fff}#status{min-width:52px;text-align:center}#pages{padding:10px 0 40px;min-height:60vh}.page{position:relative;margin:0 auto 12px;background:#fff;box-shadow:0 2px 8px #0002}canvas{display:block;pointer-events:none}.textLayer{position:absolute;inset:0;overflow:hidden;opacity:1;line-height:1;text-align:initial;transform-origin:0 0;z-index:2;-webkit-user-select:text;user-select:text;-webkit-touch-callout:default;touch-action:pan-x pan-y pinch-zoom}.textLayer span,.textLayer br{color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0;-webkit-user-select:text;user-select:text}.textLayer ::selection{background:rgba(37,99,235,.42)}body.selectionMode .textLayer{touch-action:none;cursor:text;-webkit-user-select:none;user-select:none}body.selectionMode .textLayer span{cursor:text;-webkit-user-select:none;user-select:none}.dragSelectionHighlight{position:absolute;z-index:3;border-radius:1px;background:rgba(37,99,235,.42);pointer-events:none}.selectionHandle{position:absolute;z-index:6;width:44px;height:44px;margin:-10px 0 0 -22px;border-radius:50%;background:transparent;touch-action:none}.selectionHandle::after{content:'';position:absolute;left:15px;top:15px;width:14px;height:14px;border-radius:50%;background:#2563eb;border:2px solid #fff;box-shadow:0 1px 4px #0006}.selectionHandleStart::after{top:5px}.selectionHandleEnd::after{top:25px}
</style></head><body><div id="toolbar"><button id="prev">上一页</button><span id="status">加载中…</span><button id="next">下一页</button><button id="select">选字</button></div><main id="pages"></main>
<script src="/api/mobile/v1/pdf-viewer/assets/pdf.min.js"></script><script>
const cfg=__CONFIG__;
const send=(data)=>window.ReactNativeWebView?.postMessage(JSON.stringify(data));
const statusElement=document.querySelector('#status');
const previousButton=document.querySelector('#prev');
const nextButton=document.querySelector('#next');
const selectButton=document.querySelector('#select');
let documentRef=null;
let currentPage=cfg.initialPage||1;
let rendering=false;
let selectionMode=false;
function reportError(error){const message=String(error?.message||error||'未知错误');statusElement.textContent='加载失败';send({type:'error',message});}
async function renderPage(number){
  clearCustomSelection();getSelection()?.removeAllRanges();lastSelectionKey='';selectionGesture=null;visualMap=null;
  const page=await documentRef.getPage(number);
  const baseViewport=page.getViewport({scale:1});
  const availableWidth=Math.max(280,document.documentElement.clientWidth-20);
  const viewport=page.getViewport({scale:availableWidth/baseViewport.width});
  const host=document.createElement('section');host.className='page';host.dataset.page=number;host.style.width=viewport.width+'px';host.style.height=viewport.height+'px';
  const canvas=document.createElement('canvas');const ratio=devicePixelRatio||1;canvas.width=Math.floor(viewport.width*ratio);canvas.height=Math.floor(viewport.height*ratio);canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';host.appendChild(canvas);
  const layer=document.createElement('div');layer.className='textLayer';layer.style.width=viewport.width+'px';layer.style.height=viewport.height+'px';layer.style.setProperty('--scale-factor',String(viewport.scale));host.appendChild(layer);
  document.querySelector('#pages').replaceChildren(host);
  await page.render({canvasContext:canvas.getContext('2d'),viewport,transform:ratio===1?null:[ratio,0,0,ratio,0,0]}).promise;
  const text=await page.getTextContent();
  await pdfjsLib.renderTextLayer({textContentSource:text,container:layer,viewport,textDivs:[]}).promise;
  const prepareVisualMap=()=>{if(layer.isConnected)visualMap=buildVisualTextMap(layer);};
  if(window.requestIdleCallback)window.requestIdleCallback(prepareVisualMap,{timeout:1200});else setTimeout(prepareVisualMap,80);
}
async function go(page){
  if(!documentRef||rendering)return;
  const target=Math.max(1,Math.min(documentRef.numPages,page));
  rendering=true;previousButton.disabled=true;nextButton.disabled=true;statusElement.textContent=`正在加载第 ${target} 页…`;
  try{await renderPage(target);currentPage=target;statusElement.textContent=`${currentPage} / ${documentRef.numPages}`;send({type:'page',page:currentPage,pageCount:documentRef.numPages});}
  catch(error){reportError(error);}
  finally{rendering=false;previousButton.disabled=currentPage<=1;nextButton.disabled=currentPage>=documentRef.numPages;}
}
async function load(){
  try{
    if(!window.pdfjsLib)throw new Error('PDF.js 主资源加载失败。');
    pdfjsLib.GlobalWorkerOptions.workerSrc='/api/mobile/v1/pdf-viewer/assets/pdf.worker.min.js';
    const pdfUrl=new URL('/api/mobile/v1/pdf-viewer/pdf-content',location.href);pdfUrl.searchParams.set('sourceType',cfg.sourceType);pdfUrl.searchParams.set('sourceId',cfg.sourceId);pdfUrl.searchParams.set('page',String(cfg.initialPage||1));
    const task=pdfjsLib.getDocument({url:pdfUrl.href,httpHeaders:{Authorization:'Bearer '+cfg.token},rangeChunkSize:262144,disableAutoFetch:true,disableStream:true});
    documentRef=await task.promise;currentPage=Math.max(1,Math.min(documentRef.numPages,currentPage));await go(currentPage);send({type:'ready',pageCount:documentRef.numPages});
  }catch(error){reportError(error);}
}
previousButton.onclick=()=>void go(currentPage-1);nextButton.onclick=()=>void go(currentPage+1);
let lastSelectionKey='';
let customSelectionText='';let customSelectionPage=currentPage;let visualMap=null;let selectionFlow=null;let selectionStartIndex=0;let selectionEndIndex=0;let selectionNodes=[];let selectionGesture=null;
function clearCustomSelection(clearText=true){for(const node of selectionNodes)node.remove();selectionNodes=[];if(clearText){customSelectionText='';selectionFlow=null;selectionStartIndex=0;selectionEndIndex=0;}}
function selectionContext(text,selection){if(selectionFlow&&customSelectionText){const begin=Math.max(0,selectionStartIndex-360);const end=Math.min(selectionFlow.chars.length,selectionEndIndex+361);return selectedTextForChars(selectionFlow.chars.slice(begin,end)).slice(0,1400);}let element=null;if(selection?.rangeCount){const node=selection.getRangeAt(0).startContainer;element=node.nodeType===Node.ELEMENT_NODE?node:node.parentElement;}const layer=element?.closest?.('.textLayer')||document.querySelector('.textLayer');const pageText=(layer?.innerText||layer?.textContent||'').replace(/\s+/g,' ').trim();if(!pageText)return'';const index=pageText.indexOf(text);if(index<0)return pageText.slice(0,1400);return pageText.slice(Math.max(0,index-500),Math.min(pageText.length,index+text.length+500));}
function publishSelection(){const selection=getSelection();const nativeText=selection?.toString().trim()||'';const text=(customSelectionText||nativeText).trim();let page=customSelectionText?customSelectionPage:currentPage;if(!customSelectionText&&selection?.rangeCount){const node=selection.getRangeAt(0).startContainer;const element=node.nodeType===Node.ELEMENT_NODE?node:node.parentElement;page=Number(element?.closest('.page')?.dataset.page||page);}const context=selectionContext(text,selection);const key=`${page}:${text}:${context}`;if(key===lastSelectionKey)return;lastSelectionKey=key;send({type:'selection',text,page,context});}
function scheduleSelection(delay=420){clearTimeout(window.__selectionTimer);window.__selectionTimer=setTimeout(publishSelection,delay);}
function median(values){if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)];}
function buildVisualTextMap(layer){const layerRect=layer.getBoundingClientRect();const walker=document.createTreeWalker(layer,NodeFilter.SHOW_TEXT);const chars=[];while(walker.nextNode()){const node=walker.currentNode;const value=node.nodeValue||'';for(let offset=0;offset<value.length;){const length=(value.codePointAt(offset)||0)>65535?2:1;const range=document.createRange();range.setStart(node,offset);range.setEnd(node,Math.min(value.length,offset+length));const rect=Array.from(range.getClientRects()).find(item=>item.height>0&&item.width>0);if(rect){chars.push({node,offset,endOffset:offset+length,char:value.slice(offset,offset+length),left:rect.left-layerRect.left,right:rect.right-layerRect.left,top:rect.top-layerRect.top,bottom:rect.bottom-layerRect.top,width:rect.width,height:rect.height,centerX:(rect.left+rect.right)/2-layerRect.left,centerY:(rect.top+rect.bottom)/2-layerRect.top});}offset+=length;}}const ordered=[...chars].sort((a,b)=>a.centerY-b.centerY||a.left-b.left);const lines=[];for(const char of ordered){let best=null;let bestDistance=Infinity;for(let index=Math.max(0,lines.length-5);index<lines.length;index++){const line=lines[index];const distance=Math.abs(char.centerY-line.centerY);if(distance<=Math.max(char.height,line.height)*0.55&&distance<bestDistance){best=line;bestDistance=distance;}}if(!best){best={id:lines.length,chars:[],centerY:char.centerY,height:char.height,top:char.top,bottom:char.bottom};lines.push(best);}best.chars.push(char);best.centerY=best.chars.reduce((sum,item)=>sum+item.centerY,0)/best.chars.length;best.height=median(best.chars.map(item=>item.height));best.top=Math.min(best.top,char.top);best.bottom=Math.max(best.bottom,char.bottom);}const widths=chars.map(item=>item.width).filter(value=>value>0);const typicalWidth=Math.max(3,median(widths));const splitGap=Math.max(14,typicalWidth*3.2,layerRect.width*0.018);const runs=[];for(const line of lines){line.chars.sort((a,b)=>a.left-b.left);let current=null;for(const char of line.chars){if(!current||char.left-current.right>splitGap){current={id:runs.length,lineId:line.id,chars:[],left:char.left,right:char.right,top:char.top,bottom:char.bottom,height:char.height};runs.push(current);}current.chars.push(char);current.left=Math.min(current.left,char.left);current.right=Math.max(current.right,char.right);current.top=Math.min(current.top,char.top);current.bottom=Math.max(current.bottom,char.bottom);current.height=Math.max(current.height,char.height);char.runId=current.id;}}runs.sort((a,b)=>a.top-b.top||a.left-b.left);const lineHeight=Math.max(8,median(runs.map(run=>run.height)));const flows=[];for(const run of runs){let selected=null;let selectedScore=Infinity;for(const flow of flows){const previous=flow.runs[flow.runs.length-1];const verticalGap=run.top-previous.bottom;if(verticalGap<-(lineHeight*0.8)||verticalGap>Math.max(56,lineHeight*5))continue;const overlap=Math.max(0,Math.min(run.right,previous.right)-Math.max(run.left,previous.left));const overlapRatio=overlap/Math.max(1,Math.min(run.right-run.left,previous.right-previous.left));const alignedLeft=Math.abs(run.left-previous.left)<=Math.max(20,layerRect.width*0.035);if(overlapRatio<0.18&&!alignedLeft)continue;const score=Math.max(0,verticalGap)+Math.abs(run.left-previous.left)*0.25+Math.abs((run.left+run.right)-(previous.left+previous.right))*0.04;if(score<selectedScore){selected=flow;selectedScore=score;}}if(!selected){selected={id:flows.length,runs:[],chars:[]};flows.push(selected);}selected.runs.push(run);run.flowId=selected.id;}for(const flow of flows){flow.runs.sort((a,b)=>a.top-b.top||a.left-b.left);flow.chars=[];for(const run of flow.runs){run.chars.sort((a,b)=>a.left-b.left);for(const char of run.chars){char.flowId=flow.id;char.flowIndex=flow.chars.length;flow.chars.push(char);}}}return{layer,chars,flows,typicalWidth};}
function distanceToRect(x,y,rect){const dx=x<rect.left?rect.left-x:x>rect.right?x-rect.right:0;const dy=y<rect.top?rect.top-y:y>rect.bottom?y-rect.bottom:0;return dx*dx+dy*dy;}
function nearestVisualChar(clientX,clientY,flowId=null){if(!visualMap)return null;const layerRect=visualMap.layer.getBoundingClientRect();const x=clientX-layerRect.left;const y=clientY-layerRect.top;const pool=flowId==null?visualMap.chars:(visualMap.flows[flowId]?.chars||[]);let best=null;let bestDistance=Infinity;for(const char of pool){const distance=distanceToRect(x,y,char);if(distance<bestDistance){best=char;bestDistance=distance;}}return best?{char:best,distance:bestDistance}:null;}
function appendSelectionHandle(kind,char){const handle=document.createElement('div');handle.className=`selectionHandle selectionHandle${kind==='start'?'Start':'End'}`;handle.dataset.selectionHandle=kind;handle.style.left=(kind==='start'?char.left:char.right)+'px';handle.style.top=char.bottom+'px';visualMap.layer.appendChild(handle);selectionNodes.push(handle);}
function selectedTextForChars(chars){let text='';let previous=null;for(const char of chars){if(previous&&char.runId!==previous.runId)text+='\n';else if(previous&&char.left-previous.right>visualMap.typicalWidth*0.9&&!/\s$/.test(text)&&!/^\s/.test(char.char))text+=' ';text+=char.char;previous=char;}return text.trim();}
function renderLinearSelection(flow,startIndex,endIndex){if(!flow||!flow.chars.length)return;selectionFlow=flow;selectionStartIndex=Math.max(0,Math.min(startIndex,endIndex,flow.chars.length-1));selectionEndIndex=Math.max(selectionStartIndex,Math.min(Math.max(startIndex,endIndex),flow.chars.length-1));for(const node of selectionNodes)node.remove();selectionNodes=[];const selected=flow.chars.slice(selectionStartIndex,selectionEndIndex+1);const groups=[];for(const char of selected){let group=groups[groups.length-1];if(!group||group.runId!==char.runId){group={runId:char.runId,left:char.left,right:char.right,top:char.top,bottom:char.bottom};groups.push(group);}else{group.left=Math.min(group.left,char.left);group.right=Math.max(group.right,char.right);group.top=Math.min(group.top,char.top);group.bottom=Math.max(group.bottom,char.bottom);}}for(const group of groups){const highlight=document.createElement('div');highlight.className='dragSelectionHighlight';highlight.style.left=group.left+'px';highlight.style.top=group.top+'px';highlight.style.width=Math.max(1,group.right-group.left)+'px';highlight.style.height=Math.max(1,group.bottom-group.top)+'px';visualMap.layer.appendChild(highlight);selectionNodes.push(highlight);}appendSelectionHandle('start',selected[0]);appendSelectionHandle('end',selected[selected.length-1]);customSelectionText=selectedTextForChars(selected);customSelectionPage=Number(visualMap.layer.closest('.page')?.dataset.page||currentPage);}
function isWordCharacter(value){return /[A-Za-z0-9_\-\u00c0-\uffff]/.test(value);}
function selectWordAtIndex(flow,index){let start=index;let end=index;const target=flow.chars[index]?.char||'';if(isWordCharacter(target)){while(start>0&&flow.chars[start-1].runId===flow.chars[index].runId&&isWordCharacter(flow.chars[start-1].char))start--;while(end+1<flow.chars.length&&flow.chars[end+1].runId===flow.chars[index].runId&&isWordCharacter(flow.chars[end+1].char))end++;}renderLinearSelection(flow,start,end);}
function updateLinearSelectionFromPointer(event){if(!selectionGesture||!selectionFlow)return;const sameFlow=nearestVisualChar(event.clientX,event.clientY,selectionFlow.id);if(!sameFlow)return;const nearestAny=nearestVisualChar(event.clientX,event.clientY);if(nearestAny&&nearestAny.char.flowId!==selectionFlow.id&&nearestAny.distance+100<sameFlow.distance)statusElement.textContent='跨栏内容请分次选择';else statusElement.textContent='拖动端点可微调';const index=sameFlow.char.flowIndex;if(selectionGesture.handle==='start')renderLinearSelection(selectionFlow,Math.min(index,selectionEndIndex),selectionEndIndex);else if(selectionGesture.handle==='end')renderLinearSelection(selectionFlow,selectionStartIndex,Math.max(index,selectionStartIndex));else renderLinearSelection(selectionFlow,selectionGesture.anchorIndex,index);if(event.clientY<96)window.scrollBy(0,-8);else if(event.clientY>window.innerHeight-42)window.scrollBy(0,8);}
document.addEventListener('pointerdown',(event)=>{if(!selectionMode)return;const handle=event.target.closest?.('.selectionHandle');if(handle&&selectionFlow){selectionGesture={handle:handle.dataset.selectionHandle,anchorIndex:null,startX:event.clientX,startY:event.clientY,moved:true};event.target.setPointerCapture?.(event.pointerId);event.preventDefault();return;}const layer=event.target.closest?.('.textLayer');if(!layer)return;if(!visualMap||visualMap.layer!==layer)visualMap=buildVisualTextMap(layer);const hit=nearestVisualChar(event.clientX,event.clientY);if(!hit)return;clearCustomSelection();getSelection()?.removeAllRanges();selectionFlow=visualMap.flows[hit.char.flowId];selectionGesture={handle:null,anchorIndex:hit.char.flowIndex,startX:event.clientX,startY:event.clientY,moved:false};event.target.setPointerCapture?.(event.pointerId);event.preventDefault();},{passive:false});
document.addEventListener('pointermove',(event)=>{if(!selectionMode||!selectionGesture)return;if(!selectionGesture.moved&&Math.hypot(event.clientX-selectionGesture.startX,event.clientY-selectionGesture.startY)>4)selectionGesture.moved=true;if(selectionGesture.moved)updateLinearSelectionFromPointer(event);event.preventDefault();},{passive:false});
document.addEventListener('pointerup',(event)=>{if(selectionMode&&selectionGesture&&selectionFlow){if(selectionGesture.handle||selectionGesture.moved)updateLinearSelectionFromPointer(event);else selectWordAtIndex(selectionFlow,selectionGesture.anchorIndex);selectionGesture=null;publishSelection();event.preventDefault();return;}scheduleSelection(220);},{passive:false});
document.addEventListener('pointercancel',()=>{selectionGesture=null;});
selectButton.onclick=()=>{selectionMode=!selectionMode;document.body.classList.toggle('selectionMode',selectionMode);selectButton.classList.toggle('active',selectionMode);selectButton.textContent=selectionMode?'退出选字':'选字';statusElement.textContent=selectionMode?'直接拖动选字':`${currentPage} / ${documentRef?.numPages||'?'}`;};
document.addEventListener('selectionchange',()=>{if(!selectionMode){if(customSelectionText){clearCustomSelection();lastSelectionKey='';}scheduleSelection();}});document.addEventListener('touchend',()=>{if(!selectionMode){if(customSelectionText){clearCustomSelection();lastSelectionKey='';}scheduleSelection(220);}},{passive:true});
window.addEventListener('error',(event)=>reportError(event.error||event.message));window.addEventListener('unhandledrejection',(event)=>reportError(event.reason));void load();
</script></body></html>"#
        .replace("__CONFIG__", &config)
}

fn resolve_existing_pdf_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.trim());
    if !is_pdf_path(path.to_string_lossy().as_ref()) {
        return Err("Requested file is not a PDF.".to_string());
    }
    if !path.is_file() {
        return Err("PDF file was not found.".to_string());
    }
    Ok(path)
}

fn is_pdf_path(value: &str) -> bool {
    Path::new(value)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

fn has_existing_pdf(value: &str) -> bool {
    let trimmed = value.trim();
    is_pdf_path(trimmed) && Path::new(trimmed).is_file()
}

fn collect_workspace_pdf_records(
    app: &AppHandle,
    indexed_paths: &HashSet<String>,
    demo_library: &DemoLibrarySettings,
) -> Result<Vec<MobilePaperRecord>, String> {
    let workspace_root = mobile_workspace_root_dir(app)?;
    if !workspace_root.exists() {
        return Ok(Vec::new());
    }

    let mut result = Vec::new();
    for entry in WalkDir::new(&workspace_root)
        .into_iter()
        .filter_map(|entry| entry.ok())
    {
        let path = entry.path();
        if !entry.file_type().is_file() || !is_pdf_path(path.to_string_lossy().as_ref()) {
            continue;
        }
        let path_string = path.to_string_lossy().to_string();
        if indexed_paths.contains(&path_string) {
            continue;
        }
        if !is_demo_visible_path(&path_string, demo_library) {
            continue;
        }
        let title = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("document")
            .to_string();
        result.push(MobilePaperRecord {
            paper_id: workspace_pdf_id(path),
            title,
            paper_type: "workspace_pdf".to_string(),
            updated_at: file_modified_iso(path),
            has_pdf: true,
            source_type: "workspacePdf".to_string(),
        });
    }
    Ok(result)
}

fn load_demo_library_settings(app: &AppHandle) -> Result<DemoLibrarySettings, String> {
    let path = app_data_dir(app)?.join(DEMO_LIBRARY_FILE_NAME);
    if path.is_file() {
        let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        return serde_json::from_str(&content).map_err(|error| error.to_string());
    }
    let settings = DemoLibrarySettings::default();
    let content = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())?;
    Ok(settings)
}

fn is_demo_visible_path(path: &str, settings: &DemoLibrarySettings) -> bool {
    if !settings.enabled {
        return true;
    }
    let file_name = Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    settings
        .visible_file_names
        .iter()
        .any(|visible| visible.eq_ignore_ascii_case(file_name))
}

fn mobile_workspace_root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(app_data_dir.join("workspace"))
}

fn workspace_pdf_id(path: &Path) -> String {
    format!(
        "workspace_pdf_{}",
        Uuid::new_v5(&Uuid::NAMESPACE_URL, path.to_string_lossy().as_bytes(),).simple()
    )
}

fn file_modified_iso(path: &Path) -> String {
    path.metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| unix_seconds_to_iso(duration.as_secs() as i64))
        .unwrap_or_else(cards::current_timestamp_iso_utc)
}

fn safe_pdf_file_name(title: &str, fallback_id: &str) -> String {
    let mut base = title
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric()
                || character == '-'
                || character == '_'
                || character == '.'
                || character == ' '
            {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    if base.is_empty() || base.chars().all(|character| character == '_') {
        base = fallback_id
            .chars()
            .filter(|character| character.is_ascii_alphanumeric())
            .take(16)
            .collect::<String>();
    }
    if base.is_empty() {
        base = "document".to_string();
    }
    if !base.to_ascii_lowercase().ends_with(".pdf") {
        base.push_str(".pdf");
    }
    base
}

fn lookup_mode_key(mode: TermLookupMode) -> &'static str {
    match mode {
        TermLookupMode::PopularCn => "popular_cn",
        TermLookupMode::CsEncyclopedia => "cs_encyclopedia",
        TermLookupMode::Bioinformatics => "bioinformatics",
    }
}

fn apply_review_events(
    app: &AppHandle,
    payload: ReviewSyncRequest,
) -> Result<ReviewSyncResponse, String> {
    let mut store = read_review_state(app)?;
    let mut accepted_event_ids = Vec::new();
    let existing_card_ids = cards::list_knowledge_cards(app)?
        .into_iter()
        .map(|card| card.id)
        .collect::<HashSet<_>>();

    for event in payload.events {
        if event.event_id.trim().is_empty() || event.card_id.trim().is_empty() {
            continue;
        }
        if !store.applied_event_ids.insert(event.event_id.clone()) {
            accepted_event_ids.push(event.event_id.clone());
            continue;
        }
        if !existing_card_ids.contains(&event.card_id) {
            accepted_event_ids.push(event.event_id);
            continue;
        }

        let current = store.records.get(&event.card_id).cloned();
        let next = apply_review_event(current, &event);
        store.records.insert(event.card_id.clone(), next);
        accepted_event_ids.push(event.event_id);
    }

    write_review_state(app, &store)?;
    Ok(ReviewSyncResponse {
        accepted_event_ids,
        review_records: sorted_review_records(store.records.into_values().collect()),
    })
}

fn apply_review_event(current: Option<ReviewRecord>, event: &MobileReviewEvent) -> ReviewRecord {
    let mut record = current.unwrap_or_else(|| ReviewRecord {
        card_id: event.card_id.clone(),
        due_at: event.reviewed_at.clone(),
        interval_days: 0.0,
        ease_factor: 2.5,
        lapses: 0,
        consecutive_successes: 0,
        total_reviews: 0,
        last_rating: None,
        last_reviewed_at: None,
        history: Vec::new(),
    });

    let mut ease_factor = record.ease_factor.max(1.3);
    let mut interval_days = record.interval_days.max(0.0);

    match event.rating {
        ReviewRating::Again => {
            ease_factor = (ease_factor - 0.2).max(1.3);
            interval_days = 1.0;
            record.lapses += 1;
            record.consecutive_successes = 0;
        }
        ReviewRating::Hard => {
            ease_factor = (ease_factor - 0.15).max(1.3);
            interval_days = if record.total_reviews == 0 {
                1.0
            } else {
                (interval_days.max(1.0) * 1.2).round().max(1.0)
            };
            record.consecutive_successes += 1;
        }
        ReviewRating::Good => {
            interval_days = if record.total_reviews == 0 {
                1.0
            } else {
                (interval_days.max(1.0) * ease_factor).round().max(2.0)
            };
            record.consecutive_successes += 1;
        }
        ReviewRating::Easy => {
            ease_factor += 0.15;
            interval_days = if record.total_reviews == 0 {
                3.0
            } else {
                (interval_days.max(1.0) * ease_factor * 1.3)
                    .round()
                    .max(4.0)
            };
            record.consecutive_successes += 1;
        }
    }

    record.interval_days = interval_days;
    record.ease_factor = (ease_factor * 100.0).round() / 100.0;
    record.total_reviews += 1;
    record.last_rating = Some(event.rating);
    record.last_reviewed_at = Some(event.reviewed_at.clone());
    record.due_at = add_days_to_iso(&event.reviewed_at, interval_days);
    record.history.push(ReviewHistoryEntry {
        event_id: event.event_id.clone(),
        rating: event.rating,
        reviewed_at: event.reviewed_at.clone(),
        device_id: event.device_id.clone(),
    });
    if record.history.len() > 60 {
        let drain = record.history.len() - 60;
        record.history.drain(0..drain);
    }

    record
}

fn sorted_review_records(mut records: Vec<ReviewRecord>) -> Vec<ReviewRecord> {
    records.sort_by(|left, right| left.due_at.cmp(&right.due_at));
    records
}

fn store_inbox_item(
    app: &AppHandle,
    device_id: &str,
    input: MobileInboxItemInput,
) -> Result<MobileInboxItem, String> {
    ensure_mobile_dirs(app)?;
    let inbox_dir = mobile_inbox_dir(app)?;
    let asset_dir = inbox_asset_dir(app)?;
    let item_id = Uuid::new_v4().simple().to_string();
    let created_at = input
        .created_at
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(cards::current_timestamp_iso_utc);

    let stored_asset_path = if let Some(raw_base64) = input.asset_base64.as_deref() {
        let file_name = input
            .file_name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(sanitize_file_name)
            .unwrap_or_else(|| default_asset_file_name(&item_id, input.mime_type.as_deref()));
        let asset_path = asset_dir.join(file_name);
        let bytes = STANDARD
            .decode(raw_base64.trim())
            .map_err(|error| format!("Failed to decode image payload: {}", error))?;
        fs::write(&asset_path, bytes).map_err(|error| error.to_string())?;
        Some(asset_path.to_string_lossy().to_string())
    } else {
        None
    };

    let item = MobileInboxItem {
        id: item_id.clone(),
        capture_kind: input.capture_kind,
        status: MobileInboxStatus::Received,
        title: input.title.clone().filter(|value| !value.trim().is_empty()),
        note: input.note.clone().filter(|value| !value.trim().is_empty()),
        url: input.url.clone().filter(|value| !value.trim().is_empty()),
        file_name: input
            .file_name
            .clone()
            .filter(|value| !value.trim().is_empty()),
        mime_type: input
            .mime_type
            .clone()
            .filter(|value| !value.trim().is_empty()),
        stored_asset_path,
        device_id: device_id.to_string(),
        created_at: created_at.clone(),
    };

    let json_path = inbox_dir.join(format!("{}-{}.json", current_file_tag(), item_id));
    let content = serde_json::to_string_pretty(&item).map_err(|error| error.to_string())?;
    fs::write(json_path, content).map_err(|error| error.to_string())?;
    Ok(item)
}

fn map_desktop_mobile_inbox_item(
    item: MobileInboxItem,
    record_path: PathBuf,
) -> DesktopMobileInboxItem {
    DesktopMobileInboxItem {
        id: item.id,
        capture_kind: item.capture_kind,
        status: item.status,
        title: item.title,
        note: item.note,
        url: item.url,
        file_name: item.file_name,
        mime_type: item.mime_type,
        stored_asset_path: item.stored_asset_path,
        device_id: item.device_id,
        created_at: item.created_at,
        record_path: record_path.to_string_lossy().to_string(),
    }
}

pub fn set_mobile_chat_model(app: &AppHandle, model: &str) -> Result<(), String> {
    let normalized = model.trim();
    let previous = read_mobile_chat_settings(app).unwrap_or_default();
    let settings = MobileChatSettings {
        model: if normalized.is_empty() {
            MOBILE_CHAT_DEFAULT_MODEL.to_string()
        } else {
            normalized.to_string()
        },
        translation_model: if previous.translation_model.trim().is_empty() {
            MOBILE_TRANSLATION_DEFAULT_MODEL.to_string()
        } else {
            previous.translation_model
        },
    };
    let content = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(mobile_chat_settings_file(app)?, content).map_err(|error| error.to_string())
}

pub fn set_mobile_translation_model(app: &AppHandle, model: &str) -> Result<(), String> {
    let normalized = model.trim();
    let previous = read_mobile_chat_settings(app).unwrap_or_default();
    let settings = MobileChatSettings {
        model: if previous.model.trim().is_empty() {
            MOBILE_CHAT_DEFAULT_MODEL.to_string()
        } else {
            previous.model
        },
        translation_model: if normalized.is_empty() {
            MOBILE_TRANSLATION_DEFAULT_MODEL.to_string()
        } else {
            normalized.to_string()
        },
    };
    let content = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(mobile_chat_settings_file(app)?, content).map_err(|error| error.to_string())
}

fn get_mobile_chat_model(app: &AppHandle) -> String {
    read_mobile_chat_settings(app)
        .ok()
        .and_then(|settings| {
            let model = settings.model.trim();
            (!model.is_empty()).then(|| model.to_string())
        })
        .unwrap_or_else(|| MOBILE_CHAT_DEFAULT_MODEL.to_string())
}

fn get_mobile_translation_model(app: &AppHandle) -> String {
    read_mobile_chat_settings(app)
        .ok()
        .and_then(|settings| {
            let model = settings.translation_model.trim();
            (!model.is_empty()).then(|| model.to_string())
        })
        .unwrap_or_else(|| MOBILE_TRANSLATION_DEFAULT_MODEL.to_string())
}

pub fn list_mobile_chat_threads(app: &AppHandle) -> Result<Vec<MobileChatThreadSummary>, String> {
    ensure_mobile_dirs(app)?;
    let mut threads = Vec::new();
    for path in mobile_chat_thread_paths(app)? {
        let thread = match read_mobile_chat_thread_file(&path) {
            Ok(thread) => thread,
            Err(error) => {
                eprintln!(
                    "Failed to load mobile chat thread '{}': {}",
                    path.display(),
                    error
                );
                continue;
            }
        };
        threads.push(summarize_mobile_chat_thread(&thread));
    }
    threads.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(threads)
}

pub fn read_mobile_chat_thread(
    app: &AppHandle,
    thread_id: &str,
) -> Result<MobileChatThread, String> {
    let normalized = sanitize_thread_id(thread_id)?;
    read_mobile_chat_thread_file(&mobile_chat_dir(app)?.join(format!("{normalized}.json")))
}

pub fn delete_mobile_chat_thread(app: &AppHandle, thread_id: &str) -> Result<(), String> {
    let normalized = sanitize_thread_id(thread_id)?;
    let path = mobile_chat_dir(app)?.join(format!("{normalized}.json"));
    if !path.exists() {
        return Err("Mobile chat thread was not found.".to_string());
    }
    fs::remove_file(path).map_err(|error| error.to_string())
}

pub fn append_mobile_chat_thread_turn(
    app: &AppHandle,
    thread_id: &str,
    user_content: &str,
    assistant_content: &str,
    model: &str,
) -> Result<MobileChatThread, String> {
    let mut thread = read_mobile_chat_thread(app, thread_id)?;
    let now = cards::current_timestamp_iso_utc();
    thread.messages.push(MobileChatMessage {
        message_id: Uuid::new_v4().simple().to_string(),
        role: MobileChatRole::User,
        content: user_content.trim().to_string(),
        created_at: now.clone(),
        source: MobileChatSource::Desktop,
        status: MobileChatMessageStatus::Complete,
        citations: Vec::new(),
        innovation_analysis: None,
        idea_id: None,
        command: None,
        paper_context: None,
    });
    thread.messages.push(MobileChatMessage {
        message_id: Uuid::new_v4().simple().to_string(),
        role: MobileChatRole::Assistant,
        content: assistant_content.trim().to_string(),
        created_at: now.clone(),
        source: MobileChatSource::Desktop,
        status: MobileChatMessageStatus::Complete,
        citations: Vec::new(),
        innovation_analysis: None,
        idea_id: None,
        command: None,
        paper_context: None,
    });
    thread.model = model.trim().to_string();
    thread.status = MobileChatThreadStatus::Idle;
    thread.updated_at = now;
    thread.last_error = None;
    write_mobile_chat_thread(app, &thread)?;
    emit_mobile_thread_update(app, &thread);
    Ok(thread)
}

async fn run_mobile_chat_stream_task(
    state: MobileRouterState,
    thread_id: Option<String>,
    payload: MobileChatSendRequest,
    sender: mpsc::Sender<Result<Bytes, Infallible>>,
    cancel_receiver: watch::Receiver<bool>,
) {
    let mut context = MobileChatTaskContext::default();
    let result = run_mobile_chat_stream_task_inner(
        &state,
        thread_id,
        payload,
        &sender,
        cancel_receiver,
        &mut context,
    )
    .await;
    if let Err(error) = result {
        if let (Some(thread_id), Some(assistant_id)) = (
            context.thread_id.as_deref(),
            context.assistant_id.as_deref(),
        ) {
            if error == MOBILE_CHAT_STREAM_CLOSED {
                let _ = finish_mobile_chat_interrupted_if_streaming(
                    &state.app,
                    thread_id,
                    assistant_id,
                );
            } else {
                let _ = finish_mobile_chat_error(&state.app, thread_id, assistant_id, &error);
                let _ = send_ndjson(&sender, json!({ "type": "error", "error": error })).await;
            }
        } else {
            let _ = send_ndjson(&sender, json!({ "type": "error", "error": error })).await;
        }
    }
}

async fn run_mobile_chat_stream_task_inner(
    state: &MobileRouterState,
    thread_id: Option<String>,
    payload: MobileChatSendRequest,
    sender: &mpsc::Sender<Result<Bytes, Infallible>>,
    mut cancel_receiver: watch::Receiver<bool>,
    context: &mut MobileChatTaskContext,
) -> Result<(), String> {
    ensure_mobile_dirs(&state.app)?;
    let now = cards::current_timestamp_iso_utc();
    let is_new_thread = thread_id.is_none();
    let mut thread = if let Some(thread_id) = thread_id.as_deref() {
        read_mobile_chat_thread(&state.app, thread_id)?
    } else {
        let thread_id = Uuid::new_v4().simple().to_string();
        let title = build_mobile_chat_title(&payload.message);
        MobileChatThread {
            thread_id,
            title,
            created_at: now.clone(),
            updated_at: now.clone(),
            model: get_mobile_chat_model(&state.app),
            status: MobileChatThreadStatus::Idle,
            messages: Vec::new(),
            last_error: None,
        }
    };

    let command = normalize_mobile_chat_command(payload.command.as_deref())?;
    let paper_context = validate_mobile_chat_paper_context(payload.paper_context.as_ref())?;
    let use_retrieval = payload.use_retrieval.unwrap_or(is_new_thread)
        || payload.innovation_analysis.is_some()
        || paper_context.is_some();
    let user_message = MobileChatMessage {
        message_id: Uuid::new_v4().simple().to_string(),
        role: MobileChatRole::User,
        content: payload.message.trim().to_string(),
        created_at: now.clone(),
        source: MobileChatSource::Mobile,
        status: MobileChatMessageStatus::Complete,
        citations: Vec::new(),
        innovation_analysis: payload.innovation_analysis.clone(),
        idea_id: None,
        command: command.clone(),
        paper_context: paper_context.clone(),
    };
    let assistant_id = Uuid::new_v4().simple().to_string();
    let assistant_message = MobileChatMessage {
        message_id: assistant_id.clone(),
        role: MobileChatRole::Assistant,
        content: String::new(),
        created_at: now.clone(),
        source: MobileChatSource::Desktop,
        status: MobileChatMessageStatus::Streaming,
        citations: Vec::new(),
        innovation_analysis: payload.innovation_analysis.clone(),
        idea_id: None,
        command: command.clone(),
        paper_context: paper_context.clone(),
    };

    let previous_messages = thread.messages.clone();
    thread.messages.push(user_message.clone());
    thread.messages.push(assistant_message);
    thread.status = MobileChatThreadStatus::Streaming;
    thread.updated_at = now;
    thread.last_error = None;
    write_mobile_chat_thread(&state.app, &thread)?;
    context.thread_id = Some(thread.thread_id.clone());
    context.assistant_id = Some(assistant_id.clone());
    emit_mobile_thread_update(&state.app, &thread);

    send_ndjson(
        sender,
        json!({
            "type": "thread",
            "thread": thread,
            "useRetrieval": use_retrieval
        }),
    )
    .await?;
    send_ndjson(sender, json!({ "type": "queued" })).await?;

    if mobile_chat_cancel_requested(&cancel_receiver) {
        return finish_mobile_chat_interrupted(
            &state.app,
            &thread.thread_id,
            &assistant_id,
            "",
            sender,
        )
        .await;
    }

    let innovation_evidence = if let Some(analysis) = payload.innovation_analysis.clone() {
        emit_mobile_thread_progress(
            &state.app,
            &thread.thread_id,
            &assistant_id,
            Some("正在分别检索概念 A 与概念 B 的论文证据..."),
            "",
            "",
        );
        send_ndjson(
            sender,
            json!({ "type": "status", "status": "正在分别检索概念 A 与概念 B 的论文证据..." }),
        )
        .await?;
        let evidence = tokio::select! {
            result = build_mobile_innovation_context(&state.app, analysis) => result?,
            _ = wait_for_mobile_chat_cancel(&mut cancel_receiver) => {
                return finish_mobile_chat_interrupted(
                    &state.app,
                    &thread.thread_id,
                    &assistant_id,
                    "",
                    sender,
                ).await;
            }
        };
        Some(evidence)
    } else {
        None
    };
    if let Some(evidence) = &innovation_evidence {
        update_mobile_thread_sources(
            &state.app,
            &thread.thread_id,
            &assistant_id,
            evidence.citations.clone(),
            evidence.analysis.clone(),
        )?;
        send_ndjson(
            sender,
            json!({
                "type": "sources",
                "citations": evidence.citations,
                "innovationAnalysis": evidence.analysis,
            }),
        )
        .await?;
    }

    let context = if let Some(evidence) = &innovation_evidence {
        evidence.context.clone()
    } else if use_retrieval {
        emit_mobile_thread_progress(
            &state.app,
            &thread.thread_id,
            &assistant_id,
            Some("正在检索知识库上下文..."),
            "",
            "",
        );
        send_ndjson(
            sender,
            json!({ "type": "status", "status": "正在检索知识库上下文..." }),
        )
        .await?;
        tokio::select! {
            result = build_mobile_chat_retrieval_context(
                &state.app,
                &user_message.content,
                paper_context.as_ref(),
            ) => result.unwrap_or_default(),
            _ = wait_for_mobile_chat_cancel(&mut cancel_receiver) => {
                return finish_mobile_chat_interrupted(
                    &state.app,
                    &thread.thread_id,
                    &assistant_id,
                    "",
                    sender,
                ).await;
            }
        }
    } else {
        String::new()
    };
    emit_mobile_thread_progress(
        &state.app,
        &thread.thread_id,
        &assistant_id,
        Some("正在等待桌面模型空闲..."),
        "",
        "",
    );
    send_ndjson(
        sender,
        json!({ "type": "status", "status": "正在等待桌面模型空闲..." }),
    )
    .await?;
    let permit = tokio::select! {
        permit = state.chat_queue.acquire_timeout(
            ChatPriority::Mobile,
            tokio::time::Duration::from_secs(MOBILE_CHAT_QUEUE_TIMEOUT_SECS),
        ) => permit,
        _ = wait_for_mobile_chat_cancel(&mut cancel_receiver) => {
            return finish_mobile_chat_interrupted(
                &state.app,
                &thread.thread_id,
                &assistant_id,
                "",
                sender,
            ).await;
        }
    };
    let Some(permit) = permit else {
        return Err("模型队列等待超时：桌面端可能仍有一个生成任务卡住。请稍后重试，或在桌面端停止当前生成。".to_string());
    };
    emit_mobile_thread_progress(
        &state.app,
        &thread.thread_id,
        &assistant_id,
        Some("正在连接桌面模型并等待首段输出..."),
        "",
        "",
    );
    send_ndjson(
        sender,
        json!({ "type": "status", "status": "正在连接桌面模型并等待首段输出..." }),
    )
    .await?;
    let messages = build_mobile_chat_llm_messages(
        &previous_messages,
        &user_message.content,
        &context,
        innovation_evidence
            .as_ref()
            .map(|evidence| &evidence.analysis),
        command.as_deref(),
        paper_context.as_ref(),
    );
    let model = thread.model.clone();
    let thinking_enabled = payload.thinking_enabled.unwrap_or(true);
    let stream_result = stream_ollama_mobile_chat(
        &state.app,
        &thread.thread_id,
        &assistant_id,
        &model,
        messages,
        thinking_enabled,
        sender,
        &mut cancel_receiver,
    )
    .await;
    permit.release().await;

    match stream_result {
        Ok(MobileChatGenerationOutcome::Complete(answer)) => {
            update_mobile_thread_assistant(
                &state.app,
                &thread.thread_id,
                &assistant_id,
                answer.clone(),
                MobileChatMessageStatus::Complete,
                None,
            )?;
            let mut saved_idea_id = None;
            if let Some(evidence) = innovation_evidence.as_ref() {
                if !evidence.idea_evidence.is_empty() {
                    match research_memory::save_mobile_innovation_idea(
                        &state.app,
                        &thread.thread_id,
                        &assistant_id,
                        &evidence.analysis.concept_a,
                        &evidence.analysis.concept_b,
                        &answer,
                        &evidence.idea_evidence,
                    )
                    .await
                    {
                        Ok(idea) => {
                            update_mobile_thread_idea_id(
                                &state.app,
                                &thread.thread_id,
                                &assistant_id,
                                &idea.id,
                            )?;
                            saved_idea_id = Some(idea.id.clone());
                            send_ndjson(
                                sender,
                                json!({ "type": "idea", "ideaId": idea.id, "title": idea.title }),
                            )
                            .await?;
                        }
                        Err(error) => {
                            eprintln!("A+B 回答已完成，但保存 Idea Map 失败：{error}");
                            send_ndjson(
                                sender,
                                json!({ "type": "idea", "error": format!("回答已完成，但保存 Idea Map 失败：{error}") }),
                            )
                            .await?;
                        }
                    }
                }
            }
            send_ndjson(sender, json!({ "type": "done", "ideaId": saved_idea_id })).await?;
        }
        Ok(MobileChatGenerationOutcome::Interrupted(partial_answer)) => {
            finish_mobile_chat_interrupted(
                &state.app,
                &thread.thread_id,
                &assistant_id,
                &partial_answer,
                sender,
            )
            .await?;
        }
        Err(error) => {
            update_mobile_thread_assistant(
                &state.app,
                &thread.thread_id,
                &assistant_id,
                format!("回答失败：{error}"),
                MobileChatMessageStatus::Error,
                Some(error.clone()),
            )?;
            send_ndjson(sender, json!({ "type": "error", "error": error })).await?;
        }
    }
    Ok(())
}

async fn build_mobile_chat_retrieval_context(
    app: &AppHandle,
    query: &str,
    paper_context: Option<&MobileChatPaperContext>,
) -> Result<String, String> {
    let paper_id = paper_context
        .filter(|context| context.source_type == "paper")
        .map(|context| context.source_id.as_str());
    let paper_query = paper_context.map(|context| context.title.as_str());
    let docs = research_memory::query_knowledge_base(
        app,
        query,
        MOBILE_CHAT_RETRIEVAL_LIMIT,
        None,
        ResearchSearchScope {
            path: None,
            paper_query,
            paper_id,
        },
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(docs
        .into_iter()
        .map(|doc| doc.content)
        .collect::<Vec<_>>()
        .join("\n\n"))
}

struct MobileInnovationEvidence {
    analysis: MobileInnovationAnalysis,
    citations: Vec<MobileCitation>,
    idea_evidence: Vec<research_memory::InnovationIdeaEvidence>,
    context: String,
}

async fn build_mobile_innovation_context(
    app: &AppHandle,
    mut analysis: MobileInnovationAnalysis,
) -> Result<MobileInnovationEvidence, String> {
    let query_a = innovation_search_query(&analysis.concept_a, &analysis.concept_a_expansion);
    let query_b = innovation_search_query(&analysis.concept_b, &analysis.concept_b_expansion);
    let (hits_a, hits_b) = tokio::join!(
        research_memory::search_research_memory(
            app,
            &query_a,
            8,
            None,
            ResearchSearchScope::default(),
        ),
        research_memory::search_research_memory(
            app,
            &query_b,
            8,
            None,
            ResearchSearchScope::default(),
        )
    );
    let mut hits_a = hits_a.unwrap_or_else(|error| {
        eprintln!("A 侧本地论文检索失败，将按无本地证据继续：{error}");
        Vec::new()
    });
    let mut hits_b = hits_b.unwrap_or_else(|error| {
        eprintln!("B 侧本地论文检索失败，将按无本地证据继续：{error}");
        Vec::new()
    });
    if relevant_distinct_paper_hits(
        hits_a.clone(),
        &analysis.concept_a,
        analysis.concept_a_expansion.as_deref(),
        &HashSet::new(),
        1,
    )
    .is_empty()
    {
        hits_a.extend(load_workspace_innovation_hits(
            app,
            &analysis.concept_a,
            analysis.concept_a_expansion.as_deref(),
        )?);
    }
    if relevant_distinct_paper_hits(
        hits_b.clone(),
        &analysis.concept_b,
        analysis.concept_b_expansion.as_deref(),
        &HashSet::new(),
        1,
    )
    .is_empty()
    {
        hits_b.extend(load_workspace_innovation_hits(
            app,
            &analysis.concept_b,
            analysis.concept_b_expansion.as_deref(),
        )?);
    }
    let selected_a = relevant_distinct_paper_hits(
        hits_a,
        &analysis.concept_a,
        analysis.concept_a_expansion.as_deref(),
        &HashSet::new(),
        2,
    );
    let excluded = selected_a
        .iter()
        .map(|hit| hit.paper_id.clone())
        .collect::<HashSet<_>>();
    let selected_b = relevant_distinct_paper_hits(
        hits_b,
        &analysis.concept_b,
        analysis.concept_b_expansion.as_deref(),
        &excluded,
        2,
    );
    let mut citations = Vec::new();
    let mut idea_evidence = Vec::new();
    for (index, hit) in selected_a.iter().enumerate() {
        let label = format!("A{}", index + 1);
        citations.push(map_mobile_citation(&label, hit));
        idea_evidence.push(map_mobile_idea_evidence(&label, "A", hit));
    }
    for (index, hit) in selected_b.iter().enumerate() {
        let label = format!("B{}", index + 1);
        citations.push(map_mobile_citation(&label, hit));
        idea_evidence.push(map_mobile_idea_evidence(&label, "B", hit));
    }
    analysis.evidence_status = Some(
        match (
            citations
                .iter()
                .any(|citation| citation.label.starts_with('A')),
            citations
                .iter()
                .any(|citation| citation.label.starts_with('B')),
        ) {
            (true, true) => "both",
            (true, false) => "a_only",
            (false, true) => "b_only",
            (false, false) => "none",
        }
        .to_string(),
    );

    let mut evidence_lines = Vec::new();
    for citation in &citations {
        evidence_lines.push(format!(
            "[{}] 论文：{}；页码：{}-{}；证据片段：{}",
            citation.label,
            citation.title,
            citation.page_start,
            citation.page_end,
            citation.snippet
        ));
    }
    if !citations
        .iter()
        .any(|citation| citation.label.starts_with('A'))
    {
        evidence_lines.push("A 侧：无本地论文证据，不得生成 A 侧论文引用。".to_string());
    }
    if !citations
        .iter()
        .any(|citation| citation.label.starts_with('B'))
    {
        evidence_lines.push("B 侧：无本地论文证据，不得生成 B 侧论文引用。".to_string());
    }
    let allowed_labels = citations
        .iter()
        .map(|citation| format!("[{}]", citation.label))
        .collect::<Vec<_>>()
        .join("、");
    let allowed_labels = if allowed_labels.is_empty() {
        "无".to_string()
    } else {
        allowed_labels
    };
    let context = format!(
        "## A+B 创新分析任务\n概念 A：{}{}\n概念 B：{}{}\n\n## 唯一允许引用的本地证据\n{}\n\n正文只允许使用这些已提供标签：{}。禁止编造论文、作者、实验结果或引用。没有某侧证据时可以基于通用知识推断，但必须明确标为推断且不得附引用。若两侧均无证据，回答开头必须写：本次分析未使用本地论文证据。\n\n回答固定包含：1. 概念与问题定义；2. A 侧论文证据；3. B 侧论文证据；4. 可迁移机制与兼容性；5. 2–3 个创新假设；6. 最小可行实验方案；7. 潜在失败原因与反证；8. 证据边界。",
        analysis.concept_a,
        analysis
            .concept_a_expansion
            .as_deref()
            .map(|value| format!("（{value}）"))
            .unwrap_or_default(),
        analysis.concept_b,
        analysis
            .concept_b_expansion
            .as_deref()
            .map(|value| format!("（{value}）"))
            .unwrap_or_default(),
        evidence_lines.join("\n"),
        allowed_labels,
    );
    Ok(MobileInnovationEvidence {
        analysis,
        citations,
        idea_evidence,
        context,
    })
}

fn innovation_search_query(concept: &str, expansion: &Option<String>) -> String {
    match expansion
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(expansion) => format!("{} {}", concept.trim(), expansion),
        None => concept.trim().to_string(),
    }
}

#[cfg(test)]
fn first_relevant_distinct_paper_hit(
    hits: Vec<research_memory::ResearchSearchHit>,
    concept: &str,
    expansion: Option<&str>,
    excluded_paper_id: Option<&str>,
) -> Option<research_memory::ResearchSearchHit> {
    let excluded = excluded_paper_id
        .map(|paper_id| HashSet::from([paper_id.to_string()]))
        .unwrap_or_default();
    relevant_distinct_paper_hits(hits, concept, expansion, &excluded, 1)
        .into_iter()
        .next()
}

fn relevant_distinct_paper_hits(
    hits: Vec<research_memory::ResearchSearchHit>,
    concept: &str,
    expansion: Option<&str>,
    excluded_paper_ids: &HashSet<String>,
    limit: usize,
) -> Vec<research_memory::ResearchSearchHit> {
    consolidate_paper_hits(hits)
        .into_iter()
        .filter(|hit| {
            !excluded_paper_ids.contains(&hit.paper_id)
                && research_hit_matches_concept(hit, concept, expansion)
        })
        .take(limit)
        .collect()
}

fn consolidate_paper_hits(
    hits: Vec<research_memory::ResearchSearchHit>,
) -> Vec<research_memory::ResearchSearchHit> {
    let mut merged = Vec::<research_memory::ResearchSearchHit>::new();
    let mut positions = HashMap::<String, usize>::new();
    for hit in hits {
        if hit.paper_id.trim().is_empty() {
            continue;
        }
        if let Some(index) = positions.get(&hit.paper_id).copied() {
            let existing = &mut merged[index];
            existing.page_start = existing.page_start.min(hit.page_start);
            existing.page_end = existing.page_end.max(hit.page_end);
            existing.score = existing.score.max(hit.score);
            if !existing.snippet.contains(hit.snippet.trim()) && existing.snippet.len() < 1_200 {
                existing.snippet.push_str("\n…\n");
                existing.snippet.push_str(hit.snippet.trim());
            }
        } else {
            positions.insert(hit.paper_id.clone(), merged.len());
            merged.push(hit);
        }
    }
    merged
}

fn research_hit_matches_concept(
    hit: &research_memory::ResearchSearchHit,
    concept: &str,
    expansion: Option<&str>,
) -> bool {
    let haystack = format!("{} {}", hit.title, hit.snippet).to_lowercase();
    workspace_title_matches_concept(&haystack, concept, expansion)
        || [Some(concept), expansion]
            .into_iter()
            .flatten()
            .map(str::trim)
            .filter(|term| term.chars().count() >= 2)
            .any(|term| contains_relevance_term(&haystack, term))
}

fn contains_relevance_term(haystack: &str, term: &str) -> bool {
    let normalized = term.to_lowercase();
    if normalized
        .chars()
        .all(|character| character.is_ascii_alphanumeric())
    {
        haystack
            .split(|character: char| !character.is_ascii_alphanumeric())
            .any(|word| word == normalized)
    } else {
        haystack.contains(&normalized)
    }
}

fn load_workspace_innovation_hits(
    app: &AppHandle,
    concept: &str,
    expansion: Option<&str>,
) -> Result<Vec<research_memory::ResearchSearchHit>, String> {
    let demo_library = load_demo_library_settings(app)?;
    let workspace_root = mobile_workspace_root_dir(app)?;
    let mut hits = Vec::new();
    for entry in WalkDir::new(workspace_root)
        .into_iter()
        .filter_map(|entry| entry.ok())
    {
        let path = entry.path();
        if !entry.file_type().is_file()
            || !is_pdf_path(path.to_string_lossy().as_ref())
            || !is_demo_visible_path(path.to_string_lossy().as_ref(), &demo_library)
        {
            continue;
        }
        let title = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("未命名论文")
            .to_string();
        if !workspace_title_matches_concept(&title, concept, expansion) {
            continue;
        }
        let mut page = 1_i64;
        let mut snippet = research_memory::read_pdf_page_text(path, page).unwrap_or_default();
        if snippet.trim().is_empty() {
            page = 2;
            snippet = research_memory::read_pdf_page_text(path, page).unwrap_or_default();
        }
        if snippet.trim().is_empty() {
            continue;
        }
        let paper_id = workspace_pdf_id(path);
        hits.push(research_memory::ResearchSearchHit {
            id: format!("workspace-fallback-{paper_id}-{page}"),
            paper_id,
            path: path.to_string_lossy().to_string(),
            title,
            page_start: page,
            page_end: page,
            snippet: truncate_preview(&snippet, 600),
            score: 0.78,
            related_graph_nodes: Vec::new(),
        });
    }
    hits.sort_by(|left, right| left.title.cmp(&right.title));
    Ok(hits)
}

fn workspace_title_matches_concept(title: &str, concept: &str, expansion: Option<&str>) -> bool {
    let title = title.to_lowercase();
    let concept_text = format!("{} {}", concept, expansion.unwrap_or_default()).to_lowercase();
    let aliases: &[&str] = if concept_text.split_whitespace().any(|term| term == "ad")
        || concept_text.contains("阿尔茨海默")
        || concept_text.contains("alzheimer")
    {
        &["alzheimer", "dementia"]
    } else if concept_text.contains("gnn")
        || concept_text.contains("图神经网络")
        || concept_text.contains("graph neural")
    {
        &["gnn", "graph neural"]
    } else if concept_text.contains("single-cell") || concept_text.contains("单细胞") {
        &["single-cell", "single cell"]
    } else if concept_text.contains("causal") || concept_text.contains("因果") {
        &["causal"]
    } else {
        &[]
    };
    aliases.iter().any(|alias| title.contains(alias))
        || [Some(concept), expansion]
            .into_iter()
            .flatten()
            .map(str::trim)
            .filter(|term| term.chars().count() >= 3)
            .any(|term| title.contains(&term.to_lowercase()))
}

fn map_mobile_citation(label: &str, hit: &research_memory::ResearchSearchHit) -> MobileCitation {
    MobileCitation {
        label: label.to_string(),
        paper_id: hit.paper_id.clone(),
        title: hit.title.clone(),
        page_start: hit.page_start,
        page_end: hit.page_end,
        snippet: sanitize_mobile_evidence_snippet(&hit.snippet, 600),
        source_type: if hit.paper_id.starts_with("workspace_pdf_") {
            "workspacePdf".to_string()
        } else {
            "paper".to_string()
        },
    }
}

fn map_mobile_idea_evidence(
    label: &str,
    concept_role: &str,
    hit: &research_memory::ResearchSearchHit,
) -> research_memory::InnovationIdeaEvidence {
    research_memory::InnovationIdeaEvidence {
        citation_label: label.to_string(),
        concept_role: concept_role.to_string(),
        similarity_score: Some(hit.score),
        evidence: research_memory::EvidenceRef {
            paper_id: hit.paper_id.clone(),
            paper_title: hit.title.clone(),
            paper_path: hit.path.clone(),
            page_start: hit.page_start,
            page_end: hit.page_end,
            chunk_id: (!hit.id.starts_with("workspace-fallback-")).then(|| hit.id.clone()),
            snippet: sanitize_mobile_evidence_snippet(&hit.snippet, 600),
            source_type: if hit.paper_id.starts_with("workspace_pdf_") {
                "workspace_pdf_fallback".to_string()
            } else {
                "hybrid_search".to_string()
            },
        },
    }
}

fn sanitize_mobile_evidence_snippet(value: &str, limit: usize) -> String {
    let replacement_count = value
        .chars()
        .filter(|character| *character == '\u{fffd}')
        .count();
    let mojibake_count = ["Ã", "Â", "â€", "ï¿½"]
        .iter()
        .map(|marker| value.matches(marker).count())
        .sum::<usize>();
    let visible_count = value
        .chars()
        .filter(|character| !character.is_whitespace() && !character.is_control())
        .count();
    if replacement_count >= 2
        || (replacement_count > 0 && replacement_count * 100 > visible_count.max(1) * 2)
        || mojibake_count >= 2
        || value.contains('\0')
    {
        return String::new();
    }
    let cleaned = value
        .chars()
        .map(|character| {
            if character.is_control() && !matches!(character, '\n' | '\r' | '\t') {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    truncate_preview(&cleaned, limit)
}

fn build_mobile_chat_llm_messages(
    previous_messages: &[MobileChatMessage],
    current_user_message: &str,
    retrieval_context: &str,
    innovation_analysis: Option<&MobileInnovationAnalysis>,
    command: Option<&str>,
    paper_context: Option<&MobileChatPaperContext>,
) -> Vec<serde_json::Value> {
    let base_system_prompt = if innovation_analysis.is_some() {
        "你是严谨的科研创新分析助手。除非用户明确要求其他语言，否则使用中文 Markdown。你必须严格遵守给定证据标签：只引用上下文中实际提供的 [A1]/[B1]，绝不补造论文或引用；清楚区分论文证据、通用知识和待验证假设，并完整输出指定的八个部分。"
    } else {
        "你是科研助手。除非用户明确要求其他语言，否则使用中文 Markdown 回答。优先利用给定知识库上下文；没有上下文时基于已有对话和通用知识回答，并明确区分证据与推断。"
    };
    let command_instruction = mobile_chat_command_instruction(command);
    let paper_instruction = paper_context
        .map(|context| {
            format!(
                "用户已通过 @ 选择论文《{}》。回答必须优先围绕该论文；若提供的本地片段不足，必须明确说明证据不足，不得假装读过未提供的内容。",
                context.title.trim()
            )
        })
        .unwrap_or_default();
    let system_prompt = [
        base_system_prompt,
        command_instruction,
        paper_instruction.as_str(),
    ]
    .into_iter()
    .filter(|part| !part.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    let mut messages = vec![json!({
        "role": "system",
        "content": system_prompt
    })];

    let start = previous_messages
        .len()
        .saturating_sub(MOBILE_CHAT_HISTORY_LIMIT);
    for message in previous_messages.iter().skip(start) {
        if message.content.trim().is_empty() {
            continue;
        }
        messages.push(json!({
            "role": match message.role {
                MobileChatRole::User => "user",
                MobileChatRole::Assistant => "assistant",
            },
            "content": message.content
        }));
    }

    let content = if retrieval_context.trim().is_empty() {
        current_user_message.to_string()
    } else {
        format!(
            "## 知识库上下文\n{}\n\n## 用户消息\n{}",
            retrieval_context, current_user_message
        )
    };
    messages.push(json!({ "role": "user", "content": content }));
    messages
}

fn normalize_mobile_chat_command(command: Option<&str>) -> Result<Option<String>, String> {
    let Some(command) = command.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let normalized = command.to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "ask" | "method" | "exp" | "claim" | "brief" | "innovation"
    ) {
        Ok(Some(normalized))
    } else {
        Err(format!("不支持的移动会话指令：/{normalized}"))
    }
}

fn validate_mobile_chat_paper_context(
    paper_context: Option<&MobileChatPaperContext>,
) -> Result<Option<MobileChatPaperContext>, String> {
    let Some(context) = paper_context else {
        return Ok(None);
    };
    let source_type = context.source_type.trim();
    let source_id = context.source_id.trim();
    let title = context.title.trim();
    if !matches!(source_type, "paper" | "workspacePdf") {
        return Err("@ 论文来源类型无效。".to_string());
    }
    if source_id.is_empty() || title.is_empty() {
        return Err("@ 论文信息不完整。".to_string());
    }
    Ok(Some(MobileChatPaperContext {
        source_type: source_type.to_string(),
        source_id: source_id.to_string(),
        title: truncate_preview(title, 240),
    }))
}

fn mobile_chat_command_instruction(command: Option<&str>) -> &'static str {
    match command {
        Some("method") => "当前使用 /method：聚焦方法设计、技术路线、输入输出、关键模块和可复现实验步骤。",
        Some("exp") => "当前使用 /exp：聚焦实验设置、基线、消融、指标、结果边界和失败原因。",
        Some("claim") => "当前使用 /claim：提取核心论点，并逐项区分直接证据、间接支持和未经验证的推断。",
        Some("brief") => "当前使用 /brief：输出紧凑的 Markdown 论文简报，包含研究问题、方法、主要发现、局限和下一步。",
        Some("innovation") => "当前使用 /innovation：以组合创新为目标，给出可迁移机制、创新假设、最小实验和反证条件。",
        Some("ask") => "当前使用 /ask：直接回答用户问题，并给出必要的论文证据边界。",
        _ => "",
    }
}

enum MobileChatGenerationOutcome {
    Complete(String),
    Interrupted(String),
}

fn mobile_chat_cancel_requested(receiver: &watch::Receiver<bool>) -> bool {
    *receiver.borrow()
}

async fn wait_for_mobile_chat_cancel(receiver: &mut watch::Receiver<bool>) {
    if mobile_chat_cancel_requested(receiver) {
        return;
    }
    while receiver.changed().await.is_ok() {
        if mobile_chat_cancel_requested(receiver) {
            return;
        }
    }
}

async fn finish_mobile_chat_interrupted(
    app: &AppHandle,
    thread_id: &str,
    assistant_id: &str,
    partial_answer: &str,
    sender: &mpsc::Sender<Result<Bytes, Infallible>>,
) -> Result<(), String> {
    let content = if partial_answer.trim().is_empty() {
        "已停止本次生成。".to_string()
    } else {
        partial_answer.to_string()
    };
    update_mobile_thread_assistant(
        app,
        thread_id,
        assistant_id,
        content,
        MobileChatMessageStatus::Interrupted,
        None,
    )?;
    send_ndjson(
        sender,
        json!({ "type": "interrupted", "message": "已停止本次生成。" }),
    )
    .await
}

fn finish_mobile_chat_interrupted_if_streaming(
    app: &AppHandle,
    thread_id: &str,
    assistant_id: &str,
) -> Result<(), String> {
    let mut thread = read_mobile_chat_thread(app, thread_id)?;
    let Some(message) = thread
        .messages
        .iter_mut()
        .find(|message| message.message_id == assistant_id)
    else {
        return Ok(());
    };
    if message.status != MobileChatMessageStatus::Streaming {
        return Ok(());
    }
    if message.content.trim().is_empty() {
        message.content = "移动端连接中断，本次生成已停止。".to_string();
    }
    message.status = MobileChatMessageStatus::Interrupted;
    thread.status = MobileChatThreadStatus::Idle;
    thread.updated_at = cards::current_timestamp_iso_utc();
    thread.last_error = None;
    write_mobile_chat_thread(app, &thread)?;
    emit_mobile_thread_update(app, &thread);
    Ok(())
}

async fn stream_ollama_mobile_chat(
    app: &AppHandle,
    thread_id: &str,
    assistant_id: &str,
    model: &str,
    messages: Vec<serde_json::Value>,
    think_enabled: bool,
    sender: &mpsc::Sender<Result<Bytes, Infallible>>,
    cancel_receiver: &mut watch::Receiver<bool>,
) -> Result<MobileChatGenerationOutcome, String> {
    let client = reqwest::Client::new();
    let request = client
        .post("http://localhost:11434/api/chat")
        .json(&json!({
            "model": model,
            "messages": messages,
            "think": think_enabled,
            "stream": true
        }))
        .send();
    let response = tokio::select! {
        response = request => response
            .map_err(|error| format!("Failed to connect to LLM: {}", error))?,
        _ = wait_for_mobile_chat_cancel(cancel_receiver) => {
            return Ok(MobileChatGenerationOutcome::Interrupted(String::new()));
        }
    };
    if !response.status().is_success() {
        return Err(format!("LLM API error: {}", response.status()));
    }

    let mut answer = String::new();
    let mut reasoning = String::new();
    let mut buffer = String::new();
    let mut bytes_stream = response.bytes_stream();
    loop {
        let next_chunk = tokio::select! {
            chunk = bytes_stream.next() => chunk,
            _ = wait_for_mobile_chat_cancel(cancel_receiver) => {
                let partial = format_mobile_chat_answer(&answer, &reasoning);
                return Ok(MobileChatGenerationOutcome::Interrupted(partial));
            }
        };
        let Some(chunk) = next_chunk else {
            break;
        };
        let chunk = chunk.map_err(|error| error.to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(newline_index) = buffer.find('\n') {
            let line = buffer[..newline_index].trim().to_string();
            buffer.drain(..=newline_index);
            if line.is_empty() {
                continue;
            }
            if let Err(error) = process_ollama_mobile_line(
                app,
                thread_id,
                assistant_id,
                &line,
                &mut answer,
                &mut reasoning,
                sender,
            )
            .await
            {
                if error == MOBILE_CHAT_STREAM_CLOSED {
                    return Ok(MobileChatGenerationOutcome::Interrupted(
                        format_mobile_chat_answer(&answer, &reasoning),
                    ));
                }
                return Err(error);
            }
        }
    }
    if !buffer.trim().is_empty() {
        if let Err(error) = process_ollama_mobile_line(
            app,
            thread_id,
            assistant_id,
            buffer.trim(),
            &mut answer,
            &mut reasoning,
            sender,
        )
        .await
        {
            if error == MOBILE_CHAT_STREAM_CLOSED {
                return Ok(MobileChatGenerationOutcome::Interrupted(
                    format_mobile_chat_answer(&answer, &reasoning),
                ));
            }
            return Err(error);
        }
    }
    if answer.trim().is_empty() && reasoning.trim().is_empty() {
        Err("LLM response did not include content".to_string())
    } else {
        Ok(MobileChatGenerationOutcome::Complete(
            format_mobile_chat_answer(&answer, &reasoning),
        ))
    }
}

fn format_mobile_chat_answer(answer: &str, reasoning: &str) -> String {
    if answer.trim().is_empty() {
        format!("<think>\n{}\n</think>", reasoning.trim())
    } else if reasoning.trim().is_empty() {
        answer.to_string()
    } else {
        format!("<think>\n{}\n</think>\n\n{}", reasoning.trim(), answer)
    }
}

#[cfg(test)]
mod mobile_chat_cancellation_tests {
    use super::*;

    fn streaming_thread(content: &str) -> MobileChatThread {
        serde_json::from_value(serde_json::json!({
            "threadId": "thread-1",
            "title": "测试会话",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "model": "qwen3:8b",
            "status": "streaming",
            "messages": [{
                "messageId": "assistant-1",
                "role": "assistant",
                "content": content,
                "createdAt": "2026-01-01T00:00:00Z",
                "source": "desktop",
                "status": "streaming"
            }],
            "lastError": null
        }))
        .expect("测试会话应可读取")
    }

    #[tokio::test]
    async fn cancellation_signal_reaches_waiting_generation() {
        let (sender, mut receiver) = watch::channel(false);
        sender.send_replace(true);

        tokio::time::timeout(
            Duration::from_millis(100),
            wait_for_mobile_chat_cancel(&mut receiver),
        )
        .await
        .expect("取消信号应立即唤醒生成任务");
        assert!(mobile_chat_cancel_requested(&receiver));
    }

    #[test]
    fn interrupted_partial_answer_keeps_reasoning_and_answer() {
        let content = format_mobile_chat_answer("部分回答", "部分思考");
        assert!(content.contains("部分思考"));
        assert!(content.contains("部分回答"));
    }

    #[test]
    fn 非法请求_id_会被拒绝而旧客户端仍可生成() {
        assert!(normalize_mobile_chat_request_id(None).is_ok());
        assert!(normalize_mobile_chat_request_id(Some("mobile-123_ok.1")).is_ok());
        assert!(normalize_mobile_chat_request_id(Some("含中文")).is_err());
        assert!(normalize_mobile_chat_request_id(Some("bad/id")).is_err());
    }

    #[test]
    fn 提前取消会被首个生成消费且活动_id_拒绝重复提交() {
        let registry: MobileChatCancellationRegistry = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = watch::channel(true);
        drop(receiver);
        registry.lock().expect("应锁定注册表").insert(
            "request-1".to_string(),
            MobileChatCancellationEntry::Pending(sender),
        );

        let receiver = register_mobile_chat_generation(&registry, "request-1")
            .expect("首个生成应消费提前取消");
        assert!(mobile_chat_cancel_requested(&receiver));
        assert_eq!(
            register_mobile_chat_generation(&registry, "request-1").unwrap_err(),
            MobileChatRegistrationError::Conflict
        );
        assert!(remove_mobile_chat_generation(&registry, "request-1"));
        assert!(register_mobile_chat_generation(&registry, "request-1").is_ok());
    }

    #[test]
    fn 错误终态保留部分回答并让线程退出_streaming() {
        let mut thread = streaming_thread("已有部分回答");
        apply_mobile_chat_error_terminal(&mut thread, "assistant-1", "模型连接失败");
        assert_eq!(thread.status, MobileChatThreadStatus::Idle);
        assert_eq!(thread.messages[0].status, MobileChatMessageStatus::Error);
        assert_eq!(thread.messages[0].content, "已有部分回答");
        assert_eq!(thread.last_error.as_deref(), Some("模型连接失败"));
    }
}

async fn process_ollama_mobile_line(
    app: &AppHandle,
    thread_id: &str,
    assistant_id: &str,
    line: &str,
    answer: &mut String,
    reasoning: &mut String,
    sender: &mpsc::Sender<Result<Bytes, Infallible>>,
) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_str(line).map_err(|error| error.to_string())?;
    let message = value.get("message");
    let thinking_delta = message
        .and_then(|value| value.get("thinking"))
        .and_then(|value| value.as_str())
        .or_else(|| value.get("thinking").and_then(|value| value.as_str()))
        .unwrap_or("");
    let delta = message
        .and_then(|value| value.get("content"))
        .and_then(|value| value.as_str())
        .or_else(|| value.get("response").and_then(|value| value.as_str()))
        .unwrap_or("");
    if !thinking_delta.is_empty() {
        reasoning.push_str(thinking_delta);
        emit_mobile_thread_progress(app, thread_id, assistant_id, None, reasoning, answer);
        send_ndjson(
            sender,
            json!({ "type": "delta", "delta": thinking_delta, "phase": "thinking" }),
        )
        .await?;
    }
    if !delta.is_empty() {
        answer.push_str(delta);
        emit_mobile_thread_progress(app, thread_id, assistant_id, None, reasoning, answer);
        send_ndjson(
            sender,
            json!({ "type": "delta", "delta": delta, "phase": "answer" }),
        )
        .await?;
    }
    Ok(())
}

async fn send_ndjson(
    sender: &mpsc::Sender<Result<Bytes, Infallible>>,
    value: serde_json::Value,
) -> Result<(), String> {
    let line = serde_json::to_string(&value).map_err(|error| error.to_string())? + "\n";
    if sender.send(Ok(Bytes::from(line))).await.is_err() {
        return Err(MOBILE_CHAT_STREAM_CLOSED.to_string());
    }
    Ok(())
}

fn finish_mobile_chat_error(
    app: &AppHandle,
    thread_id: &str,
    assistant_id: &str,
    error: &str,
) -> Result<(), String> {
    let mut thread = read_mobile_chat_thread(app, thread_id)?;
    apply_mobile_chat_error_terminal(&mut thread, assistant_id, error);
    thread.updated_at = cards::current_timestamp_iso_utc();
    write_mobile_chat_thread(app, &thread)?;
    emit_mobile_thread_update(app, &thread);
    Ok(())
}

fn apply_mobile_chat_error_terminal(
    thread: &mut MobileChatThread,
    assistant_id: &str,
    error: &str,
) {
    if let Some(message) = thread
        .messages
        .iter_mut()
        .find(|message| message.message_id == assistant_id)
    {
        if message.content.trim().is_empty() {
            message.content = format!("回答失败：{error}");
        }
        message.status = MobileChatMessageStatus::Error;
    }
    thread.status = MobileChatThreadStatus::Idle;
    thread.last_error = Some(error.to_string());
}

fn update_mobile_thread_assistant(
    app: &AppHandle,
    thread_id: &str,
    assistant_id: &str,
    content: String,
    status: MobileChatMessageStatus,
    last_error: Option<String>,
) -> Result<(), String> {
    let mut thread = read_mobile_chat_thread(app, thread_id)?;
    if let Some(message) = thread
        .messages
        .iter_mut()
        .find(|message| message.message_id == assistant_id)
    {
        message.content = content;
        message.status = status.clone();
    }
    thread.status = MobileChatThreadStatus::Idle;
    thread.updated_at = cards::current_timestamp_iso_utc();
    thread.last_error = last_error;
    write_mobile_chat_thread(app, &thread)?;
    emit_mobile_thread_update(app, &thread);
    Ok(())
}

fn update_mobile_thread_sources(
    app: &AppHandle,
    thread_id: &str,
    assistant_id: &str,
    citations: Vec<MobileCitation>,
    analysis: MobileInnovationAnalysis,
) -> Result<(), String> {
    let mut thread = read_mobile_chat_thread(app, thread_id)?;
    if let Some(message) = thread
        .messages
        .iter_mut()
        .find(|message| message.message_id == assistant_id)
    {
        message.citations = citations;
        message.innovation_analysis = Some(analysis);
    }
    thread.updated_at = cards::current_timestamp_iso_utc();
    write_mobile_chat_thread(app, &thread)?;
    emit_mobile_thread_update(app, &thread);
    Ok(())
}

fn update_mobile_thread_idea_id(
    app: &AppHandle,
    thread_id: &str,
    assistant_id: &str,
    idea_id: &str,
) -> Result<(), String> {
    let mut thread = read_mobile_chat_thread(app, thread_id)?;
    if let Some(message) = thread
        .messages
        .iter_mut()
        .find(|message| message.message_id == assistant_id)
    {
        message.idea_id = Some(idea_id.to_string());
    }
    thread.updated_at = cards::current_timestamp_iso_utc();
    write_mobile_chat_thread(app, &thread)?;
    emit_mobile_thread_update(app, &thread);
    Ok(())
}

fn clear_mobile_thread_idea_id(
    app: &AppHandle,
    thread_id: &str,
    assistant_id: &str,
) -> Result<MobileChatThread, String> {
    let mut thread = read_mobile_chat_thread(app, thread_id)?;
    let message = thread
        .messages
        .iter_mut()
        .find(|message| message.message_id == assistant_id)
        .ok_or_else(|| "未找到创新分析消息。".to_string())?;
    message.idea_id = None;
    thread.updated_at = cards::current_timestamp_iso_utc();
    write_mobile_chat_thread(app, &thread)?;
    emit_mobile_thread_update(app, &thread);
    Ok(thread)
}

fn delete_mobile_innovation_result(
    app: &AppHandle,
    thread_id: &str,
    assistant_id: &str,
) -> Result<MobileChatThread, String> {
    let mut thread = read_mobile_chat_thread(app, thread_id)?;
    let assistant_index = thread
        .messages
        .iter()
        .position(|message| {
            message.message_id == assistant_id
                && message.role == MobileChatRole::Assistant
                && message.innovation_analysis.is_some()
        })
        .ok_or_else(|| "未找到要删除的创新分析记录。".to_string())?;
    if thread.messages[assistant_index].status == MobileChatMessageStatus::Streaming {
        return Err("创新分析仍在生成，暂时不能删除。".to_string());
    }
    thread.messages.remove(assistant_index);
    if assistant_index > 0 {
        let previous = &thread.messages[assistant_index - 1];
        if previous.role == MobileChatRole::User && previous.innovation_analysis.is_some() {
            thread.messages.remove(assistant_index - 1);
        }
    }
    thread.updated_at = cards::current_timestamp_iso_utc();
    thread.status = MobileChatThreadStatus::Idle;
    thread.last_error = None;
    write_mobile_chat_thread(app, &thread)?;
    emit_mobile_thread_update(app, &thread);
    Ok(thread)
}

fn emit_mobile_thread_progress(
    app: &AppHandle,
    thread_id: &str,
    assistant_id: &str,
    status: Option<&str>,
    reasoning: &str,
    answer: &str,
) {
    let _ = app.emit(
        "mobile-chat-thread-progress",
        json!({
            "threadId": thread_id,
            "messageId": assistant_id,
            "status": status,
            "reasoning": reasoning,
            "answer": answer,
        }),
    );
}

fn emit_mobile_thread_update(app: &AppHandle, thread: &MobileChatThread) {
    let _ = app.emit(
        "mobile-chat-thread-updated",
        summarize_mobile_chat_thread(thread),
    );
}

fn summarize_mobile_chat_thread(thread: &MobileChatThread) -> MobileChatThreadSummary {
    let last_message_preview = thread
        .messages
        .iter()
        .rev()
        .find(|message| !message.content.trim().is_empty())
        .map(|message| truncate_preview(&message.content, 120))
        .unwrap_or_default();
    MobileChatThreadSummary {
        thread_id: thread.thread_id.clone(),
        title: thread.title.clone(),
        updated_at: thread.updated_at.clone(),
        model: thread.model.clone(),
        status: thread.status.clone(),
        last_message_preview,
        message_count: thread.messages.len(),
        last_error: thread.last_error.clone(),
    }
}

fn build_mobile_chat_title(message: &str) -> String {
    let title = truncate_preview(message, 32);
    if title.is_empty() {
        "移动端会话".to_string()
    } else {
        title
    }
}

fn truncate_preview(value: &str, limit: usize) -> String {
    let normalized = value
        .replace('\n', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut result = normalized.chars().take(limit).collect::<String>();
    if normalized.chars().count() > limit {
        result.push_str("...");
    }
    result
}

fn sanitize_thread_id(thread_id: &str) -> Result<String, String> {
    let normalized = thread_id.trim();
    if normalized.is_empty()
        || !normalized
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("Invalid chat thread id.".to_string());
    }
    Ok(normalized.to_string())
}

fn mobile_chat_thread_paths(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let entries = fs::read_dir(mobile_chat_dir(app)?).map_err(|error| error.to_string())?;
    Ok(entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_json_file(path))
        .collect())
}

fn read_mobile_chat_thread_file(path: &Path) -> Result<MobileChatThread, String> {
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn write_mobile_chat_thread(app: &AppHandle, thread: &MobileChatThread) -> Result<(), String> {
    let thread_id = sanitize_thread_id(&thread.thread_id)?;
    let content = serde_json::to_string_pretty(thread).map_err(|error| error.to_string())?;
    fs::write(
        mobile_chat_dir(app)?.join(format!("{thread_id}.json")),
        content,
    )
    .map_err(|error| error.to_string())
}

fn recover_mobile_chat_thread_after_restart(thread: &mut MobileChatThread) -> bool {
    let mut changed = false;
    for message in &mut thread.messages {
        if message.status == MobileChatMessageStatus::Streaming {
            message.status = MobileChatMessageStatus::Interrupted;
            if message.content.trim().is_empty() {
                message.content = "桌面端重启，本次生成已中断。".to_string();
            }
            changed = true;
        }
    }

    if thread.status == MobileChatThreadStatus::Streaming {
        thread.status = MobileChatThreadStatus::Idle;
        thread.last_error = None;
        changed = true;
    }

    if changed {
        thread.updated_at = cards::current_timestamp_iso_utc();
    }
    changed
}

fn recover_interrupted_mobile_chat_threads(app: &AppHandle) -> Result<(), String> {
    for path in mobile_chat_thread_paths(app)? {
        let mut thread = match read_mobile_chat_thread_file(&path) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("跳过无法读取的移动会话文件 '{}': {}", path.display(), error);
                continue;
            }
        };
        if recover_mobile_chat_thread_after_restart(&mut thread) {
            write_mobile_chat_thread(app, &thread)?;
        }
    }
    Ok(())
}

fn read_mobile_chat_settings(app: &AppHandle) -> Result<MobileChatSettings, String> {
    let path = mobile_chat_settings_file(app)?;
    if !path.exists() {
        return Ok(MobileChatSettings {
            model: MOBILE_CHAT_DEFAULT_MODEL.to_string(),
            translation_model: MOBILE_TRANSLATION_DEFAULT_MODEL.to_string(),
        });
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn mobile_inbox_status_rank(status: MobileInboxStatus) -> u8 {
    match status {
        MobileInboxStatus::Received => 0,
        MobileInboxStatus::Processed => 1,
    }
}

fn mobile_inbox_record_paths(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let entries = fs::read_dir(mobile_inbox_dir(app)?).map_err(|error| error.to_string())?;
    let mut paths = Vec::new();
    for entry in entries {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_file() && is_json_file(&path) {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn find_mobile_inbox_item_by_id(
    app: &AppHandle,
    item_id: &str,
) -> Result<(MobileInboxItem, PathBuf), String> {
    for path in mobile_inbox_record_paths(app)? {
        let item = match read_mobile_inbox_item_file(&path) {
            Ok(value) => value,
            Err(error) => {
                eprintln!(
                    "Failed to load mobile inbox item '{}': {}",
                    path.display(),
                    error
                );
                continue;
            }
        };
        if item.id == item_id {
            return Ok((item, path));
        }
    }

    Err(format!("Mobile inbox item '{}' was not found.", item_id))
}

fn read_mobile_inbox_item_file(path: &Path) -> Result<MobileInboxItem, String> {
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn write_mobile_inbox_item_file(path: &Path, item: &MobileInboxItem) -> Result<(), String> {
    let content = serde_json::to_string_pretty(item).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn default_asset_file_name(item_id: &str, mime_type: Option<&str>) -> String {
    let extension = match mime_type.unwrap_or_default() {
        "image/png" => "png",
        "image/webp" => "webp",
        _ => "jpg",
    };
    format!("{}-capture.{}", item_id, extension)
}

fn sanitize_file_name(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '.' | '_' | '-' => ch,
            _ => '_',
        })
        .collect::<String>();
    if sanitized.trim_matches('_').is_empty() {
        "capture.jpg".to_string()
    } else {
        sanitized
    }
}

fn persist_runtime_state(app: &AppHandle, state: &MobileCompanionState) -> Result<(), String> {
    let snapshot = state.snapshot()?;
    write_stored_mobile_state(
        app,
        &StoredMobileCompanionState {
            pair_code: snapshot.pair_code,
            paired_devices: snapshot.paired_devices,
        },
    )
}

fn read_stored_mobile_state(app: &AppHandle) -> Result<StoredMobileCompanionState, String> {
    let path = mobile_state_file(app)?;
    if !path.exists() {
        return Ok(StoredMobileCompanionState::default());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn write_stored_mobile_state(
    app: &AppHandle,
    state: &StoredMobileCompanionState,
) -> Result<(), String> {
    let path = mobile_state_file(app)?;
    let content = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn read_review_state(app: &AppHandle) -> Result<StoredReviewState, String> {
    let path = review_state_file(app)?;
    if !path.exists() {
        return Ok(StoredReviewState::default());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn write_review_state(app: &AppHandle, state: &StoredReviewState) -> Result<(), String> {
    let path = review_state_file(app)?;
    let content = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn ensure_mobile_dirs(app: &AppHandle) -> Result<(), String> {
    fs::create_dir_all(mobile_inbox_dir(app)?).map_err(|error| error.to_string())?;
    fs::create_dir_all(inbox_asset_dir(app)?).map_err(|error| error.to_string())?;
    fs::create_dir_all(review_state_dir(app)?).map_err(|error| error.to_string())?;
    fs::create_dir_all(mobile_chat_dir(app)?).map_err(|error| error.to_string())?;
    Ok(())
}

fn mobile_state_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(MOBILE_STATE_FILE_NAME))
}

fn review_state_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(REVIEW_STATE_DIR_NAME))
}

fn review_state_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(review_state_dir(app)?.join(REVIEW_STATE_FILE_NAME))
}

fn mobile_inbox_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(MOBILE_INBOX_DIR_NAME))
}

fn inbox_asset_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(mobile_inbox_dir(app)?.join(MOBILE_INBOX_ASSET_DIR_NAME))
}

fn mobile_chat_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(MOBILE_CHAT_DIR_NAME))
}

fn mobile_chat_settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(MOBILE_CHAT_SETTINGS_FILE_NAME))
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn count_inbox_items(dir: &Path) -> Result<usize, String> {
    let entries = fs::read_dir(dir).map_err(|error| error.to_string())?;
    Ok(entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_file())
        .filter(|entry| is_json_file(&entry.path()))
        .count())
}

fn is_json_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("json"))
        .unwrap_or(false)
}

fn generate_pair_code() -> String {
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos())
        .unwrap_or(0);
    format!("{:06}", seed % 1_000_000)
}

fn current_file_tag() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    seconds.to_string()
}

fn add_days_to_iso(iso: &str, interval_days: f32) -> String {
    let base = parse_iso_utc(iso).unwrap_or_else(current_unix_seconds);
    unix_seconds_to_iso(base + (interval_days.round() as i64 * 86_400))
}

fn parse_iso_utc(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    let date_time = trimmed.strip_suffix('Z')?;
    let (date, time) = date_time.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i32>().ok()?;
    let month = date_parts.next()?.parse::<u32>().ok()?;
    let day = date_parts.next()?.parse::<u32>().ok()?;
    let time_part = time.split('.').next().unwrap_or(time);
    let mut time_parts = time_part.split(':');
    let hour = time_parts.next()?.parse::<u32>().ok()?;
    let minute = time_parts.next()?.parse::<u32>().ok()?;
    let second = time_parts.next()?.parse::<u32>().ok()?;
    let days = days_from_civil(year, month, day);
    Some(days * 86_400 + hour as i64 * 3_600 + minute as i64 * 60 + second as i64)
}

fn current_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn unix_seconds_to_iso(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = (seconds_of_day / 3_600) as u32;
    let minute = ((seconds_of_day % 3_600) / 60) as u32;
    let second = (seconds_of_day % 60) as u32;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, minute, second
    )
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let adjusted_year = year - if month <= 2 { 1 } else { 0 };
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let yoe = adjusted_year - era * 400;
    let month_index = month as i32;
    let doy = (153 * (month_index + if month > 2 { -3 } else { 9 }) + 2) / 5 + day as i32 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era * 146_097 + doe - 719_468) as i64
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = (yoe + era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (mp + if mp < 10 { 3 } else { -9 }) as u32;
    if month <= 2 {
        year += 1;
    }
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn search_hit(paper_id: &str, title: &str) -> research_memory::ResearchSearchHit {
        research_memory::ResearchSearchHit {
            id: format!("命中-{paper_id}"),
            paper_id: paper_id.to_string(),
            path: format!("{paper_id}.pdf"),
            title: title.to_string(),
            page_start: 2,
            page_end: 3,
            snippet: "证据片段".to_string(),
            score: 0.9,
            related_graph_nodes: Vec::new(),
        }
    }

    #[test]
    fn 旧会话消息缺少新字段时仍可读取() {
        let raw = r#"{
            "messageId":"m1","role":"assistant","content":"旧回答",
            "createdAt":"2026-01-01T00:00:00Z","source":"desktop","status":"complete"
        }"#;
        let message: MobileChatMessage = serde_json::from_str(raw).expect("旧消息应兼容");
        assert!(message.citations.is_empty());
        assert!(message.innovation_analysis.is_none());
        assert!(message.idea_id.is_none());
        assert!(message.command.is_none());
        assert!(message.paper_context.is_none());
    }

    #[test]
    fn 桌面重启会把遗留流式会话修复为已中断() {
        let mut thread: MobileChatThread = serde_json::from_value(serde_json::json!({
            "threadId": "thread-1",
            "title": "测试会话",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "model": "qwen3:8b",
            "status": "streaming",
            "messages": [{
                "messageId": "message-1",
                "role": "assistant",
                "content": "已经生成的部分回答",
                "createdAt": "2026-01-01T00:00:00Z",
                "source": "desktop",
                "status": "streaming"
            }],
            "lastError": "旧错误"
        }))
        .expect("测试会话应可读取");

        assert!(recover_mobile_chat_thread_after_restart(&mut thread));
        assert_eq!(thread.status, MobileChatThreadStatus::Idle);
        assert_eq!(
            thread.messages[0].status,
            MobileChatMessageStatus::Interrupted
        );
        assert_eq!(thread.messages[0].content, "已经生成的部分回答");
        assert!(thread.last_error.is_none());
    }

    #[test]
    fn 移动资料正文会剥离包含桌面路径的_frontmatter() {
        let markdown =
            "---\ntitle: 示例\npdf_path: E:\\\\论文\\\\示例.pdf\n---\n\n# 示例\n\n正文内容";
        assert_eq!(
            strip_mobile_markdown_frontmatter(markdown),
            "# 示例\n\n正文内容"
        );
        assert_eq!(strip_mobile_markdown_frontmatter("普通正文"), "普通正文");
    }

    #[test]
    fn 引用与创新分析使用移动端驼峰字段持久化() {
        let message = MobileChatMessage {
            message_id: "m2".to_string(),
            role: MobileChatRole::Assistant,
            content: "分析 [A1]".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            source: MobileChatSource::Desktop,
            status: MobileChatMessageStatus::Complete,
            citations: vec![map_mobile_citation("A1", &search_hit("p1", "论文 A"))],
            innovation_analysis: Some(MobileInnovationAnalysis {
                concept_a: "AD".to_string(),
                concept_b: "GNN".to_string(),
                concept_a_expansion: Some("阿尔茨海默病".to_string()),
                concept_b_expansion: Some("图神经网络".to_string()),
                evidence_status: Some("a_only".to_string()),
            }),
            idea_id: Some("idea-1".to_string()),
            command: Some("innovation".to_string()),
            paper_context: None,
        };
        let value = serde_json::to_value(message).expect("消息应可序列化");
        assert_eq!(value["citations"][0]["paperId"], "p1");
        assert_eq!(value["innovationAnalysis"]["conceptB"], "GNN");
        assert_eq!(value["ideaId"], "idea-1");
    }

    #[test]
    fn 引用片段保留正常科研文本并隐藏乱码() {
        assert_eq!(
            sanitize_mobile_evidence_snippet("GNN 分析 Aβ、Tau 与 α-synuclein。", 600),
            "GNN 分析 Aβ、Tau 与 α-synuclein。"
        );
        assert_eq!(
            sanitize_mobile_evidence_snippet("Graph neural network evidence.", 600),
            "Graph neural network evidence."
        );
        assert!(sanitize_mobile_evidence_snippet("PUBLISHED ��September ����", 600).is_empty());
        assert!(sanitize_mobile_evidence_snippet("DOI\0broken", 600).is_empty());
        assert!(sanitize_mobile_evidence_snippet("FranÃ§ois Â dataset", 600).is_empty());
    }

    #[test]
    fn 创新意图预检可提取在对象上使用方法的句式() {
        let intent = heuristic_innovation_intent("能否在 AD 上使用 GNN 分析");
        assert!(intent.detected);
        assert_eq!(intent.concept_a.as_deref(), Some("AD"));
        assert_eq!(intent.concept_b.as_deref(), Some("GNN"));
        assert!(!heuristic_innovation_intent("解释一下 AD").detected);
    }

    #[test]
    fn 工作区标题可识别_ad_与_gnn_别名() {
        assert!(workspace_title_matches_concept(
            "A network diffusion model of disease progression in dementia",
            "AD",
            Some("阿尔茨海默病"),
        ));
        assert!(workspace_title_matches_concept(
            "Self-explainable graph neural network for Alzheimer disease",
            "GNN",
            Some("图神经网络"),
        ));
        assert!(!workspace_title_matches_concept(
            "Causal machine learning for single-cell genomics",
            "AD",
            Some("阿尔茨海默病"),
        ));
    }

    #[test]
    fn 演示论文清单排除重复副本() {
        let settings = DemoLibrarySettings::default();
        assert!(is_demo_visible_path(
            r"C:\workspace\Ali 等 - 2025 - Graph neural networks in alzheimer's disease diagnosis a review of unimodal and multimodal advances.pdf",
            &settings,
        ));
        assert!(!is_demo_visible_path(
            r"C:\workspace\Ali 等 - 2025 - Graph neural networks in Alzheimer's disease diagnosis a review of unimodal and multimodal advances (2).pdf",
            &settings,
        ));
    }

    #[test]
    fn 双路论文选择会排除已选中的论文() {
        let hits = vec![
            search_hit("p1", "共同论文"),
            search_hit("p2", "GNN 方法论文"),
        ];
        let selected = first_relevant_distinct_paper_hit(hits, "GNN", None, Some("p1"))
            .expect("应选择不同论文");
        assert_eq!(selected.paper_id, "p2");
        assert!(first_relevant_distinct_paper_hit(
            vec![search_hit("p1", "共同论文")],
            "GNN",
            None,
            Some("p1")
        )
        .is_none());
    }

    #[test]
    fn pdf来源协议拒绝未知类型和零页码语义() {
        let unknown = r#"{"sourceType":"file","sourceId":"x","page":1}"#;
        assert!(serde_json::from_str::<MobilePdfSource>(unknown).is_err());
        let source: MobilePdfSource =
            serde_json::from_str(r#"{"sourceType":"paper","sourceId":"p1","page":0}"#)
                .expect("协议本身允许读取，路由负责返回明确错误");
        assert_eq!(source.page, 0);
    }

    #[test]
    fn pdf分段请求支持首段开放区间和后缀区间() {
        assert_eq!(parse_pdf_byte_range("bytes=0-99", 1_000).unwrap(), (0, 99));
        assert_eq!(
            parse_pdf_byte_range("bytes=900-", 1_000).unwrap(),
            (900, 999)
        );
        assert_eq!(
            parse_pdf_byte_range("bytes=-100", 1_000).unwrap(),
            (900, 999)
        );
        assert!(parse_pdf_byte_range("bytes=1000-", 1_000).is_err());
        assert!(parse_pdf_byte_range("bytes=0-10,20-30", 1_000).is_err());
    }

    #[test]
    fn 移动pdf阅读页按需渲染并使用视觉阅读流选字() {
        let html = render_mobile_pdf_viewer_html(
            &MobilePdfSource {
                source_type: MobilePdfSourceType::Paper,
                source_id: "论文/特殊编号".to_string(),
                page: 7,
            },
            "token-value",
        );
        assert!(html.contains("/api/mobile/v1/pdf-viewer/pdf-content"));
        assert!(html.contains("disableAutoFetch:true"));
        assert!(html.contains("await go(currentPage)"));
        assert!(!html.contains("for(let i=1;i<=documentRef.numPages"));
        assert!(html.contains("论文/特殊编号"));
        assert!(html.contains("id=\"select\""));
        assert!(html.contains("buildVisualTextMap"));
        assert!(html.contains("renderLinearSelection"));
        assert!(html.contains("selectionContext"));
        assert!(html.contains("text,page,context"));
        assert!(html.contains("selectionHandleStart"));
        assert!(html.contains("跨栏内容请分次选择"));
        assert!(html.contains("dragSelectionHighlight"));
        assert!(!html.contains("buildGeometricSelection"));
        assert!(!html.contains("dragSelectionBox"));
        assert!(!html.contains("margin-top:-2px"));
    }

    #[test]
    fn 局域网地址解析只接受ipv4地址行中的私有地址() {
        let text = r#"
适配器：
   IPv4 地址 . . . . . . . . . . . : 192.168.3.193
   默认网关. . . . . . . . . . . . : 192.168.3.1
其他适配器：
   IPv4 Address. . . . . . . . . . . : 10.20.30.40
   IPv4 Address. . . . . . . . . . . : 100.122.232.78
"#;
        assert_eq!(
            parse_private_lan_ips(text),
            vec!["192.168.3.193".to_string(), "10.20.30.40".to_string()]
        );
    }
}
