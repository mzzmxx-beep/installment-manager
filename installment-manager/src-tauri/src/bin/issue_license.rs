//! Small standalone tool to issue a new signed license for a customer
//! (ARCHITECTURE.md §7). Meant to be copied next to `vendor_private_key.b64`
//! and double-clicked — it finds the key automatically and prompts for the
//! rest.
//!
//! Scripted usage still works for automation:
//!   issue_license <private-key-path> "<customer name>" [--days N]
//! Omit `--days` for a perpetual license. Prints the license string to
//! activate with, and writes it next to the private key as
//! `<customer-name>.license`.

use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::{Duration, Utc};
use ed25519_dalek::SigningKey;
use installment_manager_lib::licensing::{sign_license, LicensePayload};

const KEY_FILENAME: &str = "vendor_private_key.b64";

fn main() {
    enable_utf8_console();

    let args: Vec<String> = env::args().skip(1).collect();
    let result = if args.len() >= 2 {
        run_scripted(&args)
    } else {
        run_interactive()
    };

    if let Err(e) = result {
        eprintln!("خطأ: {e}");
        pause_before_exit();
        std::process::exit(1);
    }
}

fn run_scripted(args: &[String]) -> Result<(), String> {
    let key_path = PathBuf::from(&args[0]);
    let customer_name = args[1].clone();
    let days: Option<i64> = args
        .iter()
        .position(|a| a == "--days")
        .and_then(|i| args.get(i + 1))
        .map(|s| s.parse().map_err(|_| "--days must be an integer".to_string()))
        .transpose()?;

    issue(&key_path, &customer_name, days)
}

fn run_interactive() -> Result<(), String> {
    println!("=== أداة إصدار تراخيص إدارة الأقساط ===");
    println!();

    let key_path = find_or_ask_for_key_path()?;
    println!("مفتاح التوقيع: {}", key_path.display());
    println!();

    let customer_name = loop {
        let name = prompt("اسم الزبون: ")?;
        if !name.trim().is_empty() {
            break name.trim().to_string();
        }
        println!("الاسم مطلوب، حاول مرة أخرى.");
    };

    let days = loop {
        let input = prompt("عدد أيام صلاحية الترخيص (اتركه فارغاً لترخيص دائم): ")?;
        let trimmed = input.trim();
        if trimmed.is_empty() {
            break None;
        }
        match trimmed.parse::<i64>() {
            Ok(n) if n > 0 => break Some(n),
            _ => println!("أدخل رقم صحيح أكبر من صفر، أو اتركه فارغاً."),
        }
    };

    println!();
    issue(&key_path, &customer_name, days)?;
    pause_before_exit();
    Ok(())
}

fn find_or_ask_for_key_path() -> Result<PathBuf, String> {
    if let Ok(exe_path) = env::current_exe() {
        if let Some(dir) = exe_path.parent() {
            let candidate = dir.join(KEY_FILENAME);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    loop {
        let input = prompt(&format!("لم يُعثر على {KEY_FILENAME} بجانب هذا البرنامج. أدخل مسار الملف: "))?;
        let path = PathBuf::from(input.trim());
        if path.exists() {
            return Ok(path);
        }
        println!("الملف غير موجود: {}", path.display());
    }
}

fn issue(key_path: &Path, customer_name: &str, days: Option<i64>) -> Result<(), String> {
    let key_b64 = fs::read_to_string(key_path).map_err(|e| format!("فشل قراءة مفتاح التوقيع {}: {e}", key_path.display()))?;
    let key_bytes = B64.decode(key_b64.trim()).map_err(|_| "ملف المفتاح ليس base64 صالحاً".to_string())?;
    let key_array: [u8; 32] = key_bytes.try_into().map_err(|_| "المفتاح يجب أن يكون 32 بايت".to_string())?;
    let signing_key = SigningKey::from_bytes(&key_array);

    let now = Utc::now();
    let payload = LicensePayload {
        license_id: format!("LIC-{}", hex_random(8)),
        customer_name: customer_name.to_string(),
        issued_at: now.format("%Y-%m-%d").to_string(),
        expires_at: days.map(|d| (now + Duration::days(d)).format("%Y-%m-%d").to_string()),
    };

    let license_string = sign_license(&payload, &signing_key);

    let output_path = key_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{}.license", sanitize_filename(customer_name)));
    fs::write(&output_path, &license_string).map_err(|e| format!("فشل حفظ ملف الترخيص: {e}"))?;

    println!("تم إصدار الترخيص للزبون: {customer_name}");
    println!(
        "تاريخ الانتهاء: {}",
        payload.expires_at.as_deref().unwrap_or("لا يوجد (ترخيص دائم)")
    );
    println!("حُفظ بالملف: {}", output_path.display());
    println!();
    println!("رمز الترخيص (يُلصق بشاشة تفعيل التطبيق):");
    println!("{license_string}");
    Ok(())
}

fn prompt(message: &str) -> Result<String, String> {
    print!("{message}");
    io::stdout().flush().map_err(|e| e.to_string())?;
    let mut input = String::new();
    io::stdin().read_line(&mut input).map_err(|e| e.to_string())?;
    Ok(input)
}

fn pause_before_exit() {
    println!();
    let _ = prompt("اضغط Enter للخروج...");
}

fn hex_random(bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' })
        .collect()
}

/// Switches the console's input/output codepage to UTF-8 so Arabic prompts
/// and customer names display and read back correctly — Windows consoles
/// otherwise default to a legacy ANSI codepage.
#[cfg(windows)]
fn enable_utf8_console() {
    #[link(name = "kernel32")]
    extern "system" {
        fn SetConsoleOutputCP(wCodePageID: u32) -> i32;
        fn SetConsoleCP(wCodePageID: u32) -> i32;
    }
    const CP_UTF8: u32 = 65001;
    unsafe {
        SetConsoleOutputCP(CP_UTF8);
        SetConsoleCP(CP_UTF8);
    }
}

#[cfg(not(windows))]
fn enable_utf8_console() {}
