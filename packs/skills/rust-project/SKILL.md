---
name: rust-project
description: Work in a Rust crate or workspace - cargo check/test/clippy/fmt, fix borrow and lifetime errors, error handling, Arc/Mutex, tokio, features.
source: you
uses: 0
category: Coding
triggers: cargo.toml, cargo build, cargo test, cargo clippy, cargo fmt, borrow checker, cannot borrow as mutable, use of moved value, lifetime error, rust ownership, tokio runtime, anyhow, thiserror, arc mutex, unsafe rust, rust feature flags
---

## When
Any Rust code: binaries, libraries, workspaces. For profiling read performance-profiling; for embedded no_std targets also embedded-firmware.

## Orient
1. code(action="project"); read Cargo.toml ([workspace] members, edition, rust-version, [features], [dev-dependencies]) and rust-toolchain.toml if present.
2. Layout: src/lib.rs (library), src/main.rs and src/bin/*.rs (binaries), tests/ (integration tests, one crate per file), benches/, examples/. Unit tests live in #[cfg(test)] mod tests in the same file.
3. Baseline: cargo check, cargo test, cargo clippy before editing.

## Commands
- Fast feedback: cargo check (--all-targets to include tests).
- Tests: cargo test; by name substring: cargo test parse_header; one integration file: cargo test --test api; one package: cargo test -p core; show prints: cargo test name -- --nocapture.
- Lint: cargo clippy --all-targets --all-features -- -D warnings. Format: cargo fmt --check (cargo fmt to apply).
- Docs: cargo doc --no-deps; doc examples run in cargo test --doc.
- Features: cargo tree -e features; test cargo test --no-default-features and --all-features when touching cfg code.
- SahilBot: code(action="typecheck") runs cargo check, code(action="lint") clippy, code(action="run_tests", filter="parse_header").

## Ownership fixes
- E0382 use of moved value: pass &x, restructure so the move happens last, or clone when ownership really is needed twice (cheap types, Arc).
- E0502/E0499 conflicting borrows: shrink the borrow scope, copy the needed value out first, collect indices or keys then mutate, or split a struct into fields borrowed separately.
- E0106/E0597 lifetimes: first try returning owned data (String, Vec). Annotate only when the compiler asks and the output really borrows from an input: fn first<'a>(s: &'a str) -> &'a str. Structs holding references are usually a design smell; own the data.
- Parameters take &str and &[T]; struct fields own String and Vec<T>.

## Errors
- Libraries: a thiserror enum with #[from] conversions so ? works. Binaries: anyhow::Result plus .context("reading config") at each boundary.
- No unwrap in library paths; expect("reason the invariant holds") is acceptable in tests and truly impossible cases.

## Concurrency and async
- Shared mutable state across threads: Arc<Mutex<T>> or Arc<RwLock<T>>; single thread: Rc<RefCell<T>>. Prefer channels (mpsc) or message passing when it fits.
- Never hold a std MutexGuard across .await; drop it first or use tokio::sync::Mutex.
- tokio: #[tokio::main], #[tokio::test]; tokio::spawn needs Send + 'static (move owned data in); CPU-heavy or blocking calls go in spawn_blocking; std::thread::sleep blocks the runtime, use tokio::time::sleep.

## unsafe policy
Avoid. If required (FFI, proven hot path), keep the block tiny, write a // SAFETY: comment stating the invariant, tell the user, and run cargo +nightly miri test when available.

## Pitfalls
- Integer overflow panics in debug and wraps in release; use checked_/saturating_ ops where it matters.
- s[0..n] slices bytes and panics mid-UTF-8; use chars() or char_indices().
- HashMap iteration order is random; sort before comparing in tests.
- Non-additive features (a feature that removes API) break downstream builds.
- Commit Cargo.lock for binaries; run cargo update only when asked.

## Verify
cargo fmt --check, clippy with -D warnings, targeted cargo test then the full suite all clean. Report commands and results.

## Example
```rust
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("read {path}")]
    Io { path: String, #[source] source: std::io::Error },
    #[error("parse")]
    Parse(#[from] toml::de::Error),
}
```
