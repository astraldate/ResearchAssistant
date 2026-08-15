use super::types::{OcrRect, OcrRegion, OcrRegionKind};
use std::cmp::Ordering;

const WIDE_REGION_THRESHOLD: f32 = 0.72;
const TOP_FURNITURE_THRESHOLD: f32 = 0.075;
const BOTTOM_FURNITURE_THRESHOLD: f32 = 0.93;

pub fn classify_layout_label(label: &str, bounds: OcrRect, confidence: f32) -> OcrRegionKind {
    let normalized = label.trim().to_ascii_lowercase().replace(['-', ' '], "_");
    if confidence < 0.35 {
        return OcrRegionKind::Unknown;
    }
    if bounds.y <= TOP_FURNITURE_THRESHOLD || bounds.bottom() >= BOTTOM_FURNITURE_THRESHOLD {
        if matches!(
            normalized.as_str(),
            "header" | "footer" | "page_number" | "footnote"
        ) {
            return OcrRegionKind::Furniture;
        }
    }
    match normalized.as_str() {
        "image" | "figure" | "chart" | "table" | "formula" | "seal" | "algorithm" => {
            OcrRegionKind::Visual
        }
        "figure_caption" | "table_caption" | "figure_table_title" | "figure_title"
        | "table_title" | "caption" => OcrRegionKind::Caption,
        "header" | "footer" | "page_number" | "number" | "footnote" | "sidebar_text"
        | "aside_text" => OcrRegionKind::Furniture,
        "text" | "paragraph" | "abstract" | "reference" | "references" | "list"
        | "document_title" | "doc_title" | "paragraph_title" | "title" | "content"
        | "reference_content" => OcrRegionKind::Body,
        _ => OcrRegionKind::Unknown,
    }
}

pub fn assign_reading_order(regions: &mut [OcrRegion]) {
    if regions.is_empty() {
        return;
    }

    let mut body_center_samples = regions
        .iter()
        .filter(|region| matches!(region.kind, OcrRegionKind::Body | OcrRegionKind::Caption))
        .filter(|region| region.bounds.width < WIDE_REGION_THRESHOLD)
        .map(|region| region.bounds.center_x())
        .collect::<Vec<_>>();
    body_center_samples.sort_by(|left, right| left.total_cmp(right));

    let split = detect_column_split(&body_center_samples).unwrap_or(0.5);
    for region in regions.iter_mut() {
        region.column = if matches!(region.kind, OcrRegionKind::Furniture) {
            None
        } else if is_spanning_lead_region(region) {
            Some(0)
        } else if region.bounds.center_x() < split {
            Some(1)
        } else {
            Some(2)
        };
    }

    let spanning_positions = regions
        .iter()
        .filter(|region| is_spanning_lead_region(region))
        .map(|region| region.bounds.center_y())
        .collect::<Vec<_>>();
    regions.sort_by(|left, right| compare_region_order(left, right, &spanning_positions));
    deduplicate_overlapping_lines(regions);
    for (index, region) in regions.iter_mut().enumerate() {
        region.order = index as u32;
        region.lines.sort_by(|left, right| {
            left.bounds
                .center_y()
                .total_cmp(&right.bounds.center_y())
                .then_with(|| left.bounds.x.total_cmp(&right.bounds.x))
        });
        for (line_index, line) in region.lines.iter_mut().enumerate() {
            line.order = line_index as u32;
            line.tokens.sort_by(|left, right| {
                left.bounds
                    .x
                    .total_cmp(&right.bounds.x)
                    .then_with(|| left.bounds.y.total_cmp(&right.bounds.y))
            });
            for (token_index, token) in line.tokens.iter_mut().enumerate() {
                token.order = token_index as u32;
            }
        }
    }
}

fn is_spanning_lead_region(region: &OcrRegion) -> bool {
    if region.bounds.width < WIDE_REGION_THRESHOLD || region.kind != OcrRegionKind::Body {
        return false;
    }
    matches!(
        region
            .label
            .trim()
            .to_ascii_lowercase()
            .replace(['-', ' '], "_")
            .as_str(),
        "document_title" | "doc_title" | "title" | "paragraph_title" | "abstract"
    )
}

fn detect_column_split(centers: &[f32]) -> Option<f32> {
    if centers.len() < 2 {
        return None;
    }
    let mut largest_gap = 0.0f32;
    let mut split = None;
    for pair in centers.windows(2) {
        let gap = pair[1] - pair[0];
        if gap > largest_gap && gap >= 0.16 {
            largest_gap = gap;
            split = Some((pair[0] + pair[1]) / 2.0);
        }
    }
    split
}

fn compare_region_order(
    left: &OcrRegion,
    right: &OcrRegion,
    spanning_positions: &[f32],
) -> Ordering {
    let left_column = left.column.unwrap_or(3);
    let right_column = right.column.unwrap_or(3);

    let left_band = vertical_band(left, spanning_positions);
    let right_band = vertical_band(right, spanning_positions);
    left_band
        .cmp(&right_band)
        .then_with(|| {
            let left_group = if left_column == 0 { 3 } else { left_column };
            let right_group = if right_column == 0 { 3 } else { right_column };
            left_group.cmp(&right_group)
        })
        .then_with(|| left.bounds.y.total_cmp(&right.bounds.y))
        .then_with(|| left.bounds.x.total_cmp(&right.bounds.x))
}

fn vertical_band(region: &OcrRegion, spanning_positions: &[f32]) -> usize {
    let center_y = region.bounds.center_y();
    if is_spanning_lead_region(region) {
        spanning_positions
            .iter()
            .filter(|position| **position < center_y)
            .count()
    } else {
        spanning_positions
            .iter()
            .filter(|position| **position <= center_y)
            .count()
    }
}

fn deduplicate_overlapping_lines(regions: &mut [OcrRegion]) {
    let mut accepted: Vec<(String, OcrRect)> = Vec::new();
    for region in regions {
        region.lines.retain(|line| {
            let normalized = line.text.split_whitespace().collect::<String>();
            if normalized.is_empty() {
                return false;
            }
            let duplicate = accepted.iter().any(|(text, bounds)| {
                *text == normalized && overlap_ratio(*bounds, line.bounds) >= 0.8
            });
            if !duplicate {
                accepted.push((normalized, line.bounds));
            }
            !duplicate
        });
    }
}

fn overlap_ratio(left: OcrRect, right: OcrRect) -> f32 {
    let width = (left.right().min(right.right()) - left.x.max(right.x)).max(0.0);
    let height = (left.bottom().min(right.bottom()) - left.y.max(right.y)).max(0.0);
    let smaller_area = (left.width * left.height)
        .min(right.width * right.height)
        .max(f32::EPSILON);
    width * height / smaller_area
}

#[cfg(test)]
mod tests {
    use super::*;

    fn region(id: &str, x: f32, y: f32, width: f32) -> OcrRegion {
        OcrRegion {
            region_id: id.to_string(),
            kind: OcrRegionKind::Body,
            label: "text".to_string(),
            bounds: OcrRect {
                x,
                y,
                width,
                height: 0.1,
            },
            confidence: 0.9,
            order: 0,
            column: None,
            lines: Vec::new(),
        }
    }

    #[test]
    fn 双栏阅读顺序不会左右逐行交错() {
        let mut regions = vec![
            region("right-top", 0.55, 0.2, 0.36),
            region("left-bottom", 0.08, 0.5, 0.36),
            region("left-top", 0.08, 0.2, 0.36),
            region("right-bottom", 0.55, 0.5, 0.36),
        ];
        assign_reading_order(&mut regions);
        assert_eq!(
            regions
                .iter()
                .map(|region| region.region_id.as_str())
                .collect::<Vec<_>>(),
            vec!["left-top", "left-bottom", "right-top", "right-bottom"]
        );
    }

    #[test]
    fn 跨栏标题排在双栏正文之前() {
        let mut regions = vec![
            region("left", 0.08, 0.2, 0.36),
            region("title", 0.08, 0.08, 0.84),
            region("right", 0.55, 0.2, 0.36),
        ];
        regions[1].label = "document_title".to_string();
        assign_reading_order(&mut regions);
        assert_eq!(regions[0].region_id, "title");
    }

    #[test]
    fn 页中跨栏标题不会被提前到整页开头() {
        let mut regions = vec![
            region("left-before", 0.08, 0.2, 0.36),
            region("middle-title", 0.08, 0.48, 0.84),
            region("left-after", 0.08, 0.65, 0.36),
        ];
        regions[1].label = "paragraph_title".to_string();
        assign_reading_order(&mut regions);
        assert_eq!(
            regions
                .iter()
                .map(|region| region.region_id.as_str())
                .collect::<Vec<_>>(),
            vec!["left-before", "middle-title", "left-after"]
        );
    }

    #[test]
    fn 实际版面模型标签会映射到受控类型() {
        let bounds = OcrRect {
            x: 0.1,
            y: 0.3,
            width: 0.8,
            height: 0.1,
        };
        assert_eq!(
            classify_layout_label("reference_content", bounds, 0.9),
            OcrRegionKind::Body
        );
        assert_eq!(
            classify_layout_label("figure_title", bounds, 0.9),
            OcrRegionKind::Caption
        );
        assert_eq!(
            classify_layout_label("number", bounds, 0.9),
            OcrRegionKind::Furniture
        );
    }

    #[test]
    fn 图表与家具分类保持隔离() {
        assert_eq!(
            classify_layout_label(
                "table",
                OcrRect {
                    x: 0.1,
                    y: 0.3,
                    width: 0.8,
                    height: 0.3,
                },
                0.9
            ),
            OcrRegionKind::Visual
        );
        assert_eq!(
            classify_layout_label(
                "figure_table_title",
                OcrRect {
                    x: 0.1,
                    y: 0.65,
                    width: 0.8,
                    height: 0.05,
                },
                0.9
            ),
            OcrRegionKind::Caption
        );
        assert_eq!(
            classify_layout_label(
                "header",
                OcrRect {
                    x: 0.1,
                    y: 0.01,
                    width: 0.8,
                    height: 0.03,
                },
                0.9
            ),
            OcrRegionKind::Furniture
        );
    }
}
