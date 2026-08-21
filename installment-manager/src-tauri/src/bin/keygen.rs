//! One-time vendor keypair generator (ARCHITECTURE.md §7).
//!
//! Run this ONCE, ever, for a given release lineage: `cargo run --bin keygen -- <output-dir>`.
//! It writes the private key to `<output-dir>/vendor_private_key.b64` and
//! prints the public key bytes to paste into `licensing::PUBLIC_KEY_BYTES`.
//!
//! Re-running this generates a NEW keypair, which invalidates every
//! license ever issued with the old one (the public key baked into
//! already-shipped app binaries won't match). Only do this deliberately.
//! The private key file must never be committed to the repo — write it
//! somewhere outside the working tree and back it up securely.

use std::env;
use std::fs;
use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::SigningKey;

fn main() {
    let output_dir = env::args()
        .nth(1)
        .map(PathBuf::from)
        .expect("usage: keygen <output-dir>");
    fs::create_dir_all(&output_dir).expect("failed to create output directory");

    let signing_key = SigningKey::generate(&mut rand::rngs::OsRng);
    let private_key_path = output_dir.join("vendor_private_key.b64");
    fs::write(&private_key_path, B64.encode(signing_key.to_bytes())).expect("failed to write private key");

    let public_bytes = signing_key.verifying_key().to_bytes();
    let rust_array = public_bytes
        .iter()
        .map(|b| b.to_string())
        .collect::<Vec<_>>()
        .join(", ");

    println!("Private key written to: {}", private_key_path.display());
    println!("Keep this file outside the repo and back it up — losing it means no future");
    println!("license can ever be issued for apps already built with the matching public key.");
    println!();
    println!("Paste this into src-tauri/src/licensing.rs as PUBLIC_KEY_BYTES:");
    println!("[{rust_array}]");
}
