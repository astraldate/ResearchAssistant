use axum::{
    body::{Body, Bytes},
    extract::{Path as AxumPath, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::fs;
use std::net::{IpAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::cards::{self, KnowledgeCardDetail};
use crate::chat_queue::{ChatPriority, LlmChatQueueState};
use crate::encyclopedia::TermLookupMode;
use crate::research_memory::{self, ResearchSearchScope};

const MOBILE_API_VERSION: &str = "2026-03-13.v1";
const MOBILE_SERVICE_NAME: &str = "Research Assistant Desktop";
const MOBILE_STATE_FILE_NAME: &str = "mobile_companion.json";
const REVIEW_STATE_DIR_NAME: &str = "review_state";
const REVIEW_STATE_FILE_NAME: &str = "reviews.json";
const MOBILE_INBOX_DIR_NAME: &str = "mobile_inbox";
const MOBILE_INBOX_ASSET_DIR_NAME: &str = "assets";
const MOBILE_CHAT_DIR_NAME: &str = "mobile_chat_threads";
const MOBILE_CHAT_SETTINGS_FILE_NAME: &str = "mobile_chat_settings.json";
const MOBILE_CHAT_DEFAULT_MODEL: &str = "qwen3.5:9b";
const MOBILE_CHAT_HISTORY_LIMIT: usize = 12;
const MOBILE_CHAT_RETRIEVAL_LIMIT: usize = 5;
const MOBILE_CHAT_QUEUE_TIMEOUT_SECS: u64 = 45;
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
    pub pdf_path: Option<String>,
    pub pdf_page: Option<u32>,
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

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileChatMessage {
    pub message_id: String,
    pub role: MobileChatRole,
    pub content: String,
    pub created_at: String,
    pub source: MobileChatSource,
    pub status: MobileChatMessageStatus,
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
    pub use_retrieval: Option<bool>,
    #[serde(default)]
    pub thinking_enabled: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct MobileChatSettings {
    model: String,
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
        .route("/api/mobile/v1/chat/threads", get(axum_list_chat_threads))
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
        .with_state(state)
}

async fn axum_mobile_health(AxumState(state): AxumState<MobileRouterState>) -> impl IntoResponse {
    let running = state
        .mobile_state
        .snapshot()
        .map(|snapshot| snapshot.running)
        .unwrap_or(false);
    Json(MobileHealthResponse {
        api_version: MOBILE_API_VERSION.to_string(),
        service_name: MOBILE_SERVICE_NAME.to_string(),
        running,
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

    let (sender, receiver) = mpsc::channel::<Result<Bytes, Infallible>>(64);
    tauri::async_runtime::spawn(async move {
        run_mobile_chat_stream_task(state, thread_id, payload, sender).await;
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
    if let Some(ip) = infer_lan_ip() {
        push_unique_url(&mut urls, ip, port);
    }
    push_unique_url(&mut urls, "127.0.0.1".to_string(), port);
    urls
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
        review_records: sorted_review_records(
            read_review_state(app)?.records.into_values().collect(),
        ),
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
    MobileCardRecord {
        id: detail.meta.id,
        term: detail.meta.term,
        title: detail.meta.title,
        created_at: detail.meta.created_at,
        preview: detail.meta.preview,
        markdown: detail.markdown,
        source_provider: detail.meta.source_provider,
        source_status: detail.meta.source_status,
        lookup_mode: lookup_mode_key(detail.meta.lookup_mode).to_string(),
        pdf_path: detail.meta.pdf_path,
        pdf_page: detail.meta.pdf_page,
    }
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

    for event in payload.events {
        if event.event_id.trim().is_empty() || event.card_id.trim().is_empty() {
            continue;
        }
        if !store.applied_event_ids.insert(event.event_id.clone()) {
            accepted_event_ids.push(event.event_id.clone());
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
    let settings = MobileChatSettings {
        model: if normalized.is_empty() {
            MOBILE_CHAT_DEFAULT_MODEL.to_string()
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
    });
    thread.messages.push(MobileChatMessage {
        message_id: Uuid::new_v4().simple().to_string(),
        role: MobileChatRole::Assistant,
        content: assistant_content.trim().to_string(),
        created_at: now.clone(),
        source: MobileChatSource::Desktop,
        status: MobileChatMessageStatus::Complete,
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
) {
    let result = run_mobile_chat_stream_task_inner(&state, thread_id, payload, &sender).await;
    if let Err(error) = result {
        let _ = send_ndjson(&sender, json!({ "type": "error", "error": error })).await;
    }
}

async fn run_mobile_chat_stream_task_inner(
    state: &MobileRouterState,
    thread_id: Option<String>,
    payload: MobileChatSendRequest,
    sender: &mpsc::Sender<Result<Bytes, Infallible>>,
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

    let use_retrieval = payload.use_retrieval.unwrap_or(is_new_thread);
    let user_message = MobileChatMessage {
        message_id: Uuid::new_v4().simple().to_string(),
        role: MobileChatRole::User,
        content: payload.message.trim().to_string(),
        created_at: now.clone(),
        source: MobileChatSource::Mobile,
        status: MobileChatMessageStatus::Complete,
    };
    let assistant_id = Uuid::new_v4().simple().to_string();
    let assistant_message = MobileChatMessage {
        message_id: assistant_id.clone(),
        role: MobileChatRole::Assistant,
        content: String::new(),
        created_at: now.clone(),
        source: MobileChatSource::Desktop,
        status: MobileChatMessageStatus::Streaming,
    };

    let previous_messages = thread.messages.clone();
    thread.messages.push(user_message.clone());
    thread.messages.push(assistant_message);
    thread.status = MobileChatThreadStatus::Streaming;
    thread.updated_at = now;
    thread.last_error = None;
    write_mobile_chat_thread(&state.app, &thread)?;
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

    let context = if use_retrieval {
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
        build_mobile_chat_retrieval_context(&state.app, &user_message.content)
            .await
            .unwrap_or_default()
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
    let Some(permit) = state
        .chat_queue
        .acquire_timeout(
            ChatPriority::Mobile,
            tokio::time::Duration::from_secs(MOBILE_CHAT_QUEUE_TIMEOUT_SECS),
        )
        .await
    else {
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
    let messages =
        build_mobile_chat_llm_messages(&previous_messages, &user_message.content, &context);
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
    )
    .await;
    permit.release().await;

    match stream_result {
        Ok(answer) => {
            update_mobile_thread_assistant(
                &state.app,
                &thread.thread_id,
                &assistant_id,
                answer,
                MobileChatMessageStatus::Complete,
                None,
            )?;
            send_ndjson(sender, json!({ "type": "done" })).await?;
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
) -> Result<String, String> {
    let docs = research_memory::query_knowledge_base(
        app,
        query,
        MOBILE_CHAT_RETRIEVAL_LIMIT,
        None,
        ResearchSearchScope::default(),
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(docs
        .into_iter()
        .map(|doc| doc.content)
        .collect::<Vec<_>>()
        .join("\n\n"))
}

fn build_mobile_chat_llm_messages(
    previous_messages: &[MobileChatMessage],
    current_user_message: &str,
    retrieval_context: &str,
) -> Vec<serde_json::Value> {
    let mut messages = vec![json!({
        "role": "system",
        "content": "你是科研助手。除非用户明确要求其他语言，否则使用中文 Markdown 回答。优先利用给定知识库上下文；没有上下文时基于已有对话和通用知识回答，并明确区分证据与推断。"
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

async fn stream_ollama_mobile_chat(
    app: &AppHandle,
    thread_id: &str,
    assistant_id: &str,
    model: &str,
    messages: Vec<serde_json::Value>,
    think_enabled: bool,
    sender: &mpsc::Sender<Result<Bytes, Infallible>>,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client
        .post("http://localhost:11434/api/chat")
        .json(&json!({
            "model": model,
            "messages": messages,
            "think": think_enabled,
            "stream": true
        }))
        .send()
        .await
        .map_err(|error| format!("Failed to connect to LLM: {}", error))?;
    if !response.status().is_success() {
        return Err(format!("LLM API error: {}", response.status()));
    }

    let mut answer = String::new();
    let mut reasoning = String::new();
    let mut buffer = String::new();
    let mut bytes_stream = response.bytes_stream();
    while let Some(chunk) = bytes_stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(newline_index) = buffer.find('\n') {
            let line = buffer[..newline_index].trim().to_string();
            buffer.drain(..=newline_index);
            if line.is_empty() {
                continue;
            }
            process_ollama_mobile_line(
                app,
                thread_id,
                assistant_id,
                &line,
                &mut answer,
                &mut reasoning,
                sender,
            )
            .await?;
        }
    }
    if !buffer.trim().is_empty() {
        process_ollama_mobile_line(
            app,
            thread_id,
            assistant_id,
            buffer.trim(),
            &mut answer,
            &mut reasoning,
            sender,
        )
        .await?;
    }
    if answer.trim().is_empty() && reasoning.trim().is_empty() {
        Err("LLM response did not include content".to_string())
    } else if answer.trim().is_empty() {
        Ok(format!("<think>\n{}\n</think>", reasoning.trim()))
    } else if reasoning.trim().is_empty() {
        Ok(answer)
    } else {
        Ok(format!(
            "<think>\n{}\n</think>\n\n{}",
            reasoning.trim(),
            answer
        ))
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
        // The phone may drop a long-lived HTTP stream while the desktop model keeps
        // generating. Treat that as a best-effort push failure so the final answer
        // is still persisted into the mobile conversation.
    }
    Ok(())
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
    thread.status = if last_error.is_some() {
        MobileChatThreadStatus::Error
    } else {
        MobileChatThreadStatus::Idle
    };
    thread.updated_at = cards::current_timestamp_iso_utc();
    thread.last_error = last_error;
    write_mobile_chat_thread(app, &thread)?;
    emit_mobile_thread_update(app, &thread);
    Ok(())
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

fn read_mobile_chat_settings(app: &AppHandle) -> Result<MobileChatSettings, String> {
    let path = mobile_chat_settings_file(app)?;
    if !path.exists() {
        return Ok(MobileChatSettings {
            model: MOBILE_CHAT_DEFAULT_MODEL.to_string(),
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
