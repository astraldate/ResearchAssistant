use super::types::{OcrPoint, OcrRect};

/// 将未旋转裁切区中的像素坐标转换为视觉页面的左上原点归一化坐标。
/// PDF.js 消费结果时只需乘以 viewport 宽高，不应再次应用 PDF `/Rotate`。
pub fn normalize_visual_point(
    x: f32,
    y: f32,
    crop_box: OcrRect,
    rotation: i32,
) -> Result<OcrPoint, String> {
    if crop_box.width <= 0.0 || crop_box.height <= 0.0 {
        return Err("OCR 裁切区域尺寸无效。".to_string());
    }
    let source_x = ((x - crop_box.x) / crop_box.width).clamp(0.0, 1.0);
    let source_y = ((y - crop_box.y) / crop_box.height).clamp(0.0, 1.0);
    let normalized_rotation = rotation.rem_euclid(360);
    let point = match normalized_rotation {
        0 => OcrPoint {
            x: source_x,
            y: source_y,
        },
        90 => OcrPoint {
            x: source_y,
            y: 1.0 - source_x,
        },
        180 => OcrPoint {
            x: 1.0 - source_x,
            y: 1.0 - source_y,
        },
        270 => OcrPoint {
            x: 1.0 - source_y,
            y: source_x,
        },
        _ => return Err("OCR 页面旋转角度必须是 0、90、180 或 270 度。".to_string()),
    };
    Ok(point)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crop_box() -> OcrRect {
        OcrRect {
            x: 100.0,
            y: 200.0,
            width: 1000.0,
            height: 2000.0,
        }
    }

    fn assert_point(rotation: i32, expected_x: f32, expected_y: f32) {
        let point =
            normalize_visual_point(300.0, 700.0, crop_box(), rotation).expect("坐标应可转换");
        assert!((point.x - expected_x).abs() < 0.0001);
        assert!((point.y - expected_y).abs() < 0.0001);
    }

    #[test]
    fn 四种标准旋转都会映射到视觉页面坐标() {
        assert_point(0, 0.2, 0.25);
        assert_point(90, 0.25, 0.8);
        assert_point(180, 0.8, 0.75);
        assert_point(270, 0.75, 0.2);
    }

    #[test]
    fn 裁切区外坐标会被限制在页面范围() {
        let point =
            normalize_visual_point(-50.0, 5000.0, crop_box(), 0).expect("越界坐标应安全归一化");
        assert_eq!(point, OcrPoint { x: 0.0, y: 1.0 });
    }

    #[test]
    fn 非标准旋转角度会被拒绝() {
        assert!(normalize_visual_point(300.0, 700.0, crop_box(), 45).is_err());
    }
}
