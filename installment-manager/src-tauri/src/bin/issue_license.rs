//! Vendor tool to issue a new signed license for a customer
//! (ARCHITECTURE.md §7). Run this once per customer, any time:
//!
//!   cargo run --bin issue_license -- <private-key-path> "<customer name>" [--days N]
//!
//! `<private-key-path>` is the `vendor_private_key.b64` file written by
//! `keygen` (kept outside the repo). Omit `--days` for a perpetual license.
//! Prints the license string to activate with, and writes it next to the
//! private key as `<customer-name>.license` for convenience.

use std::env;
use std::fs;
use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::{Duration, Utc};
use ed25519_dalek::SigningKey;
use installment_manager_lib::licensing::{sign_license, LicensePayload};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage: issue_license <private-key-path> \"<customer name>\" [--days N]");
        std::process::exit(1);
    }

    let key_path = PathBuf::from(&args[0]);
    let customer_name = args[1].clone();
    let days: Option<i64> = args
        .iter()
        .position(|a| a == "--days")
        .and_then(|i| args.get(i + 1))
        .map(|s| s.parse().expect("--days must be an integer"));

    let key_b64 = fs::read_to_string(&key_path)
        .unwrap_or_else(|e| panic!("failed to read private key at {}: {e}", key_path.display()));
    let key_bytes = B64.decode(key_b64.trim()).expect("private key file is not valid base64");
    let key_array: [u8; 32] = key_bytes.try_into().expect("private key must be 32 bytes");
    let signing_key = SigningKey::from_bytes(&key_array);

    let now = Utc::now();
    let license_id = format!("LIC-{}", hex_random(8));
    let payload = LicensePayload {
        license_id,
        customer_name: customer_name.clone(),
        issued_at: now.format("%Y-%m-%d").to_string(),
        expires_at: days.map(|d| (now + Duration::days(d)).format("%Y-%m-%d").to_string()),
    };

    let license_string = sign_license(&payload, &signing_key);

    let output_path = key_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join(format!("{}.license", sanitize_filename(&customer_name)));
    fs::write(&output_path, &license_string).expect("failed to write license file");

    println!("License issued for: {customer_name}");
    println!("Expires: {}", payload.expires_at.as_deref().unwrap_or("never (perpetual)"));
    println!("Saved to: {}", output_path.display());
    println!();
    println!("License key (paste into the app's activation screen):");
    println!("{license_string}");
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
