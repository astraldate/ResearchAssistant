use serde::{Deserialize, Serialize};

pub const OCR_SIDECAR_SCHEMA_VERSION: u32 = 1;
pub const OCR_RAW_CACHE_SCHEMA_VERSION: u32 = 1;
pub const OCR_MODEL_BUNDLE_VERSION: &str = "ppocrv6-small+pp-doclayout-s-v1";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum OcrRegionKind {
    Body,
    Caption,
    Visual,
    Furniture,
    Unknown,
}

impl OcrRegionKind {
    pub fn is_indexable(self) -> bool {
        matches!(self, Self::Body | Self::Caption)
    }

    pub fn allows_cross_region_selection(self) -> bool {
        false
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrPoint {
    pub x: f32,
    pub y: f32,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl OcrRect {
    pub fn right(self) -> f32 {
        self.x + self.width
    }

    pub fn bottom(self) -> f32 {
        self.y + self.height
    }

    pub fn center_x(self) -> f32 {
        self.x + self.width / 2.0
    }

    pub fn center_y(self) -> f32 {
        self.y + self.height / 2.0
    }

    pub fn normalized(self) -> Self {
        Self {
            x: self.x.clamp(0.0, 1.0),
            y: self.y.clamp(0.0, 1.0),
            width: self.width.max(0.0).min(1.0 - self.x.clamp(0.0, 1.0)),
            height: self.height.max(0.0).min(1.0 - self.y.clamp(0.0, 1.0)),
        }
    }

    pub fn contains(self, other: Self, tolerance: f32) -> bool {
        other.x + tolerance >= self.x
            && other.y + tolerance >= self.y
            && other.right() <= self.right() + tolerance
            && other.bottom() <= self.bottom() + tolerance
    }

    pub fn horizontal_overlap_ratio(self, other: Self) -> f32 {
        let intersection = (self.right().min(other.right()) - self.x.max(other.x)).max(0.0);
        let denominator = self.width.min(other.width).max(f32::EPSILON);
        intersection / denominator
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrToken {
    pub token_id: String,
    pub text: String,
    pub bounds: OcrRect,
    pub quad: [OcrPoint; 4],
    pub confidence: f32,
    pub order: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrLine {
    pub line_id: String,
    pub text: String,
    pub bounds: OcrRect,
    pub quad: [OcrPoint; 4],
    pub confidence: f32,
    pub order: u32,
    pub tokens: Vec<OcrToken>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrRegion {
    pub region_id: String,
    pub kind: OcrRegionKind,
    pub label: String,
    pub bounds: OcrRect,
    pub confidence: f32,
    pub order: u32,
    pub column: Option<u32>,
    pub lines: Vec<OcrLine>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrPageLayout {
    pub schema_version: u32,
    pub source_signature: String,
    pub model_version: String,
    pub page: u32,
    pub page_width: f32,
    pub page_height: f32,
    pub rotation: i32,
    pub created_at: String,
    pub regions: Vec<OcrRegion>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrRawPageCache {
    pub schema_version: u32,
    pub source_signature: String,
    pub model_version: String,
    pub page: u32,
    pub payload: serde_json::Value,
}

impl OcrPageLayout {
    pub fn new(
        source_signature: impl Into<String>,
        page: u32,
        page_width: f32,
        page_height: f32,
        rotation: i32,
        created_at: impl Into<String>,
    ) -> Self {
        Self {
            schema_version: OCR_SIDECAR_SCHEMA_VERSION,
            source_signature: source_signature.into(),
            model_version: OCR_MODEL_BUNDLE_VERSION.to_string(),
            page,
            page_width,
            page_height,
            rotation,
            created_at: created_at.into(),
            regions: Vec::new(),
        }
    }

    pub fn indexable_text(&self) -> String {
        self.regions
            .iter()
            .filter(|region| region.kind.is_indexable())
            .flat_map(|region| region.lines.iter())
            .map(|line| line.text.trim())
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn region_context(&self, region_id: &str) -> Option<String> {
        self.regions
            .iter()
            .find(|region| region.region_id == region_id)
            .map(|region| {
                region
                    .lines
                    .iter()
                    .map(|line| line.text.trim())
                    .filter(|line| !line.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
    }

    pub fn normalize_and_validate(&mut self) -> Result<(), String> {
        if self.schema_version != OCR_SIDECAR_SCHEMA_VERSION {
            return Err(format!(
                "不支持的 OCR Sidecar 版本：{}。",
                self.schema_version
            ));
        }
        if self.page == 0 || self.page_width <= 0.0 || self.page_height <= 0.0 {
            return Err("OCR 页面尺寸或页码无效。".to_string());
        }
        let mut seen_regions = std::collections::HashSet::new();
        let mut seen_tokens = std::collections::HashSet::new();
        for region in &mut self.regions {
            if !seen_regions.insert(region.region_id.clone()) {
                return Err(format!("OCR 区域 ID 重复：{}。", region.region_id));
            }
            region.bounds = region.bounds.normalized();
            for line in &mut region.lines {
                line.bounds = line.bounds.normalized();
                for token in &mut line.tokens {
                    token.bounds = token.bounds.normalized();
                    if !seen_tokens.insert(token.token_id.clone()) {
                        return Err(format!("OCR Token ID 重复：{}。", token.token_id));
                    }
                }
            }
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OcrAssetStatus {
    Pending,
    Ready,
    Partial,
    Stale,
    Failed,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrAssetRecord {
    pub asset_id: String,
    pub paper_id: Option<String>,
    pub source_path: String,
    pub source_signature: String,
    pub sidecar_root: String,
    pub model_version: String,
    pub page_count: u32,
    pub covered_pages: Vec<u32>,
    pub status: OcrAssetStatus,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OcrJobStage {
    Download,
    Preflight,
    Layout,
    Detect,
    Recognize,
    Index,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OcrJobStatus {
    Queued,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrFailedPage {
    pub page: u32,
    pub attempts: u32,
    pub error: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrJobRecord {
    pub job_id: String,
    pub asset_id: String,
    pub source_path: String,
    pub source_signature: String,
    pub target_pages: Vec<u32>,
    pub completed_pages: Vec<u32>,
    pub failed_pages: Vec<OcrFailedPage>,
    pub stage: OcrJobStage,
    pub status: OcrJobStatus,
    pub progress: f32,
    pub cancel_requested: bool,
    pub last_error: Option<String>,
    pub started_at: Option<String>,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrProgressEvent {
    pub job_id: String,
    pub asset_id: String,
    pub stage: OcrJobStage,
    pub status: OcrJobStatus,
    pub current_page: Option<u32>,
    pub completed_pages: usize,
    pub total_pages: usize,
    pub failed_pages: usize,
    pub progress: f32,
    pub pages_per_minute: Option<f32>,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OcrPreflightReason {
    NoText,
    GarbledText,
    SuspiciousCoordinates,
    UnreadableText,
    HealthyNativeText,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrPageInspection {
    pub page: u32,
    pub needs_ocr: bool,
    pub reasons: Vec<OcrPreflightReason>,
    pub native_text_preview: String,
    pub native_character_count: usize,
    pub replacement_character_ratio: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrPdfInspection {
    pub source_path: String,
    pub source_signature: String,
    pub page_count: u32,
    pub problem_pages: Vec<u32>,
    pub representative_pages: Vec<u32>,
    pub pages: Vec<OcrPageInspection>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrRuntimeAssetStatus {
    pub asset_id: String,
    pub file_name: String,
    pub purpose: String,
    pub version: String,
    pub expected_size: u64,
    pub installed_size: Option<u64>,
    pub installed: bool,
    pub usable: bool,
    pub license: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrRuntimeStatus {
    pub platform_supported: bool,
    pub ready: bool,
    pub execution_provider: String,
    pub directml_available: bool,
    pub model_bundle_version: String,
    pub assets: Vec<OcrRuntimeAssetStatus>,
    pub last_error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOcrRuntimeRequest {
    #[serde(default)]
    pub asset_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOcrRuntimeAssetsRequest {
    #[serde(default)]
    pub asset_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartPdfOcrRequest {
    pub paper_id: Option<String>,
    pub source_path: String,
    #[serde(default)]
    pub pages: Vec<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InspectPdfOcrRequest {
    pub source_path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReadOcrPageLayoutRequest {
    pub source_path: String,
    pub page: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(id: &str, text: &str) -> OcrToken {
        OcrToken {
            token_id: id.to_string(),
            text: text.to_string(),
            bounds: OcrRect {
                x: 0.1,
                y: 0.1,
                width: 0.1,
                height: 0.03,
            },
            quad: [OcrPoint::default(); 4],
            confidence: 0.95,
            order: 0,
        }
    }

    fn region(id: &str, kind: OcrRegionKind, text: &str) -> OcrRegion {
        OcrRegion {
            region_id: id.to_string(),
            kind,
            label: id.to_string(),
            bounds: OcrRect {
                x: 0.1,
                y: 0.1,
                width: 0.8,
                height: 0.2,
            },
            confidence: 0.9,
            order: 0,
            column: None,
            lines: vec![OcrLine {
                line_id: format!("{id}-line"),
                text: text.to_string(),
                bounds: OcrRect {
                    x: 0.1,
                    y: 0.1,
                    width: 0.8,
                    height: 0.04,
                },
                quad: [OcrPoint::default(); 4],
                confidence: 0.9,
                order: 0,
                tokens: vec![token(&format!("{id}-token"), text)],
            }],
        }
    }

    #[test]
    fn 图表文字不进入索引而图注可以进入() {
        let mut layout = OcrPageLayout::new("sig", 1, 1000.0, 1400.0, 0, "now");
        layout.regions = vec![
            region("body", OcrRegionKind::Body, "正文"),
            region("visual", OcrRegionKind::Visual, "图内文字"),
            region("caption", OcrRegionKind::Caption, "图 1 说明"),
            region("footer", OcrRegionKind::Furniture, "页脚"),
        ];
        assert_eq!(layout.indexable_text(), "正文\n图 1 说明");
        assert_eq!(layout.region_context("visual").as_deref(), Some("图内文字"));
    }

    #[test]
    fn sidecar_拒绝重复_token_id() {
        let mut layout = OcrPageLayout::new("sig", 1, 1000.0, 1400.0, 0, "now");
        let left = region("left", OcrRegionKind::Body, "左栏");
        let mut right = region("right", OcrRegionKind::Body, "右栏");
        right.lines[0].tokens[0].token_id = left.lines[0].tokens[0].token_id.clone();
        layout.regions = vec![left, right];
        assert!(layout.normalize_and_validate().is_err());
    }
}
