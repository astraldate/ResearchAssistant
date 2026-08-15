use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OcrDownloadAsset {
    pub asset_id: &'static str,
    pub file_name: &'static str,
    pub version: &'static str,
    pub purpose: &'static str,
    pub url: &'static str,
    pub expected_size: u64,
    pub license: &'static str,
    pub archive_member: Option<&'static str>,
}

// 资产只允许从清单中的 HTTPS 地址下载；按用户要求不再使用内容哈希门禁。
pub const OCR_DOWNLOAD_MANIFEST: &[OcrDownloadAsset] = &[
    OcrDownloadAsset {
        asset_id: "pdfium-win-x64",
        file_name: "pdfium-win-x64.tgz",
        version: "chromium-7999",
        purpose: "PDFium Windows x64 页面渲染运行库",
        url: "https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F7999/pdfium-win-x64.tgz",
        expected_size: 0,
        license: "BSD-3-Clause（PDFium）/ MIT（分发脚本）",
        archive_member: Some("bin/pdfium.dll"),
    },
    OcrDownloadAsset {
        asset_id: "onnxruntime-win-x64",
        file_name: "onnxruntime-win-x64-1.24.1.zip",
        version: "1.24.1",
        purpose: "ONNX Runtime Windows x64 CPU 运行库",
        url: "https://github.com/microsoft/onnxruntime/releases/download/v1.24.1/onnxruntime-win-x64-1.24.1.zip",
        expected_size: 0,
        license: "MIT",
        archive_member: Some("onnxruntime-win-x64-1.24.1/lib/onnxruntime.dll"),
    },
    OcrDownloadAsset {
        asset_id: "pp-ocrv6-small-det",
        file_name: "pp-ocrv6_small_det.onnx",
        version: "PP-OCRv6-small",
        purpose: "中英文文字检测",
        url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx",
        expected_size: 0,
        license: "Apache-2.0",
        archive_member: None,
    },
    OcrDownloadAsset {
        asset_id: "pp-ocrv6-small-rec",
        file_name: "pp-ocrv6_small_rec.onnx",
        version: "PP-OCRv6-small",
        purpose: "中英文文字识别",
        url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx",
        expected_size: 0,
        license: "Apache-2.0",
        archive_member: None,
    },
    OcrDownloadAsset {
        asset_id: "pp-ocrv6-dict",
        file_name: "ppocrv6_dict.txt",
        version: "PP-OCRv6-small",
        purpose: "PP-OCRv6 small/medium 识别字典",
        url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/master/paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt",
        expected_size: 0,
        license: "Apache-2.0",
        archive_member: None,
    },
    OcrDownloadAsset {
        asset_id: "pp-doclayout-s",
        file_name: "pp-doclayout-s.onnx",
        version: "PP-DocLayout-S",
        purpose: "论文页面版面检测",
        url: "https://github.com/GreatV/oar-ocr/releases/download/v0.3.0/pp-doclayout-s.onnx",
        expected_size: 0,
        license: "Apache-2.0",
        archive_member: None,
    },
];

pub fn downloadable_assets() -> impl Iterator<Item = &'static OcrDownloadAsset> {
    OCR_DOWNLOAD_MANIFEST.iter()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 清单中的全部_https_资产都可以进入下载队列() {
        let assets = downloadable_assets()
            .map(|asset| asset.asset_id)
            .collect::<Vec<_>>();
        assert_eq!(assets.len(), OCR_DOWNLOAD_MANIFEST.len());
        assert!(OCR_DOWNLOAD_MANIFEST
            .iter()
            .all(|asset| asset.url.starts_with("https://")));
    }
}
