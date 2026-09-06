#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(path, content).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_text_files(folder: String, files: Vec<(String, String)>) -> Result<usize, String> {
    let folder_path = std::path::PathBuf::from(folder);
    if !folder_path.is_dir() {
        return Err("ไม่พบโฟลเดอร์ที่เลือก".to_string());
    }

    for (filename, content) in &files {
        let safe_filename = std::path::Path::new(filename)
            .file_name()
            .ok_or_else(|| "ชื่อไฟล์ไม่ถูกต้อง".to_string())?;
        let mut destination = folder_path.join(safe_filename);
        if destination.exists() {
            let source_path = std::path::Path::new(safe_filename);
            let stem = source_path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy();
            let extension = source_path
                .extension()
                .map(|value| value.to_string_lossy())
                .unwrap_or_default();
            let mut copy_number = 2;

            while destination.exists() {
                let next_filename = if extension.is_empty() {
                    format!("{stem} ({copy_number})")
                } else {
                    format!("{stem} ({copy_number}).{extension}")
                };
                destination = folder_path.join(next_filename);
                copy_number += 1;
            }
        }

        std::fs::write(destination, content).map_err(|error| error.to_string())?;
    }

    Ok(files.len())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri_plugin_window_state::StateFlags;

    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::MAXIMIZED)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![write_text_file, write_text_files])
        .run(tauri::generate_context!())
        .expect("error while running CloudPad");
}
