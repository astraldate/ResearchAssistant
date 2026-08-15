use super::types::{
    OcrPageInspection, OcrPdfInspection, OcrPreflightReason, OCR_MODEL_BUNDLE_VERSION,
};
use lopdf::Document;
use std::path::Path;

pub fn inspect_pdf(
    source_path: &Path,
    source_signature: String,
) -> Result<OcrPdfInspection, String> {
    let document = Document::load(source_path).map_err(|error| error.to_string())?;
    let page_count = document.get_pages().len() as u32;
    let mut pages = Vec::with_capacity(page_count as usize);
    let mut problem_pages = Vec::new();

    for page in 1..=page_count {
        // 同一份文档只加载一次，避免长 PDF 在逐页预检时反复解析整个文件。
        let inspection = match document.extract_text(&[page]) {
            Ok(text) => inspect_native_text(page, &text),
            Err(_) => OcrPageInspection {
                page,
                needs_ocr: true,
                reasons: vec![OcrPreflightReason::UnreadableText],
                native_text_preview: String::new(),
                native_character_count: 0,
                replacement_character_ratio: 1.0,
            },
        };
        if inspection.needs_ocr {
            problem_pages.push(page);
        }
        pages.push(inspection);
    }

    let representative_pages = representative_problem_pages(&problem_pages, page_count, 3);
    Ok(OcrPdfInspection {
        source_path: source_path.to_string_lossy().to_string(),
        source_signature,
        page_count,
        problem_pages,
        representative_pages,
        pages,
    })
}

pub fn inspect_native_text(page: u32, text: &str) -> OcrPageInspection {
    let normalized = text.replace('\0', " ");
    let characters = normalized.chars().collect::<Vec<_>>();
    let character_count = characters.len();
    let replacement_count = characters
        .iter()
        .filter(|character| **character == '\u{fffd}')
        .count();
    let replacement_ratio = if character_count == 0 {
        0.0
    } else {
        replacement_count as f32 / character_count as f32
    };
    let readable_count = characters
        .iter()
        .filter(|character| is_readable_text_character(**character))
        .count();
    let readable_ratio = if character_count == 0 {
        0.0
    } else {
        readable_count as f32 / character_count as f32
    };
    let line_count = normalized
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    let longest_line = normalized
        .lines()
        .map(|line| line.chars().count())
        .max()
        .unwrap_or(0);

    let mut reasons = Vec::new();
    if normalized.trim().is_empty() {
        reasons.push(OcrPreflightReason::NoText);
    }
    if replacement_ratio >= 0.02 || contains_mojibake(&normalized) {
        reasons.push(OcrPreflightReason::GarbledText);
    }
    if character_count >= 80 && readable_ratio < 0.55 {
        reasons.push(OcrPreflightReason::UnreadableText);
    }
    // 大段文字却仅形成一两条超长行，通常意味着坐标或 ToUnicode 提取异常。
    if character_count >= 600 && line_count <= 2 && longest_line >= 400 {
        reasons.push(OcrPreflightReason::SuspiciousCoordinates);
    }
    if reasons.is_empty() {
        reasons.push(OcrPreflightReason::HealthyNativeText);
    }
    let needs_ocr = reasons
        .iter()
        .any(|reason| *reason != OcrPreflightReason::HealthyNativeText);

    OcrPageInspection {
        page,
        needs_ocr,
        reasons,
        native_text_preview: truncate_preview(&normalized, 240),
        native_character_count: character_count,
        replacement_character_ratio: replacement_ratio,
    }
}

pub fn representative_problem_pages(
    problem_pages: &[u32],
    page_count: u32,
    limit: usize,
) -> Vec<u32> {
    if limit == 0 || page_count == 0 {
        return Vec::new();
    }
    if problem_pages.is_empty() {
        return vec![1];
    }
    if problem_pages.len() <= limit {
        return problem_pages.to_vec();
    }
    if limit == 1 {
        return vec![problem_pages[problem_pages.len() / 2]];
    }
    let mut result = Vec::new();
    for index in 0..limit {
        let position = index * (problem_pages.len() - 1) / (limit - 1);
        let page = problem_pages[position];
        if !result.contains(&page) {
            result.push(page);
        }
    }
    result
}

fn is_readable_text_character(character: char) -> bool {
    character.is_alphanumeric()
        || character.is_whitespace()
        || matches!(
            character,
            '.' | ','
                | ':'
                | ';'
                | '-'
                | '_'
                | '/'
                | '\\'
                | '('
                | ')'
                | '['
                | ']'
                | '{'
                | '}'
                | '，'
                | '。'
                | '：'
                | '；'
                | '、'
                | '（'
                | '）'
                | 'α'
                | 'β'
                | 'γ'
                | 'δ'
                | 'θ'
                | 'λ'
                | 'μ'
                | 'π'
                | 'σ'
                | 'τ'
        )
}

fn contains_mojibake(text: &str) -> bool {
    let lowered = text.to_ascii_lowercase();
    text.contains("ï¿½")
        || text.contains("â€")
        || text.contains('Ã')
        || text.contains('Â')
        || lowered.contains("to unicode cmap")
}

fn truncate_preview(text: &str, limit: usize) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut preview = normalized.chars().take(limit).collect::<String>();
    if normalized.chars().count() > limit {
        preview.push('…');
    }
    preview
}

pub fn preflight_version() -> &'static str {
    OCR_MODEL_BUNDLE_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 正常科研文本不会被误判为乱码() {
        let inspection = inspect_native_text(
            1,
            "GNN 分析 Aβ、Tau、α-synuclein 与 MRI 表征。\n第二行正文。",
        );
        assert!(!inspection.needs_ocr);
        assert_eq!(
            inspection.reasons,
            vec![OcrPreflightReason::HealthyNativeText]
        );
    }

    #[test]
    fn 替换字符和典型乱码会触发_o_c_r() {
        let inspection = inspect_native_text(1, "PUBLISHED ��September ���� FranÃ§ois");
        assert!(inspection.needs_ocr);
        assert!(inspection
            .reasons
            .contains(&OcrPreflightReason::GarbledText));
    }

    #[test]
    fn 代表页最多三张并覆盖首中尾() {
        assert_eq!(
            representative_problem_pages(&[1, 2, 3, 8, 9, 10], 10, 3),
            vec![1, 3, 10]
        );
    }
}
