//! Platform-independent logic for Follow Analyser.
//!
//! Nothing in this crate knows about Tauri, windows or web views, so all of it
//! is tested with plain `cargo test` and is shared by every platform build.
//!
//! - [`username`]: validating Instagram usernames and pulling them out of links.
//! - [`analysis`]: one completed scan, and the comparison between its two lists.
//! - [`scan`]: the state machine that tells the injected page script what to do.
//! - [`store`]: saving scans to disk as JSON snapshots and reading them back.
//! - [`csv`]: CSV export with the same columns as the browser extension.

pub mod analysis;
pub mod csv;
pub mod scan;
pub mod store;
pub mod username;

pub use analysis::{Analysis, Changes, ListKind, Report};
pub use scan::{ScanError, ScanSession, Status, Task};
pub use store::SnapshotStore;
