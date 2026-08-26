use chrono::{DateTime, Duration, NaiveDate, Utc};
use rusqlite::{params, Connection};

use crate::licensing::{self, LicensePayload};
use crate::models::LicenseStatus;

/// Length of the self-service free trial (ARCHITECTURE.md §7 extension —
/// no vendor interaction, fully offline like the rest of licensing).
const TRIAL_DAYS: i64 = 30;

const TRIAL_DISPLAY_NAME: &str = "نسخة تجريبية مجانية";

struct ActivationRow {
    raw_license: String,
    hwid: String,
    activated_at: String,
    encrypted_last_execution_ts: Vec<u8>,
    is_trial: bool,
}

fn get_activation(conn: &Connection) -> rusqlite::Result<Option<ActivationRow>> {
    conn.query_row(
        "SELECT raw_license, hwid, activated_at, encrypted_last_execution_ts, is_trial FROM license_activation WHERE id = 1",
        [],
        |row| {
            Ok(ActivationRow {
                raw_license: row.get(0)?,
                hwid: row.get(1)?,
                activated_at: row.get(2)?,
                encrypted_last_execution_ts: row.get(3)?,
                is_trial: row.get::<_, i64>(4)? != 0,
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
                    is_trial: false,
                });
            }
            None
        }
        None => None,
    }
}

/// The trial's expiry date: `TRIAL_DAYS` after the RFC3339 `activated_at`
/// timestamp recorded when the trial started. `None` only if `activated_at`
/// was somehow malformed (never happens for a value this module wrote).
fn trial_expiry_date(activated_at: &str) -> Option<NaiveDate> {
    let started = DateTime::parse_from_rfc3339(activated_at).ok()?.date_naive();
    Some(started + Duration::days(TRIAL_DAYS))
}

/// Starts the one-time free trial on this machine: no vendor license
/// involved, just a local HWID-bound clock (same anti-rollback protection
/// as a real license) counting down from today. Refuses if anything is
/// already activated on this install (real or trial) — the frontend only
/// offers this button on `NotActivated`, this is the server-side backstop.
pub fn start_trial(conn: &Connection) -> rusqlite::Result<LicenseStatus> {
    if get_activation(conn)?.is_some() {
        return Ok(LicenseStatus::Invalid {
            reason: "تم استخدام هذا الجهاز مسبقاً لتفعيل ترخيص أو تجربة".into(),
        });
    }

    let hwid = licensing::compute_hwid();
    let now = Utc::now();
    let encrypted_ts = licensing::encrypt_timestamp(now.timestamp(), &hwid);
    let activated_at = now.to_rfc3339();

    conn.execute(
        "INSERT INTO license_activation (id, raw_license, hwid, activated_at, encrypted_last_execution_ts, is_trial)
         VALUES (1, '', ?1, ?2, ?3, 1)",
        params![hwid, activated_at, encrypted_ts],
    )?;

    let expires_at = trial_expiry_date(&activated_at).map(|d| d.format("%Y-%m-%d").to_string());
    Ok(LicenseStatus::Valid {
        customer_name: TRIAL_DISPLAY_NAME.into(),
        expires_at,
        issued_at: now.format("%Y-%m-%d").to_string(),
        activated_at,
        is_trial: true,
    })
}

/// Activates a new license: verifies its signature, binds it to this
/// machine's HWID, and starts the anti-rollback timestamp. Replaces any
/// previously activated license *or* trial (ARCHITECTURE.md §7 — one
/// active license per install) — this is also how a trial converts to a
/// paid license, so `is_trial` must be explicitly cleared here.
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
        "INSERT INTO license_activation (id, raw_license, hwid, activated_at, encrypted_last_execution_ts, is_trial)
         VALUES (1, ?1, ?2, ?3, ?4, 0)
         ON CONFLICT (id) DO UPDATE SET
            raw_license = excluded.raw_license,
            hwid = excluded.hwid,
            activated_at = excluded.activated_at,
            encrypted_last_execution_ts = excluded.encrypted_last_execution_ts,
            is_trial = 0",
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
        issued_at: payload.issued_at,
        activated_at: now.to_rfc3339(),
        is_trial: false,
    })
}

/// Re-checks the currently activated license or trial: HWID binding,
/// expiry, and clock-rollback (ARCHITECTURE.md §7). Called on every app
/// startup. Updates the anti-rollback timestamp only when everything
/// checks out — a detected rollback must not reset the clock it caught.
pub fn validate_license(conn: &Connection) -> rusqlite::Result<LicenseStatus> {
    let Some(row) = get_activation(conn)? else {
        return Ok(LicenseStatus::NotActivated);
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

    if row.is_trial {
        let expiry = trial_expiry_date(&row.activated_at).unwrap_or(now.date_naive());
        if now.date_naive() > expiry {
            return Ok(LicenseStatus::Expired {
                customer_name: TRIAL_DISPLAY_NAME.into(),
                expires_at: expiry.format("%Y-%m-%d").to_string(),
                is_trial: true,
            });
        }

        let encrypted_ts = licensing::encrypt_timestamp(now.timestamp(), &current_hwid);
        conn.execute(
            "UPDATE license_activation SET encrypted_last_execution_ts = ?1 WHERE id = 1",
            params![encrypted_ts],
        )?;

        return Ok(LicenseStatus::Valid {
            customer_name: TRIAL_DISPLAY_NAME.into(),
            expires_at: Some(expiry.format("%Y-%m-%d").to_string()),
            issued_at: DateTime::parse_from_rfc3339(&row.activated_at)
                .map(|d| d.format("%Y-%m-%d").to_string())
                .unwrap_or_else(|_| row.activated_at.clone()),
            activated_at: row.activated_at,
            is_trial: true,
        });
    }

    let payload = match licensing::verify_license(&row.raw_license) {
        Ok(payload) => payload,
        Err(_) => {
            return Ok(LicenseStatus::Invalid {
                reason: "بيانات الترخيص المحفوظة تالفة".into(),
            })
        }
    };

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
        issued_at: payload.issued_at,
        activated_at: row.activated_at,
        is_trial: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_test_db;
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
        let raw = "eyJsaWNlbnNlX2lkIjoiTElDLWQxMGU0NDIwMjg4OTdiNjciLCJjdXN0b21lcl9uYW1lIjoiUGVycGV0dWFsIFRlc3QgQ28iLCJpc3N1ZWRfYXQiOiIyMDI2LTA4LTIxIiwiZXhwaXJlc19hdCI6bnVsbH0=.n6VoM77V041b16qOyzcF2rEY5ljGqm58I1R0PEcTYhmJyCHyyThey5GtLU82C0scT2Frh6qk+uqbIDaHn2xZAA==";

        let activate_status = activate_license(&conn, raw).unwrap();
        let LicenseStatus::Valid { customer_name, expires_at, issued_at, activated_at, is_trial } = activate_status else {
            panic!("expected Valid, got {activate_status:?}");
        };
        assert_eq!(customer_name, "Perpetual Test Co");
        assert_eq!(expires_at, None);
        assert_eq!(issued_at, "2026-08-21");
        assert!(!activated_at.is_empty());
        assert!(!is_trial);

        let validate_status = validate_license(&conn).unwrap();
        let LicenseStatus::Valid { customer_name, expires_at, issued_at, activated_at: activated_at_2, is_trial } = validate_status else {
            panic!("expected Valid, got {validate_status:?}");
        };
        assert_eq!(customer_name, "Perpetual Test Co");
        assert_eq!(expires_at, None);
        assert_eq!(issued_at, "2026-08-21");
        assert!(!is_trial);
        // The activation timestamp recorded at `activate_license` time must
        // be preserved (not silently refreshed) by a later `validate_license`.
        assert_eq!(activated_at_2, activated_at);
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

        // Signature is never even reached here — HWID mismatch is checked
        // first regardless of is_trial, so this covers both paths.
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

    #[test]
    fn starting_a_trial_grants_thirty_days_from_today() {
        let conn = init_test_db();
        let status = start_trial(&conn).unwrap();
        let LicenseStatus::Valid { customer_name, expires_at, is_trial, .. } = status else {
            panic!("expected Valid, got {status:?}");
        };
        assert_eq!(customer_name, TRIAL_DISPLAY_NAME);
        assert!(is_trial);
        let expected = (Utc::now().date_naive() + Duration::days(TRIAL_DAYS)).format("%Y-%m-%d").to_string();
        assert_eq!(expires_at, Some(expected));
    }

    #[test]
    fn starting_a_trial_twice_on_the_same_install_is_refused() {
        let conn = init_test_db();
        start_trial(&conn).unwrap();
        let second = start_trial(&conn).unwrap();
        assert!(matches!(second, LicenseStatus::Invalid { .. }));
    }

    #[test]
    fn a_trial_past_thirty_days_reports_expired() {
        let conn = init_test_db();
        // Backdate the activation by 31 days so the trial has already lapsed,
        // bypassing the public start_trial() API to control the clock directly.
        let hwid = licensing::compute_hwid();
        let started_at = (Utc::now() - Duration::days(31)).to_rfc3339();
        let encrypted_ts = licensing::encrypt_timestamp((Utc::now() - Duration::days(31)).timestamp(), &hwid);
        conn.execute(
            "INSERT INTO license_activation (id, raw_license, hwid, activated_at, encrypted_last_execution_ts, is_trial)
             VALUES (1, '', ?1, ?2, ?3, 1)",
            params![hwid, started_at, encrypted_ts],
        )
        .unwrap();

        let status = validate_license(&conn).unwrap();
        assert!(matches!(status, LicenseStatus::Expired { is_trial: true, .. }));
    }

    #[test]
    fn activating_a_real_license_after_a_trial_clears_the_trial_flag() {
        let conn = init_test_db();
        start_trial(&conn).unwrap();

        let raw = "eyJsaWNlbnNlX2lkIjoiTElDLWQxMGU0NDIwMjg4OTdiNjciLCJjdXN0b21lcl9uYW1lIjoiUGVycGV0dWFsIFRlc3QgQ28iLCJpc3N1ZWRfYXQiOiIyMDI2LTA4LTIxIiwiZXhwaXJlc19hdCI6bnVsbH0=.n6VoM77V041b16qOyzcF2rEY5ljGqm58I1R0PEcTYhmJyCHyyThey5GtLU82C0scT2Frh6qk+uqbIDaHn2xZAA==";
        activate_license(&conn, raw).unwrap();

        let status = validate_license(&conn).unwrap();
        let LicenseStatus::Valid { is_trial, customer_name, .. } = status else {
            panic!("expected Valid, got {status:?}");
        };
        assert!(!is_trial, "a real license must not still be flagged as a trial");
        assert_eq!(customer_name, "Perpetual Test Co");
    }
}
