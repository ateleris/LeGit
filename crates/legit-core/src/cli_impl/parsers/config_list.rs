//! Parser for `git config <scope> --list -z`, backing the batched
//! global-config snapshot (`config::read_global_snapshot`).
//!
//! The args live here next to the parser so the contract is visible in one
//! place (DESIGN-v0.3.md §4.5).

/// The listing args after `config <scope-flag>`. `-z` terminates each entry
/// with NUL and separates key from value with the FIRST `\n`, so values may
/// contain newlines.
pub const CONFIG_LIST_ARGS: [&str; 2] = ["--list", "-z"];

/// One entry per definition, in file order (duplicates preserved: later
/// entries win for single-valued keys, and multi-valued keys accumulate).
/// `None` is a valueless entry (`[section] key` without `=`, git's implicit
/// true); `Some("")` is an explicitly empty value (`key =`) - the two differ,
/// and e.g. `credential.helper` treats the empty entry as a reset marker.
pub fn parse_config_list_z(output: &str) -> Vec<(String, Option<String>)> {
    output
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .map(|entry| match entry.split_once('\n') {
            Some((key, value)) => (key.to_string(), Some(value.to_string())),
            None => (entry.to_string(), None),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(entries: &[(&str, Option<&str>)]) -> Vec<(String, Option<String>)> {
        entries.iter().map(|(k, v)| (k.to_string(), v.map(str::to_string))).collect()
    }

    #[test]
    fn parses_entries_in_order_keeping_duplicates() {
        let out = "user.name\nAda\0user.multi\na\0user.multi\nb\0";
        assert_eq!(
            parse_config_list_z(out),
            owned(&[("user.name", Some("Ada")), ("user.multi", Some("a")), ("user.multi", Some("b"))])
        );
    }

    #[test]
    fn distinguishes_empty_value_from_valueless_entry() {
        // `credential.helper =` (reset marker) vs `[alias] valueless`.
        let out = "credential.helper\n\0alias.valueless\0";
        assert_eq!(
            parse_config_list_z(out),
            owned(&[("credential.helper", Some("")), ("alias.valueless", None)])
        );
    }

    #[test]
    fn only_the_first_newline_splits_key_from_value() {
        let out = "user.note\nline1\nline2\0";
        assert_eq!(parse_config_list_z(out), owned(&[("user.note", Some("line1\nline2"))]));
    }

    #[test]
    fn empty_output_is_empty() {
        assert_eq!(parse_config_list_z(""), Vec::<(String, Option<String>)>::new());
    }

    #[test]
    fn tolerates_a_missing_trailing_nul() {
        assert_eq!(parse_config_list_z("user.name\nAda"), owned(&[("user.name", Some("Ada"))]));
    }
}
