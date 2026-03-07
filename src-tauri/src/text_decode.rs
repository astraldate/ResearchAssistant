use encoding_rs::GBK;
use std::fs;
use std::io;
use std::path::Path;

pub fn decode_text_bytes(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).to_string();
    }

    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.trim_start_matches('\u{feff}').to_string();
    }

    let (decoded, _, _) = GBK.decode(bytes);
    decoded.trim_start_matches('\u{feff}').to_string()
}

pub fn read_text_file_auto(path: &Path) -> io::Result<String> {
    let bytes = fs::read(path)?;
    Ok(decode_text_bytes(&bytes))
}

pub fn decode_command_output(bytes: &[u8]) -> String {
    decode_text_bytes(bytes)
}
