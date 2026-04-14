use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::encyclopedia::TermLookupMode;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CardSettings {
    pub active_root: String,
    pub using_custom_root: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SaveKnowledgeCardRequest {
    pub term: String,
    pub selected_text: String,
    pub plain_summary: String,
    pub source_title: Option<String>,
    pub source_url: Option<String>,
    pub source_provider: Option<String>,
    pub source_lang: Option<String>,
    pub source_extract: Option<String>,
    pub page_context_snippet: Option<String>,
    pub pdf_path: Option<String>,
    pub pdf_page: Option<u32>,
    pub source_status: String,
    pub model: String,
    pub lookup_mode: TermLookupMode,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UpdateKnowledgeCardRequest {
    pub card_path: String,
    pub title: String,
    pub body: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct KnowledgeCardSummary {
    pub id: String,
    pub term: String,
    pub title: String,
    pub path: String,
    pub created_at: String,
    pub pdf_path: Option<String>,
    pub pdf_page: Option<u32>,
    pub source_status: String,
    pub source_provider: Option<String>,
    pub lookup_mode: TermLookupMode,
    pub preview: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct KnowledgeCardDetail {
    pub meta: KnowledgeCardSummary,
    pub markdown: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct StoredCardSettings {
    custom_root: Option<String>,
}

#[derive(Clone, Debug)]
struct ParsedCard {
    meta: KnowledgeCardSummary,
    markdown: String,
}

const SETTINGS_FILE_NAME: &str = "card_settings.json";
const DEFAULT_CARD_FOLDER: &str = "card_library";

pub fn get_card_settings(app: &AppHandle) -> Result<CardSettings, String> {
    let stored = read_stored_settings(app)?;
    let active_root = resolve_active_root_path(app, &stored)?;
    ensure_directory_writable(&active_root)?;
    Ok(CardSettings {
        active_root: active_root.to_string_lossy().to_string(),
        using_custom_root: stored.custom_root.is_some(),
    })
}

pub fn set_card_root_path(app: &AppHandle, path: Option<String>) -> Result<CardSettings, String> {
    let next = path
        .and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .map(PathBuf::from);

    if let Some(root) = &next {
        ensure_directory_writable(root)?;
    }

    let stored = StoredCardSettings {
        custom_root: next
            .as_ref()
            .map(|value| value.to_string_lossy().to_string()),
    };
    write_stored_settings(app, &stored)?;
    get_card_settings(app)
}

pub fn list_knowledge_cards(app: &AppHandle) -> Result<Vec<KnowledgeCardSummary>, String> {
    let settings = get_card_settings(app)?;
    let root = PathBuf::from(&settings.active_root);
    ensure_directory_writable(&root)?;

    let mut cards = Vec::new();
    for entry in WalkDir::new(&root)
        .into_iter()
        .filter_map(|value| value.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let is_markdown = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("md"))
            .unwrap_or(false);
        if !is_markdown {
            continue;
        }

        if let Ok(parsed) = parse_card_file(path) {
            cards.push(parsed.meta);
        }
    }

    cards.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(cards)
}

pub fn read_knowledge_card(card_path: String) -> Result<KnowledgeCardDetail, String> {
    let parsed = parse_card_file(Path::new(&card_path))?;
    Ok(KnowledgeCardDetail {
        meta: parsed.meta,
        markdown: parsed.markdown,
    })
}

pub fn delete_knowledge_card(card_path: String) -> Result<(), String> {
    let path = PathBuf::from(&card_path);
    if !path.exists() {
        return Err(format!("Card file not found: {}", path.display()));
    }
    fs::remove_file(&path).map_err(|e| format!("Failed to delete card: {}", e))?;
    Ok(())
}

pub fn update_knowledge_card(
    request: UpdateKnowledgeCardRequest,
) -> Result<KnowledgeCardDetail, String> {
    let path = PathBuf::from(&request.card_path);
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read card '{}': {}", path.display(), e))?;
    let normalized = raw.replace("\r\n", "\n");
    let (frontmatter, _) = split_frontmatter(&normalized)
        .ok_or_else(|| format!("Card '{}' is missing YAML frontmatter.", path.display()))?;
    let values = parse_frontmatter(frontmatter);
    let updated_markdown = render_updated_card_markdown(&values, &request);
    fs::write(&path, updated_markdown).map_err(|e| format!("Failed to write card file: {}", e))?;
    read_knowledge_card(path.to_string_lossy().to_string())
}

pub fn save_knowledge_card_from_explanation(
    app: &AppHandle,
    request: SaveKnowledgeCardRequest,
) -> Result<KnowledgeCardSummary, String> {
    let settings = get_card_settings(app)?;
    let root = PathBuf::from(&settings.active_root);
    ensure_directory_writable(&root)?;

    let id = Uuid::new_v4().simple().to_string();
    let created_at = current_timestamp_iso_utc();
    let file_tag = current_timestamp_file_tag();
    let slug = slugify(&request.term);
    let file_name = format!("{}-{}-{}.md", file_tag, slug, &id[..8]);
    let path = root.join(file_name);
    let markdown = render_card_markdown(&id, &created_at, &request);

    fs::write(&path, markdown).map_err(|e| format!("Failed to write card file: {}", e))?;

    let parsed = parse_card_file(&path)?;
    Ok(parsed.meta)
}

fn parse_card_file(path: &Path) -> Result<ParsedCard, String> {
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read card '{}': {}", path.display(), e))?;
    let normalized = raw.replace("\r\n", "\n");
    let (frontmatter, body) = split_frontmatter(&normalized)
        .ok_or_else(|| format!("Card '{}' is missing YAML frontmatter.", path.display()))?;
    let values = parse_frontmatter(frontmatter);

    let id = values
        .get("id")
        .cloned()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Card '{}' is missing field 'id'.", path.display()))?;
    let term = values
        .get("term")
        .cloned()
        .unwrap_or_else(|| "未命名术语".to_string());
    let title = values
        .get("title")
        .cloned()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| term.clone());
    let created_at = values
        .get("created_at")
        .cloned()
        .unwrap_or_else(current_timestamp_iso_utc);
    let pdf_path = parse_optional_string(values.get("pdf_path"));
    let pdf_page = values
        .get("pdf_page")
        .and_then(|value| value.trim().parse::<u32>().ok());
    let source_status = values
        .get("source_status")
        .cloned()
        .unwrap_or_else(|| "model_only".to_string());
    let source_provider = parse_optional_string(values.get("source_provider"));
    let lookup_mode = values
        .get("lookup_mode")
        .and_then(|value| parse_lookup_mode(value))
        .unwrap_or_default();
    let preview = extract_section(body, "通俗解释")
        .map(|value| truncate_preview(&value, 140))
        .unwrap_or_default();

    Ok(ParsedCard {
        meta: KnowledgeCardSummary {
            id,
            term,
            title,
            path: path.to_string_lossy().to_string(),
            created_at,
            pdf_path,
            pdf_page,
            source_status,
            source_provider,
            lookup_mode,
            preview,
        },
        markdown: normalized,
    })
}

fn split_frontmatter(content: &str) -> Option<(&str, &str)> {
    if !content.starts_with("---\n") {
        return None;
    }

    let remainder = &content[4..];
    let end = remainder.find("\n---\n")?;
    let frontmatter = &remainder[..end];
    let body = &remainder[end + 5..];
    Some((frontmatter, body))
}

fn parse_frontmatter(frontmatter: &str) -> HashMap<String, String> {
    frontmatter
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                return None;
            }
            let (key, value) = trimmed.split_once(':')?;
            Some((
                key.trim().to_string(),
                parse_frontmatter_value(value.trim()),
            ))
        })
        .collect()
}

fn parse_frontmatter_value(value: &str) -> String {
    if value.eq_ignore_ascii_case("null") {
        return String::new();
    }
    if let Ok(decoded) = serde_json::from_str::<String>(value) {
        return decoded;
    }
    value.trim().to_string()
}

fn parse_optional_string(value: Option<&String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parse_lookup_mode(value: &str) -> Option<TermLookupMode> {
    match value.trim() {
        "popular_cn" => Some(TermLookupMode::PopularCn),
        "cs_encyclopedia" => Some(TermLookupMode::CsEncyclopedia),
        "bioinformatics" => Some(TermLookupMode::Bioinformatics),
        _ => None,
    }
}

fn render_card_markdown(id: &str, created_at: &str, request: &SaveKnowledgeCardRequest) -> String {
    let updated_at = created_at;
    let title = request.term.trim();
    let source_status = request.source_status.trim();
    let lookup_mode = lookup_mode_label(request.lookup_mode);
    let source_extract = request
        .source_extract
        .clone()
        .unwrap_or_else(|| "未检索到外部参考摘要。".to_string());
    let page_context = request
        .page_context_snippet
        .clone()
        .unwrap_or_else(|| "未截取到论文页上下文。".to_string());

    format!(
        "---\nid: {}\nterm: {}\ntitle: {}\ncreated_at: {}\nupdated_at: {}\npdf_path: {}\npdf_page: {}\nselected_text: {}\nsource_status: {}\nsource_title: {}\nsource_url: {}\nsource_provider: {}\nsource_lang: {}\nmodel: {}\nlookup_mode: {}\ntags: []\n---\n\n# {}\n\n## 通俗解释\n{}\n\n## 参考资料摘要\n{}\n\n## 论文上下文\n{}\n\n## 来源\n- 解释模式：{}\n- 来源状态：{}\n- 来源提供方：{}\n- 来源标题：{}\n- 来源链接：{}\n- 模型：{}\n",
        render_yaml_string(id),
        render_yaml_string(title),
        render_yaml_string(title),
        render_yaml_string(created_at),
        render_yaml_string(updated_at),
        render_yaml_option(request.pdf_path.as_deref()),
        render_yaml_option_number(request.pdf_page),
        render_yaml_string(request.selected_text.trim()),
        render_yaml_string(source_status),
        render_yaml_option(request.source_title.as_deref()),
        render_yaml_option(request.source_url.as_deref()),
        render_yaml_option(request.source_provider.as_deref()),
        render_yaml_option(request.source_lang.as_deref()),
        render_yaml_string(request.model.trim()),
        render_yaml_string(lookup_mode),
        title,
        request.plain_summary.trim(),
        source_extract,
        page_context,
        lookup_mode,
        source_status,
        request.source_provider.as_deref().unwrap_or("模型总结 / 无外部资料"),
        request.source_title.as_deref().unwrap_or("未命中"),
        request.source_url.as_deref().unwrap_or("未提供"),
        request.model.trim(),
    )
}

fn render_updated_card_markdown(
    values: &HashMap<String, String>,
    request: &UpdateKnowledgeCardRequest,
) -> String {
    let id = values
        .get("id")
        .cloned()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().simple().to_string());
    let created_at = values
        .get("created_at")
        .cloned()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(current_timestamp_iso_utc);
    let updated_at = current_timestamp_iso_utc();
    let term = request.title.trim();
    let title = if term.is_empty() { "未命名" } else { term };
    let pdf_path = parse_optional_string(values.get("pdf_path"));
    let pdf_page = values
        .get("pdf_page")
        .and_then(|value| value.trim().parse::<u32>().ok());
    let selected_text = values
        .get("selected_text")
        .cloned()
        .unwrap_or_else(|| String::new());
    let source_status = values
        .get("source_status")
        .cloned()
        .unwrap_or_else(|| "model_only".to_string());
    let source_title = parse_optional_string(values.get("source_title"));
    let source_url = parse_optional_string(values.get("source_url"));
    let source_provider = parse_optional_string(values.get("source_provider"));
    let source_lang = parse_optional_string(values.get("source_lang"));
    let model = values
        .get("model")
        .cloned()
        .unwrap_or_else(|| "unknown".to_string());
    let lookup_mode = values
        .get("lookup_mode")
        .cloned()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "popular_cn".to_string());
    let tags = values
        .get("tags")
        .cloned()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "[]".to_string());

    let body = request.body.replace("\r\n", "\n").trim().to_string();
    let body_block = if body.is_empty() {
        format!("# {}", title)
    } else {
        format!("# {}\n\n{}", title, body)
    };

    let tags_line = if tags.trim().starts_with('[') {
        tags.trim().to_string()
    } else {
        render_yaml_string(tags.trim())
    };

    format!(
        "---\nid: {}\nterm: {}\ntitle: {}\ncreated_at: {}\nupdated_at: {}\npdf_path: {}\npdf_page: {}\nselected_text: {}\nsource_status: {}\nsource_title: {}\nsource_url: {}\nsource_provider: {}\nsource_lang: {}\nmodel: {}\nlookup_mode: {}\ntags: {}\n---\n\n{}",
        render_yaml_string(&id),
        render_yaml_string(title),
        render_yaml_string(title),
        render_yaml_string(&created_at),
        render_yaml_string(&updated_at),
        render_yaml_option(pdf_path.as_deref()),
        render_yaml_option_number(pdf_page),
        render_yaml_string(selected_text.trim()),
        render_yaml_string(source_status.trim()),
        render_yaml_option(source_title.as_deref()),
        render_yaml_option(source_url.as_deref()),
        render_yaml_option(source_provider.as_deref()),
        render_yaml_option(source_lang.as_deref()),
        render_yaml_string(model.trim()),
        render_yaml_string(lookup_mode.trim()),
        tags_line,
        body_block
    )
}

fn render_yaml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("\"{}\"", value.replace('"', "\\\"")))
}

fn render_yaml_option(value: Option<&str>) -> String {
    value
        .map(render_yaml_string)
        .unwrap_or_else(|| "null".to_string())
}

fn render_yaml_option_number(value: Option<u32>) -> String {
    value
        .map(|number| number.to_string())
        .unwrap_or_else(|| "null".to_string())
}

fn extract_section(body: &str, heading: &str) -> Option<String> {
    let marker = format!("## {}", heading);
    let start = body.find(&marker)? + marker.len();
    let tail = body[start..].trim_start_matches('\n');
    let end = tail.find("\n## ").unwrap_or(tail.len());
    Some(tail[..end].trim().to_string())
}

fn truncate_preview(input: &str, limit: usize) -> String {
    let chars: Vec<char> = input.chars().collect();
    if chars.len() <= limit {
        return input.to_string();
    }
    chars[..limit].iter().collect::<String>() + "..."
}

fn ensure_directory_writable(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|e| format!("Failed to create directory '{}': {}", path.display(), e))?;
    let probe = path.join(".card_write_test");
    fs::write(&probe, b"ok")
        .map_err(|e| format!("Directory '{}' is not writable: {}", path.display(), e))?;
    let _ = fs::remove_file(probe);
    Ok(())
}

fn settings_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    Ok(app_data_dir.join(SETTINGS_FILE_NAME))
}

fn default_card_root_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    Ok(app_data_dir.join(DEFAULT_CARD_FOLDER))
}

fn read_stored_settings(app: &AppHandle) -> Result<StoredCardSettings, String> {
    let path = settings_file_path(app)?;
    if !path.exists() {
        return Ok(StoredCardSettings::default());
    }

    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str::<StoredCardSettings>(&content).map_err(|e| e.to_string())
}

fn write_stored_settings(app: &AppHandle, settings: &StoredCardSettings) -> Result<(), String> {
    let path = settings_file_path(app)?;
    let content = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())
}

fn resolve_active_root_path(
    app: &AppHandle,
    stored: &StoredCardSettings,
) -> Result<PathBuf, String> {
    match &stored.custom_root {
        Some(path) if !path.trim().is_empty() => Ok(PathBuf::from(path.trim())),
        _ => default_card_root_path(app),
    }
}

fn slugify(term: &str) -> String {
    let raw = term
        .trim()
        .chars()
        .map(|ch| match ch {
            'A'..='Z' => ch.to_ascii_lowercase(),
            'a'..='z' | '0'..='9' => ch,
            ch if ch.is_alphanumeric() => ch,
            _ => '-',
        })
        .collect::<String>();

    let compact = raw
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");

    if compact.is_empty() {
        "term".to_string()
    } else {
        compact
    }
}

fn lookup_mode_label(mode: TermLookupMode) -> &'static str {
    match mode {
        TermLookupMode::PopularCn => "popular_cn",
        TermLookupMode::CsEncyclopedia => "cs_encyclopedia",
        TermLookupMode::Bioinformatics => "bioinformatics",
    }
}

pub fn current_timestamp_iso_utc() -> String {
    let (year, month, day, hour, minute, second) = current_utc_components();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, minute, second
    )
}

fn current_timestamp_file_tag() -> String {
    let (year, month, day, hour, minute, second) = current_utc_components();
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        year, month, day, hour, minute, second
    )
}

fn current_utc_components() -> (i32, u32, u32, u32, u32, u32) {
    let unix_seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    unix_seconds_to_utc(unix_seconds)
}

fn unix_seconds_to_utc(seconds: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = (seconds_of_day / 3_600) as u32;
    let minute = ((seconds_of_day % 3_600) / 60) as u32;
    let second = (seconds_of_day % 60) as u32;
    (year, month, day, hour, minute, second)
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
