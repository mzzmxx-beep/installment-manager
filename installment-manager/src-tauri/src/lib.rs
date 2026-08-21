mod audit;
mod commands;
mod db;
mod engine;
pub mod licensing;
mod models;
mod repo;

use db::DbState;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let conn = db::init_db(app)?;
            app.manage(DbState(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::customer::create_customer,
            commands::customer::get_customers,
            commands::license::validate_license,
            commands::license::activate_license,
            commands::product::create_product,
            commands::product::get_active_products,
            commands::sale::create_credit_sale,
            commands::sale::get_sales_for_customer,
            commands::payment::register_payment,
            commands::reporting::get_customer_statement,
            commands::reporting::get_overdue_installments,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
