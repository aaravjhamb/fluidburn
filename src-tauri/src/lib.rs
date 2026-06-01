mod cam;
mod commands;
mod config;
mod gcode;
mod import;
mod model;
mod serial;

use commands::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            let cfg = config::load(app.handle());
            *app.state::<AppState>().config.lock().unwrap() = cfg;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_ports,
            commands::connect,
            commands::disconnect,
            commands::send_line,
            commands::send_realtime,
            commands::jog,
            commands::start_job,
            commands::pause_job,
            commands::resume_job,
            commands::cancel_job,
            commands::import_file,
            commands::generate_gcode,
            commands::save_gcode,
            commands::boolean_op,
            commands::get_config,
            commands::save_machine,
            commands::delete_machine,
            commands::set_active_machine,
            commands::set_onboarded,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FluidBurn");
}
