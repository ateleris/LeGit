//! Parser for `git rev-list --left-right --count <upstream>...HEAD`, backing
//! the ahead/behind tracking status.
//!
//! The format string lives here next to the parser so the contract is visible
//! in one place (DESIGN-v0.3.md §4.5).

/// `git rev-list --left-right --count <upstream>...HEAD` prints two integers —
/// the left side (commits in `<upstream>` not in HEAD = **behind**) then the
/// right side (commits in HEAD not in `<upstream>` = **ahead**) — separated by
/// whitespace (a tab in practice). Returns `(behind, ahead)`, or `None` if the
/// output isn't the expected two-number shape.
pub fn parse_rev_list_counts(output: &str) -> Option<(u32, u32)> {
    let mut nums = output.split_whitespace();
    let behind = nums.next()?.parse::<u32>().ok()?;
    let ahead = nums.next()?.parse::<u32>().ok()?;
    Some((behind, ahead))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tab_separated_counts() {
        assert_eq!(parse_rev_list_counts("2\t3"), Some((2, 3)));
    }

    #[test]
    fn parses_with_trailing_newline_and_spaces() {
        assert_eq!(parse_rev_list_counts("0\t0\n"), Some((0, 0)));
        assert_eq!(parse_rev_list_counts(" 5  7 "), Some((5, 7)));
    }

    #[test]
    fn rejects_malformed() {
        assert_eq!(parse_rev_list_counts(""), None);
        assert_eq!(parse_rev_list_counts("3"), None);
        assert_eq!(parse_rev_list_counts("a\tb"), None);
    }
}
