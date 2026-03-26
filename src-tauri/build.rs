fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let tools_dir = std::path::Path::new(&manifest_dir).join("tools");
    let bundled_protoc = tools_dir.join("protoc.exe");
    let bundled_include = tools_dir.join("include");

    if bundled_protoc.exists() {
        std::env::set_var("PROTOC", bundled_protoc);
    } else if let Ok(path) = protoc_bin_vendored::protoc_bin_path() {
        std::env::set_var("PROTOC", path);
    }

    if bundled_include.exists() {
        std::env::set_var("PROTOC_INCLUDE", bundled_include);
    }

    tauri_build::build()
}
