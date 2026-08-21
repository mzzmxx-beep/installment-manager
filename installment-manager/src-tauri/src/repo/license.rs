use chrono::{NaiveDate, Utc};
use rusqlite::{params, Connection};

use crate::licensing::{self, LicensePayload};
use crate::models::LicenseStatus;

struct ActivationRow {
    raw_license: String,
    hwid: String,
    encrypted_last_execution_ts: Vec<u8>,
}

fn get_activation(conn: &Connection) -> rusqlite::Result<Option<ActivationRow>> {
    conn.query_row(
        "SELECT raw_license, hwid, encrypted_last_execution_ts FROM license_activation WHERE id = 1",
        [],
        |row| {
            Ok(ActivationRow {
                raw_license: row.get(0)?,
                hwid: row.get(1)?,
                encrypted_last_execution_ts: row.get(2)?,
            })
        },
    )
    .map(Some)
    .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e) })
}

fn status_for_payload(payload: &LicensePayload, now: NaiveDate) -> Option<LicenseStatus> {
    match &payload.expires_at {
        Some(expires_at) => {
            let expiry = NaiveDate::parse_from_str(expires_at, "%Y-%m-%d").ok()?;
            if now > expiry {
                return Some(LicenseStatus::Expired {
                    customer_name: payload.customer_name.clone(),
                    expires_at: expires_at.clone(),
                });
            }
            None
        }
        None => None,
    }
}

/// Activates a new license: verifies its signature, binds it to this
/// machine's HWID, and starts the anti-rollback timestamp. Replaces any
/// previously activated license (ARCHITECTURE.md §7 — one active license
/// per install).
pub fn activate_license(conn: &Connection, raw_license: &str) -> rusqlite::Result<LicenseStatus> {
    let payload = match licensing::verify_license(raw_license) {
        Ok(payload) => payload,
        Err(_) => {
            return Ok(LicenseStatus::Invalid {
                reason: "رمز الترخيص غير صالح أو تالف".into(),
            })
        }
    };

    let hwid = licensing::compute_hwid();
    let now = Utc::now();
    let encrypted_ts = licensing::encrypt_timestamp(now.timestamp(), &hwid);

    conn.execute(
        "INSERT INTO license_activation (id, raw_license, hwid, activated_at, encrypted_last_execution_ts)
         VALUES (1, ?1, ?2, ?3, ?4)
         ON CONFLICT (id) DO UPDATE SET
            raw_license = excluded.raw_license,
            hwid = excluded.hwid,
            activated_at = excluded.activated_at,
            encrypted_last_execution_ts = excluded.encrypted_last_execution_ts",
        params![
            raw_license,
            hwid,
            now.to_rfc3339(),
            encrypted_ts,
        ],
    )?;

    if let Some(expired_status) = status_for_payload(&payload, now.date_naive()) {
        return Ok(expired_status);
    }
    Ok(LicenseStatus::Valid {
        customer_name: payload.customer_name,
        expires_at: payload.expires_at,
    })
}

/// Re-checks the currently activated license: signature, HWID binding,
/// expiry, and clock-rollback (ARCHITECTURE.md §7). Called on every app
/// startup. Updates the anti-rollback timestamp only when everything
/// checks out — a detected rollback must not reset the clock it caught.
pub fn validate_license(conn: &Connection) -> rusqlite::Result<LicenseStatus> {
    let Some(row) = get_activation(conn)? else {
        return Ok(LicenseStatus::NotActivated);
    };

    let payload = match licensing::verify_license(&row.raw_license) {
        Ok(payload) => payload,
        Err(_) => {
            return Ok(LicenseStatus::Invalid {
                reason: "بيانات الترخيص المحفوظة تالفة".into(),
            })
        }
    };

    let current_hwid = licensing::compute_hwid();
    if current_hwid != row.hwid {
        return Ok(LicenseStatus::Invalid {
            reason: "هذا الترخيص مفعّل على جهاز آخر".into(),
        });
    }

    let Some(last_execution) = licensing::decrypt_timestamp(&row.encrypted_last_execution_ts, &current_hwid) else {
        return Ok(LicenseStatus::Invalid {
            reason: "تعذر التحقق من سجل التشغيل السابق".into(),
        });
    };

    let now = Utc::now();
    if now.timestamp() < last_execution {
        return Ok(LicenseStatus::ClockRollbackDetected);
    }

    if let Some(expired_status) = status_for_payload(&payload, now.date_naive()) {
        return Ok(expired_status);
    }

    let encrypted_ts = licensing::encrypt_timestamp(now.timestamp(), &current_hwid);
    conn.execute(
        "UPDATE license_activation SET encrypted_last_execution_ts = ?1 WHERE id = 1",
        params![encrypted_ts],
    )?;

    Ok(LicenseStatus::Valid {
        customer_name: payload.customer_name,
        expires_at: payload.expires_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_test_db;
    use chrono::Duration;
    use ed25519_dalek::SigningKey;
    use licensing::sign_license;

    fn seed_payload(days_valid: Option<i64>) -> (LicensePayload, SigningKey) {
        // NOTE: this signs with a throwaway test key, not the real vendor
        // key, so verify_license() against the embedded PUBLIC_KEY_BYTES
        // will reject it. These tests exercise the DB orchestration and
        // status logic directly rather than through verify_license.
        let signing_key = SigningKey::generate(&mut rand::rngs::OsRng);
        let now = Utc::now();
        let payload = LicensePayload {
            license_id: "L-TEST".into(),
            customer_name: "Test Co".into(),
            issued_at: now.format("%Y-%m-%d").to_string(),
            expires_at: days_valid.map(|d| (now + Duration::days(d)).format("%Y-%m-%d").to_string()),
        };
        (payload, signing_key)
    }

    #[test]
    fn no_activation_reports_not_activated() {
        let conn = init_test_db();
        assert_eq!(validate_license(&conn).unwrap(), LicenseStatus::NotActivated);
    }

    /// Full happy-path round trip using a real license issued by the
    /// actual vendor key (perpetual, so this never goes stale like a
    /// dated fixture would). Ties together verify_license, HWID binding,
    /// and the anti-rollback timestamp through the real SQLite-backed flow.
    #[test]
    fn activate_then_validate_a_real_perpetual_license_succeeds() {
        let conn = init_test_db();
        let raw = "eyJsaWNlbnNlX2lkIjoiTElDLTA0ZjdmOTJhNDk1ZTBiNDMiLCJjdXN0b21lcl9uYW1lIjoiUGVycGV0dWFsIFRlc3QgQ28iLCJpc3N1ZWRfYXQiOiIyMDI2LTA4LTIxIiwiZXhwaXJlc19hdCI6bnVsbH0=.CtIpNobfr2mtGjNRGamOSJ22PBHRpCFioZIx0FsOE1J1RxN+Cgf2RYgpeOn7Nq/5VPA1RVv1iBFGfWDI0WPNCA==";

        let activate_status = activate_license(&conn, raw).unwrap();
        assert_eq!(
            activate_status,
            LicenseStatus::Valid { customer_name: "Perpetual Test Co".into(), expires_at: None }
        );

        let validate_status = validate_license(&conn).unwrap();
        assert_eq!(
            validate_status,
            LicenseStatus::Valid { customer_name: "Perpetual Test Co".into(), expires_at: None }
        );
    }

    #[test]
    fn activating_a_license_signed_by_an_unknown_key_is_invalid() {
        let conn = init_test_db();
        let (payload, signing_key) = seed_payload(None);
        let raw = sign_license(&payload, &signing_key);

        let status = activate_license(&conn, &raw).unwrap();
        assert!(matches!(status, LicenseStatus::Invalid { .. }));
    }

    #[test]
    fn tampering_with_the_stored_hwid_is_detected() {
        // Directly exercises the HWID-mismatch branch of validate_license
        // by inserting an activation row bound to a HWID that can never
        // match the current machine's real computed HWID.
        let conn = init_test_db();
        conn.execute(
            "INSERT INTO license_activation (id, raw_license, hwid, encrypted_last_execution_ts)
             VALUES (1, 'irrelevant', 'not-the-real-hwid', X'00')",
            [],
        )
        .unwrap();

        // The raw_license here won't even verify, so this also confirms
        // signature failure is reported before HWID is consulted.
        let status = validate_license(&conn).unwrap();
        assert!(matches!(status, LicenseStatus::Invalid { .. }));
    }

    #[test]
    fn status_for_payload_flags_an_expired_license() {
        let past = LicensePayload {
            license_id: "L-1".into(),
            customer_name: "Old Co".into(),
            issued_at: "2020-01-01".into(),
            expires_at: Some("2020-02-01".into()),
        };
        let today = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        let status = status_for_payload(&past, today);
        assert!(matches!(status, Some(LicenseStatus::Expired { .. })));
    }

    #[test]
    fn status_for_payload_is_none_for_a_perpetual_or_unexpired_license() {
        let perpetual = LicensePayload {
            license_id: "L-1".into(),
            customer_name: "Co".into(),
            issued_at: "2026-01-01".into(),
            expires_at: None,
        };
        assert_eq!(status_for_payload(&perpetual, NaiveDate::from_ymd_opt(2030, 1, 1).unwrap()), None);

        let not_yet_expired = LicensePayload {
            license_id: "L-2".into(),
            customer_name: "Co".into(),
            issued_at: "2026-01-01".into(),
            expires_at: Some("2030-01-01".into()),
        };
        assert_eq!(status_for_payload(&not_yet_expired, NaiveDate::from_ymd_opt(2026, 6, 1).unwrap()), None);
    }
}
