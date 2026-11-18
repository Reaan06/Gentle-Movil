//! JNI shim: exports the `Java_com_gentlemovil_core_GcNative_*` symbols the
//! Kotlin `GcNative` object declares as `external fun`. Each wrapper owns the
//! string marshalling and delegates to the plain C ABI in [`crate::cabi`].
//!
//! The JNI boundary is the module's one unsafe surface: JNI accessors and
//! `CString` reconstruction. Every cabi call is `catch_unwind`-ed, so a Rust
//! panic surfaces as a JSON error envelope, never as a JVM crash.
#![allow(unsafe_code)]
#![allow(non_snake_case)]

use std::ffi::{c_char, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};

use jni::objects::{JClass, JString};
use jni::sys::{jlong, jstring};
use jni::JNIEnv;

/// Marshals a raw cabi pointer into a JNI-owned `jstring` and frees nothing —
/// the pointer still belongs to the caller's `gc_free` contract.
fn pointer_to_jstring(env: &mut JNIEnv, raw: *mut c_char) -> jstring {
    if raw.is_null() {
        return std::ptr::null_mut();
    }
    // SAFETY: `raw` was produced by `into_c_string` (a `CString::into_raw`)
    // inside the cabi layer and is valid until `gc_free`.
    let text = unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned();
    // The pointer is released here: Kotlin received a copy as a jstring, so
    // keeping it until gc_free would leak per call. This keeps the ownership
    // rule simple for the Kotlin side: never call gcFree.
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe { crate::cabi::gc_free(raw) }));
    match env.new_string(text) {
        Ok(s) => s.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Marshals a Kotlin `String` argument into a Rust `String` (empty on null).
fn from_jstring(env: &mut JNIEnv, value: &JString) -> String {
    match env.get_string(value) {
        Ok(s) => s.to_string_lossy().into_owned(),
        Err(_) => String::new(),
    }
}

/// One-string cabi call: marshal in, call under catch_unwind, marshal out.
fn call_one_string(env: &mut JNIEnv, input: &JString, call: impl FnOnce(&str) -> *mut c_char) -> jstring {
    let input = from_jstring(env, input);
    let raw = match catch_unwind(AssertUnwindSafe(|| call(&input))) {
        Ok(ptr) => ptr,
        // A panic that somehow escapes the cabi's own catch_unwind still must
        // not cross the JVM boundary; fall back to a minimal error envelope.
        Err(_) => panic_envelope(),
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

/// Returns the ABI version string (e.g. "1"); "0" if the core panicked.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcAbiVersion(
    env: &mut JNIEnv,
    _class: JClass,
) -> jstring {
    let version = catch_unwind(AssertUnwindSafe(|| crate::cabi::gc_abi_version())).unwrap_or(0);
    match env.new_string(version.to_string()) {
        Ok(s) => s.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Parses a `gc://pair?…` URI (JSON in/out), mirroring `gc_pair_from_qr`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcPairFromQr(
    env: &mut JNIEnv,
    _class: JClass,
    json: JString,
) -> jstring {
    let input = from_jstring(env, &json);
    let raw = match CString::new(input) {
        Ok(uri) => catch_unwind(AssertUnwindSafe(|| crate::cabi::gc_pair_from_qr(uri.as_ptr()))).unwrap_or_else(|_| panic_envelope()),
        Err(_) => panic_envelope(),
    };
    pointer_to_jstring(env, raw)
}

/// Opens an authenticated SSH session from a JSON config; returns `{"ok":true,"sessionId":N}`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcSshConnect(
    env: &mut JNIEnv,
    _class: JClass,
    json: JString,
) -> jstring {
    let input = from_jstring(env, &json);
    let raw = match CString::new(input) {
        Ok(cfg) => catch_unwind(AssertUnwindSafe(|| crate::cabi::gc_ssh_connect(cfg.as_ptr()))).unwrap_or_else(|_| panic_envelope()),
        Err(_) => panic_envelope(),
    };
    pointer_to_jstring(env, raw)
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
    let input = from_jstring(env, &json);
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
    env: &mut JNIEnv,
    _class: JClass,
    json: JString,
) -> jstring {
    channel_shim(env, json, |session_id, channel_id, payload| {
        crate::cabi::gc_ssh_channel_write(session_id, channel_id, payload)
    })
}

/// `gc_ssh_channel_read(session_id, channel_id, {"timeoutMs":N})` from one Kotlin document
/// `{"sessionId":N,"channelId":M,"timeoutMs":K}`. `timeoutMs` is optional and is passed
/// through untouched, so an absent field keeps the C ABI's bounded default window and `0`
/// stays a non-blocking poll.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcSshChannelRead(
    env: &mut JNIEnv,
    _class: JClass,
    json: JString,
) -> jstring {
    channel_shim(env, json, |session_id, channel_id, payload| {
        crate::cabi::gc_ssh_channel_read(session_id, channel_id, payload)
    })
}

/// `gc_ssh_channel_close(session_id, channel_id)` from one Kotlin document
/// `{"sessionId":N,"channelId":M}`; the document's remaining fields are unused.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcSshChannelClose(
    env: &mut JNIEnv,
    _class: JClass,
    json: JString,
) -> jstring {
    channel_shim(env, json, |session_id, channel_id, _payload| {
        crate::cabi::gc_ssh_channel_close(session_id, channel_id)
    })
}

/// `gc_provision_step(session_id, step_json)`: Kotlin passes one JSON document
/// `{"sessionId":N, ...step}`; this shim splits the handle out and forwards.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcProvisionStep(
    env: &mut JNIEnv,
    _class: JClass,
    json: JString,
) -> jstring {
    let input = from_jstring(env, &json);
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
                Ok(step) => catch_unwind(AssertUnwindSafe(|| crate::cabi::gc_provision_step(session_id, step.as_ptr())))
                    .unwrap_or_else(|_| panic_envelope()),
                Err(_) => panic_envelope(),
            }
        }
        Err(_) => panic_envelope(),
    };
    pointer_to_jstring(env, raw)
}

/// `gc_device_key_generate()` takes no input on the Rust side; Kotlin passes a
/// JSON document for future options, ignored here.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcDeviceKeyGenerate(
    env: &mut JNIEnv,
    _class: JClass,
    _json: JString,
) -> jstring {
    let raw = catch_unwind(AssertUnwindSafe(|| crate::cabi::gc_device_key_generate())).unwrap_or_else(|_| panic_envelope());
    pointer_to_jstring(env, raw)
}

/// Compatibility no-op: the shim frees every returned string immediately, so nothing to release.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_gentlemovil_core_GcNative_gcFree(
    _env: &mut JNIEnv,
    _class: JClass,
    pointer: jlong,
) {
    // The shim already frees after each call; gcFree stays a no-op for API
    // compatibility with the Kotlin contract, accepting any value.
}
