//! Sandboxed device file access for local mode: `fs_list` and `fs_read` (`T14`/`T18`).
//!
//! ## Why this module exists
//!
//! The local editor and the local-projects screen read the phone's own files. Before this
//! module the crate had **no** `std::fs` usage at all, so the app could only say "no fs FFI
//! yet". Everything here is read-only: nothing writes, moves or deletes.
//!
//! ## The two functions
//!
//! * [`list`] — one level of a directory, directories first and then by name, with
//!   `size` only for regular files (`None` elsewhere, never an estimate).
//! * [`read_text`] — a file as UTF-8 text, capped in bytes, with the **real** size always
//!   reported so the UI can say how much it is not showing.
//!
//! ## Path rules (the security boundary)
//!
//! A caller names two things: the `root` it is allowed to touch (the app's private
//! directory, a picked folder, …) and a `path` **relative** to that root. The relative
//! path is refused when it
//!
//! * is absolute (`/etc/passwd`, `C:\…`),
//! * has an empty segment (`a//b`, `a/`), or
//! * carries a `..` component.
//!
//! The `root` itself must be an **absolute** path ([`CoreError::InvalidPath`] otherwise,
//! never [`CoreError::NotFound`]). This is not a formality: a relative root is resolved
//! against the process working directory, which on Android is `/`, so `root: "etc"` would
//! read `/etc` instead of anything the app owns. The root is caller-declared, so the type
//! of the value is the only thing this module can check — the Android allowlist lives in
//! the native shell.
//!
//! The resolved path is then canonicalized and re-checked against the canonical root, so a
//! **symlink inside the root that points outside it** is refused as well — the check is on
//! the final target, not on the spelling. A path that leaves the root never reaches the
//! filesystem read.
//!
//! ## The descriptor is the authority
//!
//! Canonicalizing is only a **pre-filter**: between it and the open the path can be
//! replaced (a shared or FUSE root makes that reachable), and the open follows whatever is
//! there at that moment. So after opening, and **before a single byte is read**, the
//! descriptor is resolved through `/proc/self/fd/<fd>` and must still start with the
//! canonical root; the open also uses `O_NOFOLLOW | O_NONBLOCK` so a path swapped to a
//! symlink fails instead of escaping and a path swapped to a FIFO fails instead of
//! blocking. The descriptor check is the guarantee; the canonicalize is the cheap refusal
//! that keeps the common case out of the syscall path. `/proc` only exists on Linux and
//! Android, so on other platforms the canonicalize stays the only containment check.
//!
//! ## Only regular files are opened
//!
//! A directory, a FIFO, a socket, a character or block device is refused with
//! [`CoreError::Io`] naming its kind (`"pipe is a FIFO, not a regular file"`) instead of
//! being opened: opening a FIFO with no writer blocks the calling thread forever, and this
//! crate is called from Expo's single native queue — one wedged call would wedge the whole
//! bridge. `O_NONBLOCK` closes the race where the file is swapped for a FIFO after the
//! metadata check.
//!
//! ## Caps
//!
//! Reading is bounded twice, and both limits are visible in the answer:
//!
//! * `max_bytes` — how much text the caller wants. A bigger file is **truncated**
//!   (`truncated: true`) with the real `size`, because an editor showing the first part is
//!   honest; a silent empty answer would not be.
//! * [`HARD_MAX_BYTES`] — the absolute cap. A file past it answers
//!   [`CoreError::TooLarge`] with its real size, because no window of it is a plausible
//!   editor buffer.
//!
//! `max_entries` is clamped to [`HARD_MAX_ENTRIES`] and a listing that hits its window
//! reports `truncated: true`. The directory is read only until one entry past the window
//! exists: the rest of it is never materialised, so a directory of a million entries costs
//! a window plus one, not a million.
//!
//! ## Binary files
//!
//! A file with a NUL byte or invalid UTF-8 answers [`CoreError::Binary`]; content is
//! **never** lossy-decoded, so the editor cannot silently corrupt a binary file by saving
//! back what a replacement-character decode produced. When the cap cuts the file in the
//! middle of a multi-byte character, the incomplete tail is dropped instead of being
//! reported as binary.

use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::CoreError;

/// Entries returned when the caller names no `maxEntries` (the bridge's own cut).
pub const DEFAULT_MAX_ENTRIES: usize = 500;
/// Absolute cap on a listing, so one directory can never exhaust the phone's memory.
pub const HARD_MAX_ENTRIES: usize = 5_000;
/// Bytes returned when the caller names no `maxBytes` (`docs/mobile-protocol-spec.md` §4.1).
pub const DEFAULT_MAX_BYTES: u64 = 512 * 1024;
/// Absolute cap on a read. Past this the file is [`CoreError::TooLarge`], never truncated.
pub const HARD_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// What a directory entry is, as far as the app can use it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FsKind {
    /// A regular file.
    File,
    /// A directory.
    Dir,
}

impl FsKind {
    /// Stable lowercase name the ABI envelope and the TypeScript contract use.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Dir => "dir",
        }
    }
}

/// One directory entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FsEntry {
    /// Path **relative to the root**, with `/` separators.
    pub path: String,
    /// Size in bytes; only regular files have one, everything else is `null`.
    pub size: Option<u64>,
    /// Whether the entry is a file or a directory.
    pub kind: FsKind,
}

/// Result of [`list`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FsListing {
    /// The entries, directories first and then by name.
    pub entries: Vec<FsEntry>,
    /// True when the directory held more entries than the window allowed.
    pub truncated: bool,
}

/// Result of [`read_text`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FsRead {
    /// Path **relative to the root**, with `/` separators.
    pub path: String,
    /// The text, never lossy-decoded.
    pub text: String,
    /// Real size of the file in bytes (not the size of `text`).
    pub size: u64,
    /// True when `text` is only the first `max_bytes` bytes of a bigger file.
    pub truncated: bool,
}

/// List one level of `rel` inside `root`.
///
/// `rel` is the empty string for the root itself. Directories come first, then names in
/// ascending order, and the window is `max_entries` (clamped to `1..=HARD_MAX_ENTRIES`).
pub fn list(root: &Path, rel: &str, max_entries: usize) -> Result<FsListing, CoreError> {
    let window = max_entries.clamp(1, HARD_MAX_ENTRIES);
    let (_, target, label) = resolve(root, rel)?;

    let read_dir = fs::read_dir(&target).map_err(|error| map_io_error(&label, error))?;
    // One entry past the window is all it takes to know the directory holds more, so the
    // listing stops reading there instead of materialising a whole directory and then
    // throwing most of it away.
    let mut entries: Vec<FsEntry> = Vec::new();
    let mut truncated = false;
    for item in read_dir {
        let item = item.map_err(|error| map_io_error(&label, error))?;
        let name = item.file_name().to_string_lossy().into_owned();
        let absolute = item.path();
        let Some(kind) = entry_kind(&absolute) else {
            // A socket, a device or a dangling symlink: the app cannot open it, so it is
            // not listed instead of being shown as something it is not.
            continue;
        };
        let size = match kind {
            FsKind::File => fs::metadata(&absolute).ok().map(|meta| meta.len()),
            FsKind::Dir => None,
        };
        entries.push(FsEntry {
            path: join_rel(&label, &name),
            size,
            kind,
        });
        #[cfg(test)]
        count_collected_entry();
        if entries.len() > window {
            truncated = true;
            break;
        }
    }

    // Directories first, then by name — the order `docs/mobile-protocol-spec.md` §4.1 fixes.
    // Every entry of one listing shares the same relative prefix, so ordering by the
    // published `path` is ordering by name.
    entries.sort_by(|left, right| {
        let left_dir = left.kind == FsKind::Dir;
        let right_dir = right.kind == FsKind::Dir;
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.path.cmp(&right.path))
    });
    entries.truncate(window);
    Ok(FsListing { entries, truncated })
}

/// Read `rel` inside `root` as UTF-8 text, at most `max_bytes` bytes of it.
///
/// A file bigger than `max_bytes` is truncated (the real size travels in `size`); a file
/// past [`HARD_MAX_BYTES`] is [`CoreError::TooLarge`]. Binary content is
/// [`CoreError::Binary`], never lossy-decoded.
pub fn read_text(root: &Path, rel: &str, max_bytes: u64) -> Result<FsRead, CoreError> {
    let window = max_bytes.clamp(1, HARD_MAX_BYTES);
    let (canonical_root, target, label) = resolve(root, rel)?;
    let file = open_regular_file(&canonical_root, &target, &label)?;

    // The descriptor is the authority from here on: the size comes from it, not from a
    // path that could have been replaced between the canonicalize and the open.
    let size = file
        .metadata()
        .map_err(|error| map_io_error(&label, error))?
        .len();
    if size > HARD_MAX_BYTES {
        return Err(CoreError::too_large(label, size, HARD_MAX_BYTES));
    }

    let mut bytes = Vec::with_capacity(size.min(window) as usize);
    let mut handle = file.take(window);
    handle
        .read_to_end(&mut bytes)
        .map_err(|error| map_io_error(&label, error))?;

    let truncated = size > bytes.len() as u64;
    let text = decode_text(&bytes, truncated, &label)?;
    Ok(FsRead {
        path: label,
        text,
        size,
        truncated,
    })
}

/// Open `target` as a regular file inside `canonical_root`, or refuse it by name.
///
/// The metadata check names what the path really is (a directory, a FIFO, a device, a
/// socket), the open uses `O_NOFOLLOW | O_NONBLOCK`, and the opened descriptor is verified
/// against the root before a byte is read — the three defects this closes: a directory that
/// was only checked for being a directory, a FIFO that blocked the native queue, and a path
/// swapped after the canonicalize.
fn open_regular_file(
    canonical_root: &Path,
    target: &Path,
    label: &str,
) -> Result<fs::File, CoreError> {
    let metadata = fs::metadata(target).map_err(|error| map_io_error(label, error))?;
    if !metadata.is_file() {
        let message = match describe_kind(&metadata) {
            Some(kind) => format!("{label} is {kind}, not a regular file"),
            None => format!("{label} is not a regular file"),
        };
        return Err(CoreError::Io(std::io::Error::other(message)));
    }
    let file = open_without_following(target).map_err(|error| map_open_error(label, error))?;
    verify_descriptor_inside(&file, canonical_root, label)?;
    Ok(file)
}

/// What `metadata` describes, in the words the refusal uses.
///
/// `None` is the (unrepresentable in practice) "not a file, not any known special kind";
/// the caller then says only that it is not a regular file.
fn describe_kind(metadata: &fs::Metadata) -> Option<&'static str> {
    let file_type = metadata.file_type();
    if file_type.is_dir() {
        return Some("a directory");
    }
    if file_type.is_symlink() {
        return Some("a symbolic link");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        if file_type.is_fifo() {
            return Some("a FIFO");
        }
        if file_type.is_socket() {
            return Some("a socket");
        }
        if file_type.is_char_device() {
            return Some("a character device");
        }
        if file_type.is_block_device() {
            return Some("a block device");
        }
    }
    None
}

/// Open `target` read-only without following a final symlink and without blocking.
///
/// `O_NOFOLLOW` turns a path that was swapped to a symlink after the canonicalize into an
/// error instead of a read outside the root; `O_NONBLOCK` means a path swapped to a FIFO
/// returns immediately instead of waiting for a writer that may never come (the read of a
/// regular file is unaffected by the flag).
fn open_without_following(target: &Path) -> std::io::Result<fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = fs::OpenOptions::new();
        options.read(true);
        if let Some(flags) = no_follow_nonblock_flags() {
            options.custom_flags(flags);
        }
        options.open(target)
    }
    #[cfg(not(unix))]
    {
        fs::File::open(target)
    }
}

/// `O_NOFOLLOW | O_NONBLOCK` for the platforms this crate targets.
///
/// The numbers come from `asm-generic/fcntl.h` (Linux, and therefore Android: `O_NOFOLLOW`
/// is `0o400000`, `O_NONBLOCK` is `0o4000`) and from the XNU `fcntl.h` shared by macOS and
/// iOS (`0x0100` and `0x0004`). `std` exposes `OpenOptionsExt::custom_flags` but no flag
/// constants, and this crate takes no dependency for two numbers; an unrecognised unix
/// answers `None`, where the metadata check and the descriptor check still apply.
#[cfg(any(target_os = "linux", target_os = "android"))]
const fn no_follow_nonblock_flags() -> Option<i32> {
    Some(0o400000 | 0o4000)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
const fn no_follow_nonblock_flags() -> Option<i32> {
    Some(0x0100 | 0x0004)
}

#[cfg(all(
    unix,
    not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    ))
))]
const fn no_follow_nonblock_flags() -> Option<i32> {
    None
}

/// `ELOOP` for the platforms above: what `O_NOFOLLOW` reports for a symlink.
#[cfg(any(target_os = "linux", target_os = "android"))]
const fn loop_errno() -> Option<i32> {
    Some(40)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
const fn loop_errno() -> Option<i32> {
    Some(62)
}

#[cfg(all(
    unix,
    not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    ))
))]
const fn loop_errno() -> Option<i32> {
    None
}

/// Prove the **opened descriptor** is inside `canonical_root` before a byte is read.
///
/// The canonicalize in [`resolve`] is a pre-filter: the path can be replaced between it and
/// the open, and the open then follows whatever is there. Resolving `/proc/self/fd/<fd>`
/// asks the descriptor itself what it was opened on, which is the containment guarantee.
/// `/proc` only exists on Linux and Android; elsewhere the canonicalize pre-filter is what
/// remains, and that limit is documented in the module docs.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn verify_descriptor_inside(
    file: &fs::File,
    canonical_root: &Path,
    label: &str,
) -> Result<(), CoreError> {
    use std::os::unix::io::AsRawFd;
    let link = PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()));
    let opened = fs::read_link(&link).map_err(|error| {
        CoreError::Io(std::io::Error::other(format!(
            "cannot resolve the opened descriptor of {label}: {error}"
        )))
    })?;
    if !opened.starts_with(canonical_root) {
        // The descriptor is not inside the root the caller allowed: the path changed
        // between the canonicalize and the open.
        return Err(CoreError::outside_root(label));
    }
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn verify_descriptor_inside(
    _file: &fs::File,
    _canonical_root: &Path,
    _label: &str,
) -> Result<(), CoreError> {
    Ok(())
}

/// Map an open failure onto the typed errors, keeping a refused symlink an escape.
fn map_open_error(label: &str, error: std::io::Error) -> CoreError {
    if loop_errno().is_some() && error.raw_os_error() == loop_errno() {
        // `O_NOFOLLOW` refused a final component that became a symlink: the path the caller
        // named is no longer the file the canonicalize checked.
        return CoreError::outside_root(label);
    }
    map_io_error(label, error)
}

/// Decode the bytes actually read as UTF-8 text, or refuse the file.
///
/// A trailing incomplete multi-byte sequence is dropped when — and only when — the read
/// was cut by the cap; otherwise it is binary content like any other invalid byte.
fn decode_text(bytes: &[u8], truncated: bool, label: &str) -> Result<String, CoreError> {
    if bytes.contains(&0) {
        return Err(CoreError::binary(label));
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok(text.to_string()),
        Err(error) if truncated && error.error_len().is_none() => {
            let prefix = &bytes[..error.valid_up_to()];
            std::str::from_utf8(prefix)
                .map(str::to_string)
                .map_err(|_| CoreError::binary(label))
        }
        Err(_) => Err(CoreError::binary(label)),
    }
}

/// Kind of one path, following symlinks; `None` when the app could not open it at all.
fn entry_kind(absolute: &Path) -> Option<FsKind> {
    let metadata = fs::metadata(absolute).ok()?;
    if metadata.is_dir() {
        Some(FsKind::Dir)
    } else if metadata.is_file() {
        Some(FsKind::File)
    } else {
        None
    }
}

/// Resolve `rel` inside `root`, enforcing every path rule of the module docs.
///
/// Returns `(canonical root, canonical target, label)` where `label` is the relative path
/// in `/` form (`""` for the root itself) — that label is what the answer and the errors
/// carry, so no absolute device path leaks into the UI.
fn resolve(root: &Path, rel: &str) -> Result<(PathBuf, PathBuf, String), CoreError> {
    // SEC-003: the root is caller-declared, so the only thing this module can check is that
    // it is an absolute path. A relative one resolves against the process working directory
    // (`/` on Android), where `root: "etc"` would read `/etc`.
    if !root.is_absolute() {
        return Err(CoreError::invalid_path(format!(
            "the root {root:?} must be an absolute path; a relative root resolves against the process working directory"
        )));
    }
    let relative = normalize_relative(rel)?;
    let label = join_rel("", &relative.to_string_lossy());
    let canonical_root = fs::canonicalize(root).map_err(|error| map_io_error(&label, error))?;
    let target = if relative.as_os_str().is_empty() {
        canonical_root.clone()
    } else {
        canonical_root.join(&relative)
    };
    let resolved = fs::canonicalize(&target).map_err(|error| map_io_error(&label, error))?;
    if !resolved.starts_with(&canonical_root) {
        // A symlink inside the root pointing outside it, or a root that is itself a
        // symlink into a different tree: the final target decides, never the spelling.
        return Err(CoreError::outside_root(label));
    }
    Ok((canonical_root, resolved, label))
}

/// Validate and normalize a caller-supplied relative path.
///
/// Empty segments, `..` and anything absolute are refused by name; `.` segments are
/// dropped because they cannot change the meaning of the path.
fn normalize_relative(rel: &str) -> Result<PathBuf, CoreError> {
    if rel.is_empty() {
        return Ok(PathBuf::new());
    }
    for segment in rel.split(['/', '\\']) {
        if segment.is_empty() {
            return Err(CoreError::invalid_path(format!(
                "{rel:?} has an empty path segment"
            )));
        }
        if segment == ".." {
            return Err(CoreError::invalid_path(format!(
                "{rel:?} walks upwards with a '..' component"
            )));
        }
    }
    let path = Path::new(rel);
    if path.is_absolute() {
        return Err(CoreError::invalid_path(format!(
            "{rel:?} is absolute; the path must be relative to the root"
        )));
    }
    // A Windows drive prefix (`C:…`) is absolute on Windows and a meaningless file name
    // here, so it is refused on every platform instead of quietly resolving inside the
    // root on the phone.
    if let Some(first) = rel.split(['/', '\\']).next() {
        let bytes = first.as_bytes();
        if bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            return Err(CoreError::invalid_path(format!(
                "{rel:?} is absolute; the path must be relative to the root"
            )));
        }
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(CoreError::invalid_path(format!(
                    "{rel:?} walks upwards with a '..' component"
                )))
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(CoreError::invalid_path(format!(
                    "{rel:?} is absolute; the path must be relative to the root"
                )))
            }
        }
    }
    Ok(out)
}

/// Join a relative prefix and one name with `/`, collapsing the empty prefix.
fn join_rel(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else if name.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

/// Map an operating-system error onto the typed errors of this module.
fn map_io_error(label: &str, error: std::io::Error) -> CoreError {
    match error.kind() {
        ErrorKind::NotFound => CoreError::not_found(label),
        ErrorKind::PermissionDenied => CoreError::permission_denied(label),
        _ => CoreError::Io(error),
    }
}

#[cfg(test)]
thread_local! {
    /// Test-only bounded-work probe: how many directory entries the listing calls on this
    /// thread have collected. Production builds carry none of it.
    static COLLECTED_ENTRIES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Count one collected entry against the test-only probe.
#[cfg(test)]
fn count_collected_entry() {
    COLLECTED_ENTRIES.with(|count| count.set(count.get() + 1));
}

/// Reset the test-only probe for this thread.
#[cfg(test)]
fn reset_collected_entries() {
    COLLECTED_ENTRIES.with(|count| count.set(0));
}

/// Entries collected since the last [`reset_collected_entries`] on this thread.
#[cfg(test)]
fn collected_entries() -> usize {
    COLLECTED_ENTRIES.with(|count| count.get())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A throwaway directory outside the repository, removed when the test ends.
    struct Sandbox {
        root: PathBuf,
    }

    impl Sandbox {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(1);
            let unique = format!(
                "mobile-core-fs-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            );
            let root = std::env::temp_dir().join(unique);
            fs::create_dir_all(&root).expect("sandbox");
            Self { root }
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.root.join(rel)
        }

        fn file(&self, rel: &str, bytes: &[u8]) -> PathBuf {
            let path = self.path(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("parent dir");
            }
            let mut file = fs::File::create(&path).expect("create");
            file.write_all(bytes).expect("write");
            path
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn list_returns_directories_first_then_names() {
        let sandbox = Sandbox::new();
        sandbox.file("zeta.txt", b"z");
        sandbox.file("alpha.txt", b"a");
        sandbox.file("src/main.rs", b"fn main() {}\n");
        fs::create_dir_all(sandbox.path("docs")).expect("docs");

        let listing = list(&sandbox.root, "", DEFAULT_MAX_ENTRIES).expect("listing");
        assert!(!listing.truncated);
        let names: Vec<&str> = listing
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        assert_eq!(names, vec!["docs", "src", "alpha.txt", "zeta.txt"]);

        let docs = &listing.entries[0];
        assert_eq!(docs.kind, FsKind::Dir);
        assert_eq!(docs.size, None, "a directory has no size of its own");
        let alpha = &listing.entries[2];
        assert_eq!(alpha.kind, FsKind::File);
        assert_eq!(alpha.size, Some(1));
        // Relative paths only: the absolute device path never leaks into the answer.
        assert!(!alpha.path.contains(&*sandbox.root.to_string_lossy()));

        let nested = list(&sandbox.root, "src", DEFAULT_MAX_ENTRIES).expect("nested listing");
        assert_eq!(nested.entries.len(), 1);
        assert_eq!(nested.entries[0].path, "src/main.rs");
    }

    #[test]
    fn list_reports_that_it_cut_the_window() {
        let sandbox = Sandbox::new();
        for index in 0..5 {
            sandbox.file(&format!("file{index}.txt"), b"x");
        }
        let listing = list(&sandbox.root, "", 2).expect("listing");
        assert_eq!(listing.entries.len(), 2);
        assert!(listing.truncated);

        // A zero window is still one entry, never an empty lie about the directory.
        let single = list(&sandbox.root, "", 0).expect("listing");
        assert_eq!(single.entries.len(), 1);
        assert!(single.truncated);
    }

    #[test]
    fn read_returns_the_text_and_the_real_size() {
        let sandbox = Sandbox::new();
        sandbox.file("src/a.ts", "export const é = 1;\n".as_bytes());

        let read = read_text(&sandbox.root, "src/a.ts", DEFAULT_MAX_BYTES).expect("read");
        assert_eq!(read.path, "src/a.ts");
        assert_eq!(read.text, "export const é = 1;\n");
        assert_eq!(read.size, "export const é = 1;\n".len() as u64);
        assert!(!read.truncated);
    }

    #[test]
    fn read_truncates_at_the_window_and_reports_the_real_size() {
        let sandbox = Sandbox::new();
        sandbox.file("big.txt", &[b'a'; 100]);

        let read = read_text(&sandbox.root, "big.txt", 10).expect("read");
        assert_eq!(read.text, "aaaaaaaaaa");
        assert_eq!(
            read.size, 100,
            "the real size is reported, not the read one"
        );
        assert!(read.truncated);
    }

    #[test]
    fn read_drops_an_incomplete_character_at_the_truncation_edge() {
        let sandbox = Sandbox::new();
        // "é" is two bytes, so a two-byte window cuts it in half.
        sandbox.file("unicode.txt", "éé".as_bytes());
        let read = read_text(&sandbox.root, "unicode.txt", 3).expect("read");
        assert_eq!(read.text, "é");
        assert!(read.truncated);
        assert_eq!(read.size, 4);
    }

    #[test]
    fn read_refuses_a_file_past_the_hard_cap_with_its_real_size() {
        let sandbox = Sandbox::new();
        let path = sandbox.file("huge.txt", b"");
        // Sparse file: the size is real without writing eight megabytes.
        let file = fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("open");
        file.set_len(HARD_MAX_BYTES + 1).expect("set_len");
        drop(file);

        let error = read_text(&sandbox.root, "huge.txt", HARD_MAX_BYTES).expect_err("too large");
        assert_eq!(error.kind(), "too_large");
        assert_eq!(
            error.to_string(),
            format!(
                "file too large: huge.txt is {} bytes (limit {HARD_MAX_BYTES})",
                HARD_MAX_BYTES + 1
            )
        );
    }

    #[test]
    fn read_refuses_binary_content_instead_of_lossy_decoding_it() {
        let sandbox = Sandbox::new();
        sandbox.file("nul.txt", b"before\0after");
        sandbox.file("bad.txt", &[0xff, 0xfe, b'a']);
        sandbox.file("good.txt", "texto ✅".as_bytes());

        for rel in ["nul.txt", "bad.txt"] {
            let error = read_text(&sandbox.root, rel, DEFAULT_MAX_BYTES).expect_err("binary");
            assert_eq!(error.kind(), "binary", "{rel}");
            assert_eq!(error.to_string(), format!("binary file: {rel} is not text"));
        }
        let good = read_text(&sandbox.root, "good.txt", DEFAULT_MAX_BYTES).expect("text");
        assert_eq!(good.text, "texto ✅");
    }

    #[test]
    fn read_refuses_a_directory() {
        let sandbox = Sandbox::new();
        fs::create_dir_all(sandbox.path("src")).expect("src");
        let error = read_text(&sandbox.root, "src", DEFAULT_MAX_BYTES).expect_err("directory");
        assert_eq!(error.kind(), "io");
        assert_eq!(
            error.to_string(),
            "io: src is a directory, not a regular file"
        );
    }

    #[test]
    fn missing_paths_are_not_found() {
        let sandbox = Sandbox::new();
        let error = read_text(&sandbox.root, "nope.txt", DEFAULT_MAX_BYTES).expect_err("missing");
        assert_eq!(error.kind(), "not_found");
        assert_eq!(error.to_string(), "not found: nope.txt");

        let listing = list(&sandbox.root, "nope", DEFAULT_MAX_ENTRIES).expect_err("missing dir");
        assert_eq!(listing.kind(), "not_found");
    }

    #[test]
    fn traversal_and_absolute_paths_are_refused_before_touching_the_filesystem() {
        let sandbox = Sandbox::new();
        sandbox.file("inside.txt", b"ok");

        for rel in ["../outside.txt", "src/../../outside.txt", "a/../../b"] {
            let error = read_text(&sandbox.root, rel, DEFAULT_MAX_BYTES).expect_err("traversal");
            assert_eq!(error.kind(), "invalid_path", "{rel}");
            assert!(
                error.to_string().contains("walks upwards"),
                "{rel}: {error}"
            );
        }
        for rel in ["/etc/passwd", "/", "C:\\Windows\\system32"] {
            let error = read_text(&sandbox.root, rel, DEFAULT_MAX_BYTES).expect_err("absolute");
            assert_eq!(error.kind(), "invalid_path", "{rel}");
        }
        for rel in ["a//b", "src/", "\\etc"] {
            let error =
                read_text(&sandbox.root, rel, DEFAULT_MAX_BYTES).expect_err("empty segment");
            assert_eq!(error.kind(), "invalid_path", "{rel}");
            assert!(
                error.to_string().contains("empty path segment"),
                "{rel}: {error}"
            );
        }

        // The listing refuses the same spellings.
        for rel in ["..", "/", "a//b"] {
            let error = list(&sandbox.root, rel, DEFAULT_MAX_ENTRIES).expect_err("refused");
            assert_eq!(error.kind(), "invalid_path", "{rel}");
        }
        // And a `.` segment is harmless.
        assert_eq!(
            read_text(&sandbox.root, "./inside.txt", DEFAULT_MAX_BYTES)
                .expect("dot segment")
                .text,
            "ok"
        );
    }

    #[test]
    fn a_symlink_that_leaves_the_root_is_refused() {
        let sandbox = Sandbox::new();
        let outside = Sandbox::new();
        outside.file("secret.txt", b"top secret");
        sandbox.file("inside.txt", b"ok");

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(outside.path("secret.txt"), sandbox.path("escape.txt")).expect("symlink");
            symlink(&outside.root, sandbox.path("escape-dir")).expect("symlink dir");
        }
        #[cfg(not(unix))]
        {
            // Windows needs privileges for symlinks; the refusal itself is what is asserted,
            // and without a link the test simply has nothing to escape through.
            if std::os::windows::fs::symlink_file(
                outside.path("secret.txt"),
                sandbox.path("escape.txt"),
            )
            .is_err()
            {
                return;
            }
            let _ = std::os::windows::fs::symlink_dir(&outside.root, sandbox.path("escape-dir"));
        }

        let error = read_text(&sandbox.root, "escape.txt", DEFAULT_MAX_BYTES).expect_err("escape");
        assert_eq!(error.kind(), "outside_root");
        assert_eq!(error.to_string(), "path outside root: escape.txt");
        // The bytes really were not read: the error came from the check, and the same
        // file is still readable through its own root.
        assert_eq!(
            read_text(&outside.root, "secret.txt", DEFAULT_MAX_BYTES)
                .expect("own root")
                .text,
            "top secret"
        );

        let error = list(&sandbox.root, "escape-dir", DEFAULT_MAX_ENTRIES).expect_err("escape dir");
        assert_eq!(error.kind(), "outside_root");

        // The listing still shows the symlink by the kind of its target: opening it is
        // where the escape check happens, and the listing is one level only.
        let listing = list(&sandbox.root, "", DEFAULT_MAX_ENTRIES).expect("listing");
        let escape = listing
            .entries
            .iter()
            .find(|entry| entry.path == "escape.txt")
            .expect("the symlink is listed");
        assert_eq!(escape.kind, FsKind::File);
        assert_eq!(escape.size, Some(10));
    }

    #[test]
    fn a_permission_denied_directory_is_reported_as_such() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Running as root defeats `mode(0o000)`; skip instead of asserting a lie.
            if effective_uid() == 0 {
                return;
            }
            let sandbox = Sandbox::new();
            let locked = sandbox.path("locked");
            fs::create_dir_all(&locked).expect("locked");
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).expect("chmod");
            let error = list(&sandbox.root, "locked", DEFAULT_MAX_ENTRIES).expect_err("denied");
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).expect("chmod back");
            assert_eq!(error.kind(), "permission_denied");
            assert_eq!(error.to_string(), "permission denied: locked");
        }
    }

    /// Effective uid, read from `/proc` so the test needs no libc dependency.
    ///
    /// The crate denies `unsafe_code` (only [`crate::cabi`] opts in), so `geteuid()` is out
    /// of reach; Linux — the target platform — publishes the same value in
    /// `/proc/self/status`. Anywhere it cannot be read, the test assumes "not root".
    #[cfg(unix)]
    fn effective_uid() -> u32 {
        // `/proc/self/status` carries the effective uid on Linux, which is the target
        // platform of this crate; elsewhere this reports "not root" (0).
        fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| {
                status
                    .lines()
                    .find(|line| line.starts_with("Uid:"))
                    .and_then(|line| line.split_whitespace().nth(2))
                    .and_then(|uid| uid.parse().ok())
            })
            .unwrap_or(0)
    }

    /// Entries `list` collected on this thread since the last reset.
    fn collected() -> usize {
        super::collected_entries()
    }

    fn reset_collected() {
        super::reset_collected_entries();
    }

    /// A FIFO at `path`, or `false` when the tool that creates one is unavailable.
    #[cfg(unix)]
    fn make_fifo(path: &Path) -> bool {
        std::process::Command::new("mkfifo")
            .arg(path)
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    // ----------------------------------------------------------------------
    // SEC-003: the root is caller-declared, so a relative one is refused
    // ----------------------------------------------------------------------

    #[test]
    fn a_relative_or_empty_root_is_refused_with_a_typed_invalid_path() {
        // `root: "etc"` used to canonicalize against the process working directory (`/` on
        // Android), so it read `/etc` instead of anything the app owns.
        for root in ["etc", "", ".", "./tmp", "../tmp", "etc/passwd"] {
            let error = read_text(Path::new(root), "passwd", DEFAULT_MAX_BYTES)
                .expect_err("a relative root must never be resolved");
            assert_eq!(error.kind(), "invalid_path", "root {root:?}: {error}");
            assert!(
                error.to_string().contains("must be an absolute path"),
                "root {root:?}: {error}"
            );

            let listing = list(Path::new(root), "", DEFAULT_MAX_ENTRIES)
                .expect_err("a relative root must never be listed");
            assert_eq!(listing.kind(), "invalid_path", "root {root:?}");
        }

        // An absolute root still works: the rule refuses spellings, not the feature.
        let sandbox = Sandbox::new();
        sandbox.file("inside.txt", b"ok");
        assert_eq!(
            read_text(&sandbox.root, "inside.txt", DEFAULT_MAX_BYTES)
                .expect("absolute root")
                .text,
            "ok"
        );
    }

    // ----------------------------------------------------------------------
    // SEC-005: a non-regular file must not wedge the single native queue
    // ----------------------------------------------------------------------

    #[test]
    fn a_fifo_is_refused_without_blocking_the_caller() {
        #[cfg(unix)]
        {
            let sandbox = Sandbox::new();
            if !make_fifo(&sandbox.path("pipe")) {
                return;
            }
            // Opening a FIFO with no writer blocks the calling thread forever, which is
            // what used to happen on Expo's single native queue. The read runs on its own
            // thread so a regression fails this test instead of wedging the suite.
            let (sender, receiver) = std::sync::mpsc::channel();
            let root = sandbox.root.clone();
            std::thread::spawn(move || {
                let outcome = read_text(&root, "pipe", DEFAULT_MAX_BYTES)
                    .map(|read| read.text)
                    .map_err(|error| error.to_string());
                let _ = sender.send(outcome);
            });
            let outcome = receiver
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("opening a FIFO must not block the caller");
            assert_eq!(
                outcome.expect_err("a FIFO is not a file an editor can open"),
                "io: pipe is a FIFO, not a regular file"
            );
        }
    }

    #[test]
    fn a_character_device_is_refused_naming_its_kind() {
        #[cfg(unix)]
        {
            if !Path::new("/dev/null").exists() {
                return;
            }
            let error = read_text(Path::new("/dev"), "null", DEFAULT_MAX_BYTES)
                .expect_err("a character device is not a text file");
            assert_eq!(error.kind(), "io");
            assert_eq!(
                error.to_string(),
                "io: null is a character device, not a regular file"
            );
        }
    }

    // ----------------------------------------------------------------------
    // SEC-006: the listing is bounded, not materialise-then-cap
    // ----------------------------------------------------------------------

    #[test]
    fn list_collects_at_most_one_entry_past_its_window() {
        let sandbox = Sandbox::new();
        for index in 0..40 {
            sandbox.file(&format!("f{index:02}.txt"), b"x");
        }

        reset_collected();
        let listing = list(&sandbox.root, "", 3).expect("listing");
        assert_eq!(listing.entries.len(), 3, "the window is honoured");
        assert!(listing.truncated, "one more entry existed");
        assert_eq!(
            collected(),
            4,
            "the listing must stop at window+1 entries instead of materialising the directory"
        );

        // A directory that fits the window is read completely and reports no truncation.
        reset_collected();
        let whole = list(&sandbox.root, "", 40).expect("listing");
        assert_eq!(whole.entries.len(), 40);
        assert!(!whole.truncated);
        assert_eq!(collected(), 40);
    }

    // ----------------------------------------------------------------------
    // SEC-007: the opened descriptor is the containment authority
    // ----------------------------------------------------------------------

    #[test]
    fn the_opened_descriptor_must_be_inside_the_root() {
        let inside = Sandbox::new();
        let outside = Sandbox::new();
        outside.file("secret.txt", b"top secret");
        inside.file("inside.txt", b"ok");

        let file = fs::File::open(outside.path("secret.txt")).expect("open");
        let canonical_inside = fs::canonicalize(&inside.root).expect("root");

        // This is the race the check closes: the descriptor is outside the root even
        // though the path the caller named was not.
        let error = verify_descriptor_inside(&file, &canonical_inside, "secret.txt")
            .expect_err("a descriptor outside the root is refused");
        assert_eq!(error.kind(), "outside_root");
        assert_eq!(error.to_string(), "path outside root: secret.txt");

        // The very same descriptor is fine against its own root, so the check is about
        // containment and not about refusing everything.
        let canonical_outside = fs::canonicalize(&outside.root).expect("root");
        verify_descriptor_inside(&file, &canonical_outside, "secret.txt").expect("own root");
    }

    #[test]
    fn opening_refuses_a_symlink_that_replaced_the_canonical_path() {
        let sandbox = Sandbox::new();
        let outside = Sandbox::new();
        outside.file("secret.txt", b"top secret");

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(outside.path("secret.txt"), sandbox.path("swap.txt")).expect("symlink");

            // `resolve` never hands a symlink to the open, but a swap between the
            // canonicalize and the open is exactly what `O_NOFOLLOW` refuses.
            let error = open_without_following(&sandbox.path("swap.txt"))
                .expect_err("a symlink must not be followed");
            assert_eq!(map_open_error("swap.txt", error).kind(), "outside_root");
        }
    }

    #[test]
    fn the_constants_match_the_documented_protocol_limits() {
        // Constant facts, so they are proven at compile time instead of at run time.
        const _: () = assert!(HARD_MAX_ENTRIES >= DEFAULT_MAX_ENTRIES);
        const _: () = assert!(HARD_MAX_BYTES > DEFAULT_MAX_BYTES);
        assert_eq!(DEFAULT_MAX_ENTRIES, 500);
        assert_eq!(DEFAULT_MAX_BYTES, 512 * 1024);
        assert_eq!(FsKind::File.as_str(), "file");
        assert_eq!(FsKind::Dir.as_str(), "dir");
    }

    #[test]
    fn the_answers_serialize_with_the_field_names_the_abi_publishes() {
        let entry = FsEntry {
            path: "src".to_string(),
            size: None,
            kind: FsKind::Dir,
        };
        assert_eq!(
            serde_json::to_string(&entry).expect("serializes"),
            r#"{"path":"src","size":null,"kind":"dir"}"#
        );
        let read = FsRead {
            path: "a.txt".to_string(),
            text: "hi".to_string(),
            size: 2,
            truncated: false,
        };
        assert_eq!(
            serde_json::to_string(&read).expect("serializes"),
            r#"{"path":"a.txt","text":"hi","size":2,"truncated":false}"#
        );
        let listing = FsListing {
            entries: vec![entry],
            truncated: true,
        };
        assert_eq!(
            serde_json::to_string(&listing).expect("serializes"),
            r#"{"entries":[{"path":"src","size":null,"kind":"dir"}],"truncated":true}"#
        );
    }
}
