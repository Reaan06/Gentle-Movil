//! JNI shim: exports the `Java_com_gentlemovil_core_GcNative_*` symbols the
//! Kotlin `GcNative` object declares as `external fun`. Each wrapper owns the
//! string marshalling and delegates to the plain C ABI in [`crate::cabi`].
//!
//! The JNI boundary is the module's one unsafe surface: JNI accessors and
//! `CString` reconstruction. Every cabi call is `catch_unwind`-ed, so a Rust
//! panic surfaces as a JSON error envelope, never as a JVM crash.
//!
//! ## Never `null` to Kotlin (S4, S7)
//!
//! `GcCoreModule` turns a null `jstring` into `EmptyResponse` ("El núcleo no devolvió
//! nada para «…»"), which hides both the real cause and the answer the core produced. So
//! the shim treats every answer as *text*: it marshals
//! [`cabi::primary_answer_text`](crate::cabi::primary_answer_text) and, when the JVM
//! refuses that text, retries once with
//! [`cabi::answer_refused_envelope`](crate::cabi::answer_refused_envelope). Both decisions
//! live in `cabi` so the offline suite tests them; only the two JNI calls themselves are
//! device-only.
//!
//! ## A pending exception poisons the next call
//!
//! `JNIEnv::new_string` returns an error while a Java exception is pending, so a throwable
//! left behind by an earlier failing accessor (classically `GetStringUTFChars` inside
//! [`from_jstring`]) used to make the whole answer vanish even though the core had
//! answered. [`from_jstring`] and [`marshal_text`] therefore clear the pending exception,
//! and the fallback envelope names the cleared exception instead of swallowing it.
#![allow(unsafe_code)]
#![allow(non_snake_case)]

use std::ffi::{c_char, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};

use jni::objects::{JClass, JString};
use jni::sys::{jlong, jstring};
use jni::JNIEnv;

use crate::cabi::{
    answer_refused_envelope, primary_answer_text, refused_input_envelope, take_answer_text,
    MarshalFailure,
};

/// Asks the JVM for `text` as a `jstring`, after clearing any exception an earlier call left
/// pending — `NewStringUTF` fails while one is set, which is what used to null the answer.
///
/// A refused text is described in [`MarshalFailure`] so the caller can answer an envelope
/// that names both the cleared exception and the JVM's own reason.
fn marshal_text(env: &mut JNIEnv, text: &str) -> Result<jstring, MarshalFailure> {
    let mut failure = MarshalFailure::default();
    // `ExceptionCheck` never throws; if it somehow cannot answer, assume pending and clear,
    // because a stray throwable is far worse than a redundant `ExceptionClear`.
    if env.exception_check().unwrap_or(true) {
        let _ = env.exception_clear();
        failure.pending_exception_cleared = true;
    }
    match env.new_string(text) {
        Ok(text) => Ok(text.into_raw()),
        Err(error) => {
            // The failed call may have raised its own throwable: clear it, otherwise the
            // fallback below would fail for the very same reason.
            let _ = env.exception_clear();
            failure.reason = error.to_string();
            Err(failure)
        }
    }
}

/// Marshals one answer into a `jstring`, falling back to an error envelope.
///
/// The only case that still answers `null` is "the JVM refused both the answer and the
/// envelope explaining the refusal" (`NewStringUTF` has to allocate, so that is an
/// out-of-memory / dying-VM state). `GcCoreModule` reports it as `EmptyResponse`; nothing
/// left in this process can describe it in a string any more.
fn marshal_answer(env: &mut JNIEnv, answer: Option<&str>) -> jstring {
    let primary = primary_answer_text(answer);
    match marshal_text(env, &primary) {
        Ok(text) => text,
        Err(failure) => match marshal_text(env, &answer_refused_envelope(&failure)) {
            Ok(text) => text,
            Err(_) => std::ptr::null_mut(),
        },
    }
}

/// Marshals a raw cabi pointer into a JNI-owned `jstring`; see [`marshal_answer`] for the
/// one remaining `null` case.
fn pointer_to_jstring(env: &mut JNIEnv, raw: *mut c_char) -> jstring {
    // The pointer is released while it is read (Kotlin gets a copy), so the ownership rule
    // stays simple for the Kotlin side: never call gcFree.
    let answer = take_answer_text(raw);
    marshal_answer(env, answer.as_deref())
}

/// Reads a Kotlin `String` argument into a Rust `String`, or says why it could not.
///
/// A failed `get_string` leaves the exception it threw **pending**; that is what made the
/// following `new_string` fail and the answer disappear. It is cleared here, and the reason
/// travels back to the caller so it answers an `input` envelope naming the real cause
/// instead of pretending the argument was empty JSON.
fn from_jstring(env: &mut JNIEnv, value: &JString) -> Result<String, String> {
    match env.get_string(value) {
        Ok(text) => Ok(text.to_string_lossy().into_owned()),
        Err(error) => {
            let _ = env.exception_clear();
            Err(error.to_string())
        }
    }
}

/// Answers a call whose Kotlin argument could not be read: an `input` envelope, never null.
fn refuse_input(env: &mut JNIEnv, reason: &str) -> jstring {
    marshal_answer(env, Some(refused_input_envelope(reason).as_str()))
}

/// One-string cabi call: marshal in, call under `catch_unwind`, marshal out.
fn call_one_string(
    env: &mut JNIEnv,
    input: &JString,
    call: impl FnOnce(*const c_char) -> *mut c_char,
) -> jstring {
    let input = match from_jstring(env, input) {
        Ok(input) => input,
        Err(reason) => return refuse_input(env, &reason),
    };
    let raw = match CString::new(input) {
        Ok(text) => catch_unwind(AssertUnwindSafe(|| call(text.as_ptr())))
            .unwrap_or_else(|_| panic_envelope()),
        // A Kotlin string can carry a NUL byte (a password, for instance) and `CString`
        // cannot hold one; the ABI's `input` kind says so instead of the old `panic` answer.
        Err(_) => return refuse_input(env, "the argument contains a NUL byte"),
    };
    pointer_to_jstring(env, raw)
}

fn panic_envelope() -> *mut c_char {
    let text = r#"{"ok":false,"error":{"kind":"panic","message":"the native core panicked"}}"#;
    match CString::new(text) {
        Ok(s) => s.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Returns the ABI version string (e.g. "1"); an error envelope if the JVM refuses it.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcAbiVersion(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let version = catch_unwind(AssertUnwindSafe(|| crate::cabi::gc_abi_version())).unwrap_or(0);
    marshal_answer(&mut env, Some(version.to_string().as_str()))
}

/// Parses a `gc://pair?…` URI (JSON in/out), mirroring `gc_pair_from_qr`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcPairFromQr(
    mut env: JNIEnv,
    _class: JClass,
    json: JString,
) -> jstring {
    // `extern "C" fn` items do not implement `FnOnce`, so the ABI function is wrapped.
    call_one_string(&mut env, &json, |uri| crate::cabi::gc_pair_from_qr(uri))
}

/// Opens an authenticated SSH session from a JSON config; returns `{"ok":true,"sessionId":N}`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcSshConnect(
    mut env: JNIEnv,
    _class: JClass,
    json: JString,
) -> jstring {
    call_one_string(&mut env, &json, |config| {
        crate::cabi::gc_ssh_connect(config)
    })
}

/// Reconnects with the device key and a **pinned** host key:
/// `{"host","port","user","seed":[..],"expectedFp"}` → the connect envelope.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcSshConnectSeed(
    mut env: JNIEnv,
    _class: JClass,
    json: JString,
) -> jstring {
    call_one_string(&mut env, &json, |config| {
        crate::cabi::gc_ssh_connect_seed(config)
    })
}

/// Derives the public half of a keystore-sealed seed:
/// `{"seed":[..32 bytes]} → {"ok":true,"result":{"publicHex","fingerprint"}}`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcDeviceKeyPublic(
    mut env: JNIEnv,
    _class: JClass,
    json: JString,
) -> jstring {
    call_one_string(&mut env, &json, |payload| {
        crate::cabi::gc_device_key_public(payload)
    })
}

/// Lists one level of device files: `{"root","path","maxEntries"}`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcFsList(
    mut env: JNIEnv,
    _class: JClass,
    json: JString,
) -> jstring {
    call_one_string(&mut env, &json, |payload| crate::cabi::gc_fs_list(payload))
}

/// Reads a device file as text: `{"root","path","maxBytes"}`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcFsRead(
    mut env: JNIEnv,
    _class: JClass,
    json: JString,
) -> jstring {
    call_one_string(&mut env, &json, |payload| crate::cabi::gc_fs_read(payload))
}

/// Shared body of the session-handle shims: split the document, call the C ABI under
/// `catch_unwind`, marshal the answer back. Kotlin has no `u64` rule of its own, so the
/// handle rides inside the JSON document exactly like the channel shims.
fn session_shim(env: &mut JNIEnv, json: JString, call: impl FnOnce(u64) -> *mut c_char) -> jstring {
    let input = match from_jstring(env, &json) {
        Ok(input) => input,
        Err(reason) => return refuse_input(env, &reason),
    };
    let raw = match crate::cabi::split_session_document(&input) {
        Ok(session_id) => {
            catch_unwind(AssertUnwindSafe(|| call(session_id))).unwrap_or_else(|_| panic_envelope())
        }
        Err(error) => input_envelope(&error.message),
    };
    pointer_to_jstring(env, raw)
}

/// `gc_ssh_close(session_id)` from one Kotlin document `{"sessionId":N}`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcSshClose(
    mut env: JNIEnv,
    _class: JClass,
    json: JString,
) -> jstring {
    session_shim(&mut env, json, |session_id| {
        crate::cabi::gc_ssh_close(session_id)
    })
}

/// Error envelope for a channel document the split rejects (`input`, like the C ABI's own
/// malformed-input kind). Same shape every other failure uses, never a crash.
fn input_envelope(message: &str) -> *mut c_char {
    let value = serde_json::json!({
        "ok": false,
        "error": { "kind": "input", "message": message },
    });
    match CString::new(value.to_string()) {
        Ok(text) => text.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Shared body of the three channel shims: split the document, call the C ABI under
/// `catch_unwind`, marshal the answer back.
///
/// Kotlin has no `u64` in its JSON document contract (`GcCoreModule` rule 2), so the
/// `sessionId`/`channelId` handles ride inside the document. The split lives in
/// [`crate::cabi::split_channel_document`] — next to the payload shapes it feeds and off
/// this Android-only module — so it is compiled and tested by the offline suite; the shim
/// keeps only marshalling.
fn channel_shim(
    env: &mut JNIEnv,
    json: JString,
    call: impl FnOnce(u64, u64, *const c_char) -> *mut c_char,
) -> jstring {
    let input = match from_jstring(env, &json) {
        Ok(input) => input,
        Err(reason) => return refuse_input(env, &reason),
    };
    let raw = match crate::cabi::split_channel_document(&input) {
        Ok(split) => match CString::new(split.payload) {
            Ok(payload) => catch_unwind(AssertUnwindSafe(|| {
                call(split.session_id, split.channel_id, payload.as_ptr())
            }))
            .unwrap_or_else(|_| panic_envelope()),
            Err(_) => input_envelope("the channel document contains a NUL byte"),
        },
        Err(error) => input_envelope(&error.message),
    };
    pointer_to_jstring(env, raw)
}

/// `gc_ssh_channel_write(session_id, channel_id, {"bytes":"<base64>"})` from one Kotlin
/// document `{"sessionId":N,"channelId":M,"bytes":"<base64>"}`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcSshChannelWrite(
    mut env: JNIEnv,
    _class: JClass,
    json: JString,
) -> jstring {
    channel_shim(&mut env, json, |session_id, channel_id, payload| {
        crate::cabi::gc_ssh_channel_write(session_id, channel_id, payload)
    })
}

/// `gc_ssh_channel_read(session_id, channel_id, {"timeoutMs":N})` from one Kotlin document
/// `{"sessionId":N,"channelId":M,"timeoutMs":K}`. `timeoutMs` is optional and is passed
/// through untouched, so an absent field keeps the C ABI's bounded default window and `0`
/// stays a non-blocking poll.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcSshChannelRead(
    mut env: JNIEnv,
    _class: JClass,
    json: JString,
) -> jstring {
    channel_shim(&mut env, json, |session_id, channel_id, payload| {
        crate::cabi::gc_ssh_channel_read(session_id, channel_id, payload)
    })
}

/// `gc_ssh_channel_close(session_id, channel_id)` from one Kotlin document
/// `{"sessionId":N,"channelId":M}`; the document's remaining fields are unused.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcSshChannelClose(
    mut env: JNIEnv,
    _class: JClass,
    json: JString,
) -> jstring {
    channel_shim(&mut env, json, |session_id, channel_id, _payload| {
        crate::cabi::gc_ssh_channel_close(session_id, channel_id)
    })
}

/// `gc_provision_step(session_id, step_json)`: Kotlin passes one JSON document
/// `{"sessionId":N, ...step}`; this shim splits the handle out and forwards.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcProvisionStep(
    mut env: JNIEnv,
    _class: JClass,
    json: JString,
) -> jstring {
    let input = match from_jstring(&mut env, &json) {
        Ok(input) => input,
        Err(reason) => return refuse_input(&mut env, &reason),
    };
    let raw = match serde_json::from_str::<serde_json::Value>(&input) {
        Ok(mut value) => {
            let session_id = value.get("sessionId").and_then(|v| v.as_u64()).unwrap_or(0);
            if value.get("sessionId").is_some() {
                if let Some(obj) = value.as_object_mut() {
                    obj.remove("sessionId");
                }
            }
            let step_json = value.to_string();
            match CString::new(step_json) {
                Ok(step) => catch_unwind(AssertUnwindSafe(|| {
                    crate::cabi::gc_provision_step(session_id, step.as_ptr())
                }))
                .unwrap_or_else(|_| panic_envelope()),
                Err(_) => panic_envelope(),
            }
        }
        Err(_) => panic_envelope(),
    };
    pointer_to_jstring(&mut env, raw)
}

/// `gc_device_key_generate()` takes no input on the Rust side; Kotlin passes a
/// JSON document for future options, ignored here.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcDeviceKeyGenerate(
    mut env: JNIEnv,
    _class: JClass,
    _json: JString,
) -> jstring {
    let raw = catch_unwind(AssertUnwindSafe(|| crate::cabi::gc_device_key_generate()))
        .unwrap_or_else(|_| panic_envelope());
    pointer_to_jstring(&mut env, raw)
}

/// Compatibility no-op: the shim frees every returned string immediately, so nothing to release.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcFree(
    _env: JNIEnv,
    _class: JClass,
    _pointer: jlong,
) {
    // The shim already frees after each call; gcFree stays a no-op for API
    // compatibility with the Kotlin contract, accepting any value.
}
