//! Pure parsers: `text -> domain type` (DESIGN.md §4.3).
//!
//! Each parser lives next to the backend method that produces its input.
//! The format string for each command is a constant in the same module as
//! the parser, so the contract is visible in one place (DESIGN-v0.3.md §4.5).

pub mod log;
pub mod commit;
pub mod branches;
pub mod status;
