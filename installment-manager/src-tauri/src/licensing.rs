//! Offline licensing core (ARCHITECTURE.md §7): asymmetric signature
//! verification, machine (HWID) binding, and anti-clock-rollback timestamp
//! encryption. No network calls anywhere in this module.
//!
//! The vendor's private signing key never appears in this file or ships
//! with the app — only the public key does, embedded below. Licenses are
//! generated offline by the `issue_license` bin using a private key kept
//! outside the repo entirely (see `vendor-tools/src/bin/issue_license.rs`
//! — a separate Cargo package from src-tauri on purpose, so `tauri build`
//! never sees it as an extra binary target to potentially bundle by mistake).

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::process::Command;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The vendor's Ed25519 public key, generated once offline by
/// `src-tauri/src/bin/keygen.rs`. Safe to embed and commit — verifying a
/// signature only requires the public half.
pub const PUBLIC_KEY_BYTES: [u8; 32] = [
    206, 88, 187, 1, 76, 183, 1, 64, 144, 255, 104, 186, 225, 124, 27, 253, 110, 106, 68, 207, 74, 183, 153, 9, 160,
    11, 82, 231, 215, 45, 80, 108,
];

/// The signed payload of a license. Field order is the canonical
/// serialization signed over — do not reorder fields on an already-issued
/// license format without a version bump.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LicensePayload {
    pub license_id: String,
    pub customer_name: String,
    pub issued_at: String,
    /// ISO date (`YYYY-MM-DD`); `None` means a perpetual, non-expiring license.
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LicenseError {
    Malformed,
    InvalidSignature,
}

/// Signs `payload` with the vendor's private key, producing the string
/// customers activate with: `base64(payload json).base64(signature)`.
pub fn sign_license(payload: &LicensePayload, signing_key: &SigningKey) -> String {
    let payload_json = serde_json::to_vec(payload).expect("LicensePayload always serializes");
    let signature = signing_key.sign(&payload_json);
    format!("{}.{}", B64.encode(&payload_json), B64.encode(signature.to_bytes()))
}

/// Verifies a license string against the embedded public key and, if
/// valid, returns its payload. Re-parses and re-verifies from the raw
/// string every time rather than trusting any separately-stored fields, so
/// tampering with individually stored columns can't forge a license.
pub fn verify_license(raw: &str) -> Result<LicensePayload, LicenseError> {
    let (payload_b64, sig_b64) = raw.split_once('.').ok_or(LicenseError::Malformed)?;
    let payload_bytes = B64.decode(payload_b64).map_err(|_| LicenseError::Malformed)?;
    let sig_bytes = B64.decode(sig_b64).map_err(|_| LicenseError::Malformed)?;
    let sig_array: [u8; 64] = sig_bytes.try_into().map_err(|_| LicenseError::Malformed)?;
    let signature = Signature::from_bytes(&sig_array);
    let verifying_key = VerifyingKey::from_bytes(&PUBLIC_KEY_BYTES).map_err(|_| LicenseError::Malformed)?;
    verifying_key
        .verify(&payload_bytes, &signature)
        .map_err(|_| LicenseError::InvalidSignature)?;
    serde_json::from_slice(&payload_bytes).map_err(|_| LicenseError::Malformed)
}

fn run_powershell(command: &str) -> Option<String> {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", command]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Computes a stable per-machine identifier from CPU + motherboard + the
/// Windows machine GUID (ARCHITECTURE.md §7), hashed together with SHA-256.
/// All three signals are queried in a single PowerShell invocation to keep
/// startup overhead down. Any signal that comes back blank (common for
/// motherboard serials on many real boards) simply contributes less
/// entropy rather than failing the whole computation — the machine GUID
/// alone is normally enough to keep this stable and unique per machine.
pub fn compute_hwid() -> String {
    let combined = run_powershell(
        "$cpu = (Get-CimInstance Win32_Processor).ProcessorId; \
         $board = (Get-CimInstance Win32_BaseBoard).SerialNumber; \
         $guid = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid; \
         \"$cpu|$board|$guid\"",
    )
    .unwrap_or_default();

    let mut hasher = Sha256::new();
    hasher.update(combined.as_bytes());
    hex_encode(&hasher.finalize())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

const TIMESTAMP_CIPHER_CONTEXT: &[u8] = b"installment-manager-v1-anti-rollback";

fn derive_timestamp_key(hwid: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(TIMESTAMP_CIPHER_CONTEXT);
    hasher.update(hwid.as_bytes());
    hasher.finalize().into()
}

/// Encrypts a unix timestamp for tamper-resistant storage in SQLite,
/// bound to `hwid` so the ciphertext isn't portable to another machine.
/// This deters casual edits (a text/hex editor won't get you anywhere);
/// it isn't meant to withstand a determined reverse-engineer with access
/// to the binary — matching the offline, no-network threat model this
/// feature targets (ARCHITECTURE.md §7).
pub fn encrypt_timestamp(unix_seconds: i64, hwid: &str) -> Vec<u8> {
    let key = derive_timestamp_key(hwid);
    let cipher = Aes256Gcm::new((&key).into());
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, unix_seconds.to_be_bytes().as_ref())
        .expect("AES-GCM encryption of an 8-byte block does not fail");

    let mut out = nonce_bytes.to_vec();
    out.extend_from_slice(&ciphertext);
    out
}

/// Decrypts a blob produced by `encrypt_timestamp`. Returns `None` if the
/// blob is malformed or was encrypted for a different HWID.
pub fn decrypt_timestamp(blob: &[u8], hwid: &str) -> Option<i64> {
    if blob.len() < 12 {
        return None;
    }
    let (nonce_bytes, ciphertext) = blob.split_at(12);
    let key = derive_timestamp_key(hwid);
    let cipher = Aes256Gcm::new((&key).into());
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher.decrypt(nonce, ciphertext).ok()?;
    let bytes: [u8; 8] = plaintext.try_into().ok()?;
    Some(i64::from_be_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_keypair() -> (SigningKey, [u8; 32]) {
        let signing_key = SigningKey::generate(&mut rand::rngs::OsRng);
        let verifying_key_bytes = signing_key.verifying_key().to_bytes();
        (signing_key, verifying_key_bytes)
    }

    #[test]
    fn sign_then_verify_round_trips() {
        let (signing_key, verifying_key_bytes) = test_keypair();
        let payload = LicensePayload {
            license_id: "L-1".into(),
            customer_name: "Test Customer".into(),
            issued_at: "2026-01-01".into(),
            expires_at: None,
        };
        let raw = sign_license(&payload, &signing_key);

        // Verify manually against this test's own key rather than the
        // embedded constant, since that constant isn't this test's key.
        let (payload_b64, sig_b64) = raw.split_once('.').unwrap();
        let payload_bytes = B64.decode(payload_b64).unwrap();
        let sig_bytes = B64.decode(sig_b64).unwrap();
        let sig_array: [u8; 64] = sig_bytes.try_into().unwrap();
        let signature = Signature::from_bytes(&sig_array);
        let verifying_key = VerifyingKey::from_bytes(&verifying_key_bytes).unwrap();
        assert!(verifying_key.verify(&payload_bytes, &signature).is_ok());

        let decoded: LicensePayload = serde_json::from_slice(&payload_bytes).unwrap();
        assert_eq!(decoded, payload);
    }

    /// End-to-end sanity check tying keygen -> issue_license -> verify_license
    /// together for real: this exact string was produced by running
    /// `cargo run --bin issue_license` against the actual vendor private
    /// key, and must verify against the actual embedded PUBLIC_KEY_BYTES.
    /// If this ever fails, the embedded public key and the vendor's
    /// private key have drifted apart.
    #[test]
    fn verifies_a_real_license_issued_by_the_actual_vendor_key() {
        let raw = "eyJsaWNlbnNlX2lkIjoiTElDLTQyY2VlYjcwOWZmYTc5ODMiLCJjdXN0b21lcl9uYW1lIjoiVGVzdCBDdXN0b21lciIsImlzc3VlZF9hdCI6IjIwMjYtMDgtMjEiLCJleHBpcmVzX2F0IjoiMjAyNi0wOS0yMCJ9.kACNdrC7vmh6L7gosHY8Qr7U9GACy3dyS2nKkng5/y1HLKfxtZN7c46A7E4hVS8/t0MO79Un6wm090HHnmc8BQ==";
        let payload = verify_license(raw).expect("real issued license must verify");
        assert_eq!(payload.customer_name, "Test Customer");
        assert_eq!(payload.issued_at, "2026-08-21");
        assert_eq!(payload.expires_at.as_deref(), Some("2026-09-20"));
    }

    #[test]
    fn verify_license_rejects_malformed_input() {
        assert_eq!(verify_license("not-a-license"), Err(LicenseError::Malformed));
        assert_eq!(verify_license("abc.def"), Err(LicenseError::Malformed));
    }

    #[test]
    fn verify_license_rejects_a_signature_from_the_wrong_key() {
        let (signing_key, _) = test_keypair();
        let payload = LicensePayload {
            license_id: "L-1".into(),
            customer_name: "Test Customer".into(),
            issued_at: "2026-01-01".into(),
            expires_at: None,
        };
        let raw = sign_license(&payload, &signing_key);
        // PUBLIC_KEY_BYTES is a different key than the one used to sign
        // above, so verification against the embedded constant must fail.
        assert_eq!(verify_license(&raw), Err(LicenseError::InvalidSignature));
    }

    #[test]
    fn timestamp_encryption_round_trips_and_is_hwid_bound() {
        let hwid_a = "hwid-a";
        let hwid_b = "hwid-b";
        let blob = encrypt_timestamp(1_700_000_000, hwid_a);

        assert_eq!(decrypt_timestamp(&blob, hwid_a), Some(1_700_000_000));
        assert_eq!(decrypt_timestamp(&blob, hwid_b), None, "must not decrypt under a different HWID");
    }
}
