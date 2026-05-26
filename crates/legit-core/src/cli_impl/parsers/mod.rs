//! Pure parsers: `text -> domain type` (DESIGN.md §4.3).
//!
//! Each parser lives next to the backend method that produces its input.
//! v0.1 ships no real parsers; the Console panel does not need structured
//! data. v1 adds modules `status`, `log`, `diff`, `branches`, … here.
