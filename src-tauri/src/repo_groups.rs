//! Repo tab groups: the strip's item tree (repos and groups, recursive) and
//! the pure structural logic behind every mutation, lifecycle hook, and the
//! settings-sync projection. See design/2026-10-16-repository-groups.md.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::AppError;

/// Hardcoded build constant, deliberately not a user setting. Mirrored as
/// MAX_GROUP_DEPTH in src/panels/repoTabStrip/stripModel.ts.
pub const MAX_GROUP_DEPTH: usize = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, Default)]
pub struct RepoGroupsDoc {
    pub items: Vec<GroupItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GroupItem {
    Repo(GroupRepoRef),
    Group(RepoGroup),
}

/// At least one of locator/remote_key is Some. locator None = pending member
/// synced from another machine, waiting for a matching repo to open here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct GroupRepoRef {
    pub locator: Option<String>,
    pub remote_key: Option<String>,
    /// Per-repo tab color override (user data, like a group's color).
    /// serde(default) keeps pre-color docs parsing.
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct RepoGroup {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub collapsed: bool,
    pub items: Vec<GroupItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ItemRef {
    Repo { locator: String },
    Group { id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum RepoGroupsOp {
    MergeIntoGroup { dragged: ItemRef, target: ItemRef },
    NewGroupWith { item: ItemRef },
    MoveItem { item: ItemRef, parent: Option<String>, index: u32 },
    Ungroup { group_id: String },
    Rename { group_id: String, name: String },
    SetColor { group_id: String, color: Option<String> },
    SetRepoColor { locator: String, color: Option<String> },
    SetCollapsed { group_id: String, collapsed: bool },
}

fn err(msg: impl Into<String>) -> AppError {
    AppError::Settings(msg.into())
}

fn item_is_ref(item: &GroupItem, r: &ItemRef) -> bool {
    match (item, r) {
        (GroupItem::Repo(gr), ItemRef::Repo { locator }) => gr.locator.as_deref() == Some(locator),
        (GroupItem::Group(g), ItemRef::Group { id }) => &g.id == id,
        _ => false,
    }
}

/// 0 for a repo; 1 + deepest child group level for a group.
fn subtree_group_depth(item: &GroupItem) -> usize {
    match item {
        GroupItem::Repo(_) => 0,
        GroupItem::Group(g) => {
            1 + g.items.iter().map(subtree_group_depth).max().unwrap_or(0)
        }
    }
}

/// Number of ancestor groups above the referenced item (0 = at root).
fn ancestors_of_ref(items: &[GroupItem], r: &ItemRef, depth: usize) -> Option<usize> {
    for it in items {
        if item_is_ref(it, r) {
            return Some(depth);
        }
        if let GroupItem::Group(g) = it {
            if let Some(d) = ancestors_of_ref(&g.items, r, depth + 1) {
                return Some(d);
            }
        }
    }
    None
}

fn remove_ref(items: &mut Vec<GroupItem>, r: &ItemRef) -> Option<GroupItem> {
    if let Some(pos) = items.iter().position(|it| item_is_ref(it, r)) {
        return Some(items.remove(pos));
    }
    for it in items {
        if let GroupItem::Group(g) = it {
            if let Some(found) = remove_ref(&mut g.items, r) {
                return Some(found);
            }
        }
    }
    None
}

/// Replace the referenced item with `wrap(item)` in place.
fn wrap_ref(
    items: &mut Vec<GroupItem>,
    r: &ItemRef,
    wrap: &mut dyn FnMut(GroupItem) -> GroupItem,
) -> bool {
    for i in 0..items.len() {
        if item_is_ref(&items[i], r) {
            let taken = items.remove(i);
            items.insert(i, wrap(taken));
            return true;
        }
        if let GroupItem::Group(g) = &mut items[i] {
            if wrap_ref(&mut g.items, r, wrap) {
                return true;
            }
        }
    }
    false
}

fn find_group_mut<'a>(items: &'a mut [GroupItem], id: &str) -> Option<&'a mut RepoGroup> {
    for it in items {
        if let GroupItem::Group(g) = it {
            if g.id == id {
                return Some(g);
            }
            if let Some(f) = find_group_mut(&mut g.items, id) {
                return Some(f);
            }
        }
    }
    None
}

fn valid_hex_color(s: &str) -> bool {
    match s.strip_prefix('#') {
        Some(h) => {
            matches!(h.len(), 3 | 6 | 8) && h.chars().all(|c| c.is_ascii_hexdigit())
        }
        None => false,
    }
}

fn locators_in(items: &[GroupItem], out: &mut Vec<String>) {
    for it in items {
        match it {
            GroupItem::Repo(r) => {
                if let Some(l) = &r.locator {
                    out.push(l.clone());
                }
            }
            GroupItem::Group(g) => locators_in(&g.items, out),
        }
    }
}

pub fn apply_op(
    doc: &RepoGroupsDoc,
    op: &RepoGroupsOp,
    open: &[String],
    new_group_id: &str,
) -> Result<RepoGroupsDoc, AppError> {
    let mut items = doc.items.clone();
    // Smallest free "Group N" by NAME: counting groups would let invisible
    // ghosts (all-closed members) or renames skew the numbering.
    let default_name = {
        let mut names = std::collections::HashSet::new();
        fn collect<'a>(items: &'a [GroupItem], out: &mut std::collections::HashSet<&'a str>) {
            for it in items {
                if let GroupItem::Group(g) = it {
                    out.insert(g.name.as_str());
                    collect(&g.items, out);
                }
            }
        }
        collect(&items, &mut names);
        (1..)
            .map(|n| format!("Group {n}"))
            .find(|candidate| !names.contains(candidate.as_str()))
            .expect("some number is free")
    };
    let new_group = |wrapped: Vec<GroupItem>| {
        GroupItem::Group(RepoGroup {
            id: new_group_id.to_string(),
            name: default_name.clone(),
            color: None,
            collapsed: false,
            items: wrapped,
        })
    };
    match op {
        RepoGroupsOp::MergeIntoGroup { dragged, target } => {
            if ancestors_of_ref(&items, target, 0).is_none() {
                return Err(err("merge target not found"));
            }
            let dragged_item =
                remove_ref(&mut items, dragged).ok_or_else(|| err("dragged item not found"))?;
            // target gone after the removal = it was the dragged item itself
            // or lived inside it (a group dropped onto its own member)
            let target_ancestors = ancestors_of_ref(&items, target, 0)
                .ok_or_else(|| err("cannot merge an item with itself or its own member"))?;
            let target_depth = {
                let mut d = 0;
                fn find_depth(items: &[GroupItem], r: &ItemRef) -> Option<usize> {
                    items.iter().find_map(|it| {
                        if item_is_ref(it, r) {
                            Some(subtree_group_depth(it))
                        } else if let GroupItem::Group(g) = it {
                            find_depth(&g.items, r)
                        } else {
                            None
                        }
                    })
                }
                if let Some(sd) = find_depth(&items, target) {
                    d = sd;
                }
                d
            };
            let deepest =
                target_ancestors + 1 + target_depth.max(subtree_group_depth(&dragged_item));
            if deepest > MAX_GROUP_DEPTH {
                return Err(err("maximum group nesting depth reached"));
            }
            let mut dragged_slot = Some(dragged_item);
            let wrapped = wrap_ref(&mut items, target, &mut |t| {
                new_group(vec![t, dragged_slot.take().expect("wrap runs once")])
            });
            debug_assert!(wrapped, "target existence checked above");
        }
        RepoGroupsOp::NewGroupWith { item } => {
            let ancestors =
                ancestors_of_ref(&items, item, 0).ok_or_else(|| err("item not found"))?;
            let depth = {
                fn find_depth(items: &[GroupItem], r: &ItemRef) -> Option<usize> {
                    items.iter().find_map(|it| {
                        if item_is_ref(it, r) {
                            Some(subtree_group_depth(it))
                        } else if let GroupItem::Group(g) = it {
                            find_depth(&g.items, r)
                        } else {
                            None
                        }
                    })
                }
                find_depth(&items, item).unwrap_or(0)
            };
            if ancestors + 1 + depth > MAX_GROUP_DEPTH {
                return Err(err("maximum group nesting depth reached"));
            }
            let ok = wrap_ref(&mut items, item, &mut |t| new_group(vec![t]));
            debug_assert!(ok, "existence checked above");
        }
        RepoGroupsOp::MoveItem { item, parent, index } => {
            // The caller computes `index` against the doc with the item still
            // in place; removing it first shifts later same-parent slots left.
            fn position_of(
                items: &[GroupItem],
                r: &ItemRef,
                parent: Option<&str>,
            ) -> Option<(Option<String>, usize)> {
                for (i, it) in items.iter().enumerate() {
                    if item_is_ref(it, r) {
                        return Some((parent.map(str::to_string), i));
                    }
                    if let GroupItem::Group(g) = it {
                        if let Some(f) = position_of(&g.items, r, Some(&g.id)) {
                            return Some(f);
                        }
                    }
                }
                None
            }
            let old = position_of(&items, item, None);
            let moved = remove_ref(&mut items, item).ok_or_else(|| err("item not found"))?;
            let mut index = *index as usize;
            if let Some((old_parent, old_index)) = old {
                if old_parent == *parent && old_index < index {
                    index -= 1;
                }
            }
            match parent {
                None => {
                    let i = index.min(items.len());
                    items.insert(i, moved);
                }
                Some(pid) => {
                    // a parent inside the moved item was removed with it
                    let parent_level = ancestors_of_ref(&items, &ItemRef::Group { id: pid.clone() }, 0)
                        .map(|a| a + 1)
                        .ok_or_else(|| err("target group not found"))?;
                    if parent_level + subtree_group_depth(&moved) > MAX_GROUP_DEPTH {
                        return Err(err("maximum group nesting depth reached"));
                    }
                    let g = find_group_mut(&mut items, pid).expect("level resolved above");
                    let i = index.min(g.items.len());
                    g.items.insert(i, moved);
                }
            }
        }
        RepoGroupsOp::Ungroup { group_id } => {
            fn splice(items: &mut Vec<GroupItem>, id: &str) -> bool {
                if let Some(pos) = items
                    .iter()
                    .position(|it| matches!(it, GroupItem::Group(g) if g.id == id))
                {
                    let GroupItem::Group(g) = items.remove(pos) else { unreachable!() };
                    for (off, child) in g.items.into_iter().enumerate() {
                        items.insert(pos + off, child);
                    }
                    return true;
                }
                for it in items {
                    if let GroupItem::Group(g) = it {
                        if splice(&mut g.items, id) {
                            return true;
                        }
                    }
                }
                false
            }
            if !splice(&mut items, group_id) {
                return Err(err("group not found"));
            }
        }
        RepoGroupsOp::Rename { group_id, name } => {
            // Empty is legal: a color-only group.
            let g = find_group_mut(&mut items, group_id).ok_or_else(|| err("group not found"))?;
            g.name = name.trim().to_string();
        }
        RepoGroupsOp::SetColor { group_id, color } => {
            if let Some(c) = color {
                if !valid_hex_color(c) {
                    return Err(err(format!("not a hex color: {c}")));
                }
            }
            let g = find_group_mut(&mut items, group_id).ok_or_else(|| err("group not found"))?;
            g.color = color.clone();
        }
        RepoGroupsOp::SetRepoColor { locator, color } => {
            if let Some(c) = color {
                if !valid_hex_color(c) {
                    return Err(err(format!("not a hex color: {c}")));
                }
            }
            fn find_repo_mut<'a>(
                items: &'a mut [GroupItem],
                locator: &str,
            ) -> Option<&'a mut GroupRepoRef> {
                for it in items {
                    match it {
                        GroupItem::Repo(r) if r.locator.as_deref() == Some(locator) => {
                            return Some(r)
                        }
                        GroupItem::Group(g) => {
                            if let Some(f) = find_repo_mut(&mut g.items, locator) {
                                return Some(f);
                            }
                        }
                        _ => {}
                    }
                }
                None
            }
            let r =
                find_repo_mut(&mut items, locator).ok_or_else(|| err("repo not found"))?;
            r.color = color.clone();
        }
        RepoGroupsOp::SetCollapsed { group_id, collapsed } => {
            let g = find_group_mut(&mut items, group_id).ok_or_else(|| err("group not found"))?;
            g.collapsed = *collapsed;
        }
    }
    Ok(normalize(&RepoGroupsDoc { items }, open))
}

pub fn normalize(doc: &RepoGroupsDoc, open: &[String]) -> RepoGroupsDoc {
    let mut items = doc.items.clone();

    // "First occurrence wins" counts in document (pre-)order.
    fn dedupe_pre_order(items: &mut Vec<GroupItem>, seen: &mut std::collections::HashSet<String>) {
        let mut i = 0;
        while i < items.len() {
            let keep = match &mut items[i] {
                GroupItem::Repo(r) => match &r.locator {
                    Some(l) => seen.insert(l.clone()),
                    None => true,
                },
                GroupItem::Group(g) => {
                    dedupe_pre_order(&mut g.items, seen);
                    true
                }
            };
            if keep {
                i += 1;
            } else {
                items.remove(i);
            }
        }
    }
    dedupe_pre_order(&mut items, &mut std::collections::HashSet::new());

    let open_set: std::collections::HashSet<&str> = open.iter().map(|s| s.as_str()).collect();
    items.retain(|it| match it {
        GroupItem::Repo(r) => r.locator.as_deref().is_some_and(|l| open_set.contains(l)),
        GroupItem::Group(_) => true,
    });

    fn flatten_at_cap(items: &mut Vec<GroupItem>, level: usize) {
        for it in items {
            if let GroupItem::Group(g) = it {
                if level >= MAX_GROUP_DEPTH {
                    // this group may hold no subgroups: absorb their members
                    fn absorb(items: &mut Vec<GroupItem>) {
                        let mut i = 0;
                        while i < items.len() {
                            if matches!(items[i], GroupItem::Group(_)) {
                                let GroupItem::Group(inner) = items.remove(i) else {
                                    unreachable!()
                                };
                                for (off, child) in inner.items.into_iter().enumerate() {
                                    items.insert(i + off, child);
                                }
                                // re-check the same index: spliced children may
                                // themselves be groups
                            } else {
                                i += 1;
                            }
                        }
                    }
                    absorb(&mut g.items);
                } else {
                    flatten_at_cap(&mut g.items, level + 1);
                }
            }
        }
    }
    flatten_at_cap(&mut items, 1);

    fn prune_empty(items: &mut Vec<GroupItem>) {
        for it in items.iter_mut() {
            if let GroupItem::Group(g) = it {
                prune_empty(&mut g.items);
            }
        }
        items.retain(|it| !matches!(it, GroupItem::Group(g) if g.items.is_empty()));
    }
    prune_empty(&mut items);

    let mut present = vec![];
    locators_in(&items, &mut present);
    let present: std::collections::HashSet<String> = present.into_iter().collect();
    for l in open {
        if !present.contains(l) {
            items.push(GroupItem::Repo(GroupRepoRef {
                locator: Some(l.clone()),
                remote_key: None,
            color: None,
            }));
        }
    }

    RepoGroupsDoc { items }
}

pub fn flatten_open(doc: &RepoGroupsDoc, open: &[String]) -> Vec<String> {
    let open_set: std::collections::HashSet<&str> = open.iter().map(|s| s.as_str()).collect();
    let mut all = vec![];
    locators_in(&doc.items, &mut all);
    all.retain(|l| open_set.contains(l.as_str()));
    all
}

/// Move `locator`'s item right next to `anchor_locator` (after it, in the
/// anchor's parent): a freshly opened submodule spawns beside its
/// superproject, joining its group. Unchanged when either side is missing.
pub fn place_after(doc: &RepoGroupsDoc, locator: &str, anchor_locator: &str) -> RepoGroupsDoc {
    let anchor = ItemRef::Repo { locator: anchor_locator.to_string() };
    let moved_ref = ItemRef::Repo { locator: locator.to_string() };
    if ancestors_of_ref(&doc.items, &anchor, 0).is_none() {
        return doc.clone();
    }
    let mut items = doc.items.clone();
    let Some(moved) = remove_ref(&mut items, &moved_ref) else {
        return doc.clone();
    };
    fn insert_after(items: &mut Vec<GroupItem>, anchor: &ItemRef, moved: &mut Option<GroupItem>) {
        if let Some(pos) = items.iter().position(|it| item_is_ref(it, anchor)) {
            if let Some(m) = moved.take() {
                items.insert(pos + 1, m);
            }
            return;
        }
        for it in items {
            if let GroupItem::Group(g) = it {
                insert_after(&mut g.items, anchor, moved);
                if moved.is_none() {
                    return;
                }
            }
        }
    }
    let mut slot = Some(moved);
    insert_after(&mut items, &anchor, &mut slot);
    debug_assert!(slot.is_none(), "anchor existence checked above");
    RepoGroupsDoc { items }
}

/// Reorder the ROOT repo items to `ordered`'s relative order; groups keep
/// their indices and their contents. Root repos missing from `ordered` keep
/// their relative order after the ordered ones.
pub fn reorder_roots(doc: &RepoGroupsDoc, ordered: &[String]) -> RepoGroupsDoc {
    let pos = |it: &GroupItem| -> usize {
        match it {
            GroupItem::Repo(r) => r
                .locator
                .as_deref()
                .and_then(|l| ordered.iter().position(|o| o == l))
                .unwrap_or(usize::MAX),
            GroupItem::Group(_) => usize::MAX,
        }
    };
    let mut repos: Vec<GroupItem> =
        doc.items.iter().filter(|it| matches!(it, GroupItem::Repo(_))).cloned().collect();
    repos.sort_by_key(pos);
    let mut queue = repos.into_iter();
    RepoGroupsDoc {
        items: doc
            .items
            .iter()
            .map(|it| match it {
                GroupItem::Group(_) => it.clone(),
                GroupItem::Repo(_) => queue.next().expect("one queued repo per repo slot"),
            })
            .collect(),
    }
}

/// The sync-document key the portable groups projection lives under.
pub const REPO_GROUPS_SYNC_KEY: &str = "repoGroups";

/// Portable projection for the sync document: groups only (root repo items
/// dropped), members as canonical remote-key strings, nested groups inline.
/// Local-only members (no remote key) and ambiguous keys (in more than one
/// group) are omitted; collapsed state and locators never leave the machine.
pub fn export_groups(doc: &RepoGroupsDoc) -> serde_json::Value {
    fn collect_group_keys(
        items: &[GroupItem],
        in_group: bool,
        group_of_key: &mut std::collections::HashMap<String, std::collections::HashSet<String>>,
        current: Option<&str>,
    ) {
        for it in items {
            match it {
                GroupItem::Repo(r) => {
                    if in_group {
                        if let (Some(k), Some(g)) = (&r.remote_key, current) {
                            group_of_key.entry(k.clone()).or_default().insert(g.to_string());
                        }
                    }
                }
                GroupItem::Group(g) => {
                    collect_group_keys(&g.items, true, group_of_key, Some(&g.id));
                }
            }
        }
    }
    let mut group_of_key = std::collections::HashMap::new();
    collect_group_keys(&doc.items, false, &mut group_of_key, None);
    let ambiguous: std::collections::HashSet<&String> =
        group_of_key.iter().filter(|(_, gs)| gs.len() > 1).map(|(k, _)| k).collect();

    fn project(
        g: &RepoGroup,
        ambiguous: &std::collections::HashSet<&String>,
    ) -> serde_json::Value {
        let mut items = vec![];
        let mut seen_keys = std::collections::HashSet::new();
        for it in &g.items {
            match it {
                GroupItem::Repo(r) => {
                    if let Some(k) = &r.remote_key {
                        if !ambiguous.contains(k) && seen_keys.insert(k.clone()) {
                            items.push(match &r.color {
                                Some(c) => serde_json::json!({ "key": k, "color": c }),
                                None => serde_json::Value::String(k.clone()),
                            });
                        }
                    }
                }
                GroupItem::Group(inner) => items.push(project(inner, ambiguous)),
            }
        }
        serde_json::json!({ "id": g.id, "name": g.name, "color": g.color, "items": items })
    }

    serde_json::Value::Array(
        doc.items
            .iter()
            .filter_map(|it| match it {
                GroupItem::Group(g) => Some(project(g, &ambiguous)),
                GroupItem::Repo(_) => None,
            })
            .collect(),
    )
}

/// Reconcile a synced projection into the local doc. The projection is
/// authoritative for remote-keyed members (adds AND removals); local-only
/// members, collapsed state and top-level positions are preserved. Garbage
/// input leaves the local doc unchanged. Root repo items are never pruned
/// here (the caller re-normalizes with the open set).
pub fn import_groups(
    local: &RepoGroupsDoc,
    synced: &serde_json::Value,
    remote_keys: &std::collections::BTreeMap<String, String>,
) -> RepoGroupsDoc {
    use std::collections::{HashMap, HashSet};

    struct SGroup {
        id: String,
        name: String,
        color: Option<String>,
        items: Vec<SItem>,
    }
    enum SItem {
        Key { key: String, color: Option<String> },
        Group(SGroup),
    }
    fn parse_group(v: &serde_json::Value) -> Option<SGroup> {
        let o = v.as_object()?;
        let color = match o.get("color") {
            None | Some(serde_json::Value::Null) => None,
            // The sync door validates like SetColor does; an invalid color
            // falls back to the theme default instead of reaching CSS.
            Some(serde_json::Value::String(s)) => valid_hex_color(s).then(|| s.clone()),
            Some(_) => return None,
        };
        // An empty name is legal (a color-only group); trim like the op does.
        let name = o.get("name")?.as_str()?.trim();
        Some(SGroup {
            id: o.get("id")?.as_str()?.to_string(),
            name: name.to_string(),
            color,
            items: o
                .get("items")?
                .as_array()?
                .iter()
                .map(|it| match it {
                    serde_json::Value::String(k) => {
                        Some(SItem::Key { key: k.clone(), color: None })
                    }
                    v if v.get("key").is_some() => {
                        let key = v.get("key")?.as_str()?.to_string();
                        // like group colors: invalid hex falls back, never CSS
                        let color = v
                            .get("color")
                            .and_then(|c| c.as_str())
                            .filter(|c| valid_hex_color(c))
                            .map(str::to_string);
                        Some(SItem::Key { key, color })
                    }
                    v => parse_group(v).map(SItem::Group),
                })
                .collect::<Option<Vec<_>>>()?,
        })
    }
    let Some(arr) = synced.as_array() else { return local.clone() };
    let Some(mut parsed) = arr.iter().map(parse_group).collect::<Option<Vec<SGroup>>>() else {
        return local.clone();
    };

    fn flatten_sgroup(g: &mut SGroup, level: usize) {
        if level >= MAX_GROUP_DEPTH {
            let mut i = 0;
            while i < g.items.len() {
                if matches!(g.items[i], SItem::Group(_)) {
                    let SItem::Group(inner) = g.items.remove(i) else { unreachable!() };
                    for (off, child) in inner.items.into_iter().enumerate() {
                        g.items.insert(i + off, child);
                    }
                } else {
                    i += 1;
                }
            }
        } else {
            for it in &mut g.items {
                if let SItem::Group(inner) = it {
                    flatten_sgroup(inner, level + 1);
                }
            }
        }
    }
    for g in &mut parsed {
        flatten_sgroup(g, 1);
    }

    let mut key_locs: HashMap<&str, Vec<&str>> = HashMap::new();
    for (loc, key) in remote_keys {
        key_locs.entry(key.as_str()).or_default().push(loc.as_str());
    }

    // Local facts: excluded locators (local-only membership somewhere),
    // per-group carried state, and which local groups the sync owns.
    let mut excluded: HashSet<&str> = HashSet::new();
    let mut local_groups: HashMap<&str, &RepoGroup> = HashMap::new();
    fn walk_local<'a>(
        items: &'a [GroupItem],
        in_group: bool,
        excluded: &mut HashSet<&'a str>,
        local_groups: &mut HashMap<&'a str, &'a RepoGroup>,
    ) {
        for it in items {
            match it {
                GroupItem::Repo(r) => {
                    if in_group && r.remote_key.is_none() {
                        if let Some(l) = &r.locator {
                            excluded.insert(l);
                        }
                    }
                }
                GroupItem::Group(g) => {
                    local_groups.insert(&g.id, g);
                    walk_local(&g.items, true, excluded, local_groups);
                }
            }
        }
    }
    walk_local(&local.items, false, &mut excluded, &mut local_groups);

    let mut synced_ids: HashSet<&str> = HashSet::new();
    fn collect_sids<'a>(g: &'a SGroup, out: &mut HashSet<&'a str>) {
        out.insert(&g.id);
        for it in &g.items {
            if let SItem::Group(inner) = it {
                collect_sids(inner, out);
            }
        }
    }
    for g in &parsed {
        collect_sids(g, &mut synced_ids);
    }

    // Sync-visible = would export with at least one member key in its subtree.
    let mut sync_visible: HashSet<String> = HashSet::new();
    fn visible(v: &serde_json::Value, out: &mut HashSet<String>) -> bool {
        let (Some(id), Some(items)) =
            (v.get("id").and_then(|i| i.as_str()), v.get("items").and_then(|i| i.as_array()))
        else {
            return false;
        };
        let mut any = false;
        for it in items {
            match it {
                serde_json::Value::String(_) => any = true,
                nested => any |= visible(nested, out),
            }
        }
        if any {
            out.insert(id.to_string());
        }
        any
    }
    if let serde_json::Value::Array(exported) = export_groups(local) {
        for g in &exported {
            visible(g, &mut sync_visible);
        }
    }

    let mut used_locators: HashSet<String> = HashSet::new();
    fn build_group(
        sg: &SGroup,
        key_locs: &HashMap<&str, Vec<&str>>,
        excluded: &HashSet<&str>,
        local_groups: &HashMap<&str, &RepoGroup>,
        synced_ids: &HashSet<&str>,
        sync_visible: &HashSet<String>,
        used: &mut HashSet<String>,
    ) -> RepoGroup {
        let mut items: Vec<GroupItem> = vec![];
        for it in &sg.items {
            match it {
                SItem::Key { key: k, color } => match key_locs.get(k.as_str()) {
                    None => items.push(GroupItem::Repo(GroupRepoRef {
                        locator: None,
                        remote_key: Some(k.clone()),
                        color: color.clone(),
                    })),
                    Some(locs) => {
                        for l in locs {
                            if !excluded.contains(l) && used.insert(l.to_string()) {
                                items.push(GroupItem::Repo(GroupRepoRef {
                                    locator: Some(l.to_string()),
                                    remote_key: Some(k.clone()),
                                    color: color.clone(),
                                }));
                            }
                        }
                    }
                },
                SItem::Group(inner) => items.push(GroupItem::Group(build_group(
                    inner,
                    key_locs,
                    excluded,
                    local_groups,
                    synced_ids,
                    sync_visible,
                    used,
                ))),
            }
        }
        let mut collapsed = false;
        if let Some(lg) = local_groups.get(sg.id.as_str()) {
            collapsed = lg.collapsed;
            for it in &lg.items {
                match it {
                    GroupItem::Repo(r) if r.remote_key.is_none() => items.push(it.clone()),
                    GroupItem::Group(g)
                        if !synced_ids.contains(g.id.as_str())
                            && !sync_visible.contains(&g.id) =>
                    {
                        items.push(it.clone())
                    }
                    _ => {}
                }
            }
        }
        RepoGroup { id: sg.id.clone(), name: sg.name.clone(), color: sg.color.clone(), collapsed, items }
    }

    let top_ids: HashSet<&str> = parsed.iter().map(|g| g.id.as_str()).collect();
    let mut built: HashMap<&str, RepoGroup> = HashMap::new();
    for sg in &parsed {
        built.insert(
            &sg.id,
            build_group(
                sg,
                &key_locs,
                &excluded,
                &local_groups,
                &synced_ids,
                &sync_visible,
                &mut used_locators,
            ),
        );
    }

    let mut items: Vec<GroupItem> = vec![];
    let mut emitted: HashSet<&str> = HashSet::new();
    for it in &local.items {
        match it {
            GroupItem::Repo(r) => {
                let claimed =
                    r.locator.as_ref().is_some_and(|l| used_locators.contains(l.as_str()));
                if !claimed {
                    items.push(it.clone());
                }
            }
            GroupItem::Group(g) => {
                if top_ids.contains(g.id.as_str()) {
                    if let Some(b) = built.remove(g.id.as_str()) {
                        emitted.insert(&g.id);
                        items.push(GroupItem::Group(b));
                    }
                } else if synced_ids.contains(g.id.as_str()) || sync_visible.contains(&g.id) {
                    // owned by sync: appears nested per the synced structure,
                    // or was deleted on the other machine
                } else {
                    items.push(it.clone());
                }
            }
        }
    }
    for sg in &parsed {
        if !emitted.contains(sg.id.as_str()) {
            if let Some(b) = built.remove(sg.id.as_str()) {
                items.push(GroupItem::Group(b));
            }
        }
    }

    RepoGroupsDoc { items }
}

pub fn note_repo_opened(
    doc: &RepoGroupsDoc,
    locator: &str,
    remote_key: Option<&str>,
) -> RepoGroupsDoc {
    let mut items = doc.items.clone();

    fn find_by_locator<'a>(items: &'a mut [GroupItem], l: &str) -> Option<&'a mut GroupRepoRef> {
        for it in items {
            match it {
                GroupItem::Repo(r) if r.locator.as_deref() == Some(l) => return Some(r),
                GroupItem::Group(g) => {
                    if let Some(f) = find_by_locator(&mut g.items, l) {
                        return Some(f);
                    }
                }
                _ => {}
            }
        }
        None
    }

    if let Some(r) = find_by_locator(&mut items, locator) {
        if let Some(k) = remote_key {
            r.remote_key = Some(k.to_string());
        }
        return RepoGroupsDoc { items };
    }

    if let Some(k) = remote_key {
        fn claim_first_pending(items: &mut [GroupItem], k: &str, l: &str) -> bool {
            for it in items {
                match it {
                    GroupItem::Repo(r)
                        if r.locator.is_none() && r.remote_key.as_deref() == Some(k) =>
                    {
                        r.locator = Some(l.to_string());
                        return true;
                    }
                    GroupItem::Group(g) => {
                        if claim_first_pending(&mut g.items, k, l) {
                            return true;
                        }
                    }
                    _ => {}
                }
            }
            false
        }
        fn drop_other_pending(items: &mut Vec<GroupItem>, k: &str) {
            items.retain(|it| {
                !matches!(it, GroupItem::Repo(r)
                    if r.locator.is_none() && r.remote_key.as_deref() == Some(k))
            });
            for it in items {
                if let GroupItem::Group(g) = it {
                    drop_other_pending(&mut g.items, k);
                }
            }
        }
        if claim_first_pending(&mut items, k, locator) {
            drop_other_pending(&mut items, k);
        }
    }

    RepoGroupsDoc { items }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(l: &str) -> GroupItem {
        GroupItem::Repo(GroupRepoRef { locator: Some(l.into()), remote_key: None ,color: None, })
    }
    fn repo_k(l: &str, k: &str) -> GroupItem {
        GroupItem::Repo(GroupRepoRef { locator: Some(l.into()), remote_key: Some(k.into()) ,color: None, })
    }
    fn pending(k: &str) -> GroupItem {
        GroupItem::Repo(GroupRepoRef { locator: None, remote_key: Some(k.into()) ,color: None, })
    }
    fn group(id: &str, items: Vec<GroupItem>) -> GroupItem {
        GroupItem::Group(RepoGroup {
            id: id.into(),
            name: id.into(),
            color: None,
            collapsed: false,
            items,
        })
    }
    fn doc(items: Vec<GroupItem>) -> RepoGroupsDoc {
        RepoGroupsDoc { items }
    }
    fn open(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }
    /// All locators in the doc, depth-first, open or not.
    fn all_locators(d: &RepoGroupsDoc) -> Vec<String> {
        fn walk(items: &[GroupItem], out: &mut Vec<String>) {
            for it in items {
                match it {
                    GroupItem::Repo(r) => {
                        if let Some(l) = &r.locator {
                            out.push(l.clone());
                        }
                    }
                    GroupItem::Group(g) => walk(&g.items, out),
                }
            }
        }
        let mut out = vec![];
        walk(&d.items, &mut out);
        out
    }
    fn find_group<'a>(items: &'a [GroupItem], id: &str) -> Option<&'a RepoGroup> {
        for it in items {
            if let GroupItem::Group(g) = it {
                if g.id == id {
                    return Some(g);
                }
                if let Some(f) = find_group(&g.items, id) {
                    return Some(f);
                }
            }
        }
        None
    }

    #[test]
    fn normalize_dedupes_locators() {
        let d = doc(vec![repo("a"), group("g1", vec![repo("a"), repo("b")])]);
        let n = normalize(&d, &open(&["a", "b"]));
        assert_eq!(all_locators(&n), vec!["a", "b"]);
        // first occurrence (root) wins; the group keeps only b
        assert_eq!(find_group(&n.items, "g1").unwrap().items.len(), 1);
    }

    #[test]
    fn normalize_prunes_closed_root_repos_keeps_grouped() {
        let d = doc(vec![repo("a"), group("g1", vec![repo("b")])]);
        let n = normalize(&d, &open(&[]));
        assert_eq!(all_locators(&n), vec!["b"]);
        assert!(find_group(&n.items, "g1").is_some());
    }

    #[test]
    fn normalize_dissolves_empty_groups_cascading() {
        let d = doc(vec![group("g1", vec![group("g2", vec![])])]);
        let n = normalize(&d, &open(&[]));
        assert!(n.items.is_empty());
    }

    #[test]
    fn normalize_appends_unknown_open_repos() {
        let d = doc(vec![group("g1", vec![repo("a")])]);
        let n = normalize(&d, &open(&["a", "x", "y"]));
        assert_eq!(all_locators(&n), vec!["a", "x", "y"]);
        assert!(matches!(n.items.last(), Some(GroupItem::Repo(r)) if r.locator.as_deref() == Some("y")));
    }

    #[test]
    fn normalize_flattens_beyond_depth_cap() {
        // cap 1: a group holds only repos - nested groups are absorbed.
        let d = doc(vec![group(
            "g1",
            vec![group("g2", vec![group("g3", vec![repo("a")])]), repo("b")],
        )]);
        let n = normalize(&d, &open(&["a", "b"]));
        assert!(find_group(&n.items, "g2").is_none());
        assert!(find_group(&n.items, "g3").is_none());
        let g1 = find_group(&n.items, "g1").unwrap();
        assert_eq!(g1.items, vec![repo("a"), repo("b")]);
    }

    #[test]
    fn merge_creates_group_in_place_with_default_name() {
        let d = doc(vec![repo("a"), repo("b"), group("gx", vec![repo("c")])]);
        let op = RepoGroupsOp::MergeIntoGroup {
            dragged: ItemRef::Repo { locator: "b".into() },
            target: ItemRef::Repo { locator: "a".into() },
        };
        let n = apply_op(&d, &op, &open(&["a", "b", "c"]), "new-id").unwrap();
        let g = find_group(&n.items, "new-id").unwrap();
        // smallest free "Group N" NAME: ghosts or odd names never inflate it
        assert_eq!(g.name, "Group 1");
        assert_eq!(all_locators(&RepoGroupsDoc { items: g.items.clone() }), vec!["a", "b"]);
        // the new group sits where a sat: first item
        assert!(matches!(&n.items[0], GroupItem::Group(g) if g.id == "new-id"));
        assert_eq!(all_locators(&n), vec!["a", "b", "c"]);
    }

    #[test]
    fn default_group_names_take_the_smallest_free_number() {
        let d = doc(vec![
            group("a1", vec![repo("a")]),
            group("b1", vec![repo("b")]),
            repo("c"),
            repo("d"),
        ]);
        // name the existing groups "Group 1" and "Group 3"
        let d = apply_op(&d, &RepoGroupsOp::Rename { group_id: "a1".into(), name: "Group 1".into() }, &open(&["a","b","c","d"]), "n").unwrap();
        let d = apply_op(&d, &RepoGroupsOp::Rename { group_id: "b1".into(), name: "Group 3".into() }, &open(&["a","b","c","d"]), "n").unwrap();
        let n = apply_op(
            &d,
            &RepoGroupsOp::MergeIntoGroup {
                dragged: ItemRef::Repo { locator: "d".into() },
                target: ItemRef::Repo { locator: "c".into() },
            },
            &open(&["a", "b", "c", "d"]),
            "new-id",
        )
        .unwrap();
        assert_eq!(find_group(&n.items, "new-id").unwrap().name, "Group 2");
    }

    #[test]
    fn merge_nested_at_cap_is_rejected() {
        // Members of a group sit AT the cap: merging two of them would nest.
        let d = doc(vec![group("g1", vec![repo("a"), repo("b")])]);
        let op = RepoGroupsOp::MergeIntoGroup {
            dragged: ItemRef::Repo { locator: "b".into() },
            target: ItemRef::Repo { locator: "a".into() },
        };
        assert!(apply_op(&d, &op, &open(&["a", "b"]), "new-id").is_err());
    }

    #[test]
    fn merge_rejects_self_and_descendant() {
        let d = doc(vec![group("g1", vec![repo("a")]), repo("b")]);
        let self_op = RepoGroupsOp::MergeIntoGroup {
            dragged: ItemRef::Repo { locator: "b".into() },
            target: ItemRef::Repo { locator: "b".into() },
        };
        assert!(apply_op(&d, &self_op, &open(&["a", "b"]), "n").is_err());
        let desc_op = RepoGroupsOp::MergeIntoGroup {
            dragged: ItemRef::Group { id: "g1".into() },
            target: ItemRef::Repo { locator: "a".into() },
        };
        assert!(apply_op(&d, &desc_op, &open(&["a", "b"]), "n").is_err());
    }

    #[test]
    fn new_group_with_wraps_item_in_place() {
        let d = doc(vec![repo("a"), repo("b")]);
        let op = RepoGroupsOp::NewGroupWith { item: ItemRef::Repo { locator: "a".into() } };
        let n = apply_op(&d, &op, &open(&["a", "b"]), "new-id").unwrap();
        assert!(matches!(&n.items[0], GroupItem::Group(g) if g.id == "new-id" && g.name == "Group 1"));
        assert_eq!(all_locators(&n), vec!["a", "b"]);
    }

    #[test]
    fn move_item_between_levels_and_clamps_index() {
        let d = doc(vec![group("g1", vec![repo("a"), repo("b")]), repo("c")]);
        // b out of g1 to root at an out-of-range index: lands at the end
        let out = apply_op(
            &d,
            &RepoGroupsOp::MoveItem {
                item: ItemRef::Repo { locator: "b".into() },
                parent: None,
                index: 99,
            },
            &open(&["a", "b", "c"]),
            "n",
        )
        .unwrap();
        assert_eq!(all_locators(&out), vec!["a", "c", "b"]);
        // c into g1 at index 0
        let in_ = apply_op(
            &out,
            &RepoGroupsOp::MoveItem {
                item: ItemRef::Repo { locator: "c".into() },
                parent: Some("g1".into()),
                index: 0,
            },
            &open(&["a", "b", "c"]),
            "n",
        )
        .unwrap();
        assert_eq!(all_locators(&in_), vec!["c", "a", "b"]);
    }

    #[test]
    fn move_within_same_parent_forward_lands_at_the_previewed_gap() {
        // The frontend computes the index against the doc WITH the dragged
        // item still present: dragging a to the b|c gap sends index 2.
        let d = doc(vec![repo("a"), repo("b"), repo("c")]);
        let o = open(&["a", "b", "c"]);
        let fwd = apply_op(
            &d,
            &RepoGroupsOp::MoveItem {
                item: ItemRef::Repo { locator: "a".into() },
                parent: None,
                index: 2,
            },
            &o,
            "n",
        )
        .unwrap();
        assert_eq!(all_locators(&fwd), vec!["b", "a", "c"]);
        // to the very end: index 3 with the item still counted
        let end = apply_op(
            &d,
            &RepoGroupsOp::MoveItem {
                item: ItemRef::Repo { locator: "a".into() },
                parent: None,
                index: 3,
            },
            &o,
            "n",
        )
        .unwrap();
        assert_eq!(all_locators(&end), vec!["b", "c", "a"]);
        // backward moves are unaffected
        let back = apply_op(
            &d,
            &RepoGroupsOp::MoveItem {
                item: ItemRef::Repo { locator: "c".into() },
                parent: None,
                index: 0,
            },
            &o,
            "n",
        )
        .unwrap();
        assert_eq!(all_locators(&back), vec!["c", "a", "b"]);
    }

    #[test]
    fn move_last_member_out_counts_the_emptied_group_slot() {
        // The live preview keeps the emptied group visible until the drop
        // commits, so the sent index counts WITH it: [g1[a], b, c] with a
        // dropped between b and c arrives as root index 2 over [g1, b, c];
        // the final normalize dissolves g1.
        let d = doc(vec![group("g1", vec![repo("a")]), repo("b"), repo("c")]);
        let n = apply_op(
            &d,
            &RepoGroupsOp::MoveItem {
                item: ItemRef::Repo { locator: "a".into() },
                parent: None,
                index: 2,
            },
            &open(&["a", "b", "c"]),
            "n",
        )
        .unwrap();
        assert_eq!(all_locators(&n), vec!["b", "a", "c"]);
        assert!(find_group(&n.items, "g1").is_none());
    }

    #[test]
    fn move_group_into_descendant_rejected() {
        let d = doc(vec![group("g1", vec![group("g2", vec![repo("a")])])]);
        let op = RepoGroupsOp::MoveItem {
            item: ItemRef::Group { id: "g1".into() },
            parent: Some("g2".into()),
            index: 0,
        };
        assert!(apply_op(&d, &op, &open(&["a"]), "n").is_err());
    }

    #[test]
    fn ungroup_splices_members_in_place() {
        let d = doc(vec![
            repo("a"),
            group("g1", vec![repo("b"), group("g2", vec![repo("c")])]),
            repo("d"),
        ]);
        let n = apply_op(
            &d,
            &RepoGroupsOp::Ungroup { group_id: "g1".into() },
            &open(&["a", "b", "c", "d"]),
            "n",
        )
        .unwrap();
        assert!(find_group(&n.items, "g1").is_none());
        assert!(find_group(&n.items, "g2").is_some());
        assert_eq!(all_locators(&n), vec!["a", "b", "c", "d"]);
        assert_eq!(n.items.len(), 4); // a, b, g2, d at root
    }

    #[test]
    fn set_repo_color_validates_and_reaches_nested_refs() {
        let d = doc(vec![repo("a"), group("g1", vec![repo("b")])]);
        let o = open(&["a", "b"]);
        let n = apply_op(
            &d,
            &RepoGroupsOp::SetRepoColor { locator: "b".into(), color: Some("#abc".into()) },
            &o,
            "n",
        )
        .unwrap();
        let g = find_group(&n.items, "g1").unwrap();
        assert!(matches!(&g.items[0], GroupItem::Repo(r) if r.color.as_deref() == Some("#abc")));
        assert!(apply_op(
            &d,
            &RepoGroupsOp::SetRepoColor { locator: "a".into(), color: Some("red".into()) },
            &o,
            "n"
        )
        .is_err());
        assert!(apply_op(
            &d,
            &RepoGroupsOp::SetRepoColor { locator: "missing".into(), color: None },
            &o,
            "n"
        )
        .is_err());
    }

    #[test]
    fn member_colors_survive_the_sync_roundtrip() {
        // A colored member exports as {key, color} (plain string otherwise)
        // and the color lands on the resolved locator at import; an invalid
        // synced color falls back to None.
        let mut d = doc(vec![group("g1", vec![repo_k("a", "ka"), repo_k("b", "kb")])]);
        let GroupItem::Group(g) = &mut d.items[0] else { unreachable!() };
        let GroupItem::Repo(r) = &mut g.items[0] else { unreachable!() };
        r.color = Some("#abc".into());
        let v = export_groups(&d);
        assert_eq!(v[0]["items"][0], serde_json::json!({ "key": "ka", "color": "#abc" }));
        assert_eq!(v[0]["items"][1], "kb");

        let n = import_groups(&doc(vec![]), &v, &keys(&[("loc-a", "ka")]));
        let g1 = find_group(&n.items, "g1").unwrap();
        assert!(matches!(&g1.items[0], GroupItem::Repo(r)
            if r.locator.as_deref() == Some("loc-a") && r.color.as_deref() == Some("#abc")));
        let bad = serde_json::json!([
            { "id": "g1", "name": "g1", "color": null,
              "items": [{ "key": "ka", "color": "red" }] },
        ]);
        let n2 = import_groups(&doc(vec![]), &bad, &keys(&[("loc-a", "ka")]));
        assert!(matches!(&find_group(&n2.items, "g1").unwrap().items[0], GroupItem::Repo(r)
            if r.color.is_none()));
    }

    #[test]
    fn set_color_validates_hex() {
        let d = doc(vec![group("g1", vec![repo("a")])]);
        let o = open(&["a"]);
        for ok in ["#abc", "#AaBbCc", "#aabbccdd"] {
            let n = apply_op(
                &d,
                &RepoGroupsOp::SetColor { group_id: "g1".into(), color: Some(ok.into()) },
                &o,
                "n",
            )
            .unwrap();
            assert_eq!(find_group(&n.items, "g1").unwrap().color.as_deref(), Some(ok));
        }
        for bad in ["red", "#ab", "#ggg", "abc", "#aabbccd"] {
            let r = apply_op(
                &d,
                &RepoGroupsOp::SetColor { group_id: "g1".into(), color: Some(bad.into()) },
                &o,
                "n",
            );
            assert!(r.is_err(), "accepted {bad}");
        }
        let reset = apply_op(
            &d,
            &RepoGroupsOp::SetColor { group_id: "g1".into(), color: None },
            &o,
            "n",
        )
        .unwrap();
        assert_eq!(find_group(&reset.items, "g1").unwrap().color, None);
    }

    #[test]
    fn rename_trims_and_allows_empty_names() {
        // An empty name is legal: a color-only group.
        let d = doc(vec![group("g1", vec![repo("a")])]);
        let o = open(&["a"]);
        let cleared = apply_op(
            &d,
            &RepoGroupsOp::Rename { group_id: "g1".into(), name: "   ".into() },
            &o,
            "n",
        )
        .unwrap();
        assert_eq!(find_group(&cleared.items, "g1").unwrap().name, "");
        let n = apply_op(
            &d,
            &RepoGroupsOp::Rename { group_id: "g1".into(), name: "  Work  ".into() },
            &o,
            "n",
        )
        .unwrap();
        assert_eq!(find_group(&n.items, "g1").unwrap().name, "Work");
    }

    #[test]
    fn flatten_open_is_depth_first_open_only() {
        let d = doc(vec![
            group("g1", vec![repo("a"), group("g2", vec![repo("b")]), repo("x")]),
            repo("c"),
        ]);
        assert_eq!(flatten_open(&d, &open(&["a", "b", "c"])), vec!["a", "b", "c"]);
    }

    fn keys(map: &[(&str, &str)]) -> std::collections::BTreeMap<String, String> {
        map.iter().map(|(l, k)| (l.to_string(), k.to_string())).collect()
    }
    fn group_c(id: &str, collapsed: bool, items: Vec<GroupItem>) -> GroupItem {
        GroupItem::Group(RepoGroup {
            id: id.into(),
            name: id.into(),
            color: None,
            collapsed,
            items,
        })
    }

    #[test]
    fn export_drops_local_only_and_ambiguous_keys() {
        // "amb" lives in two groups: dropped from both. "solo" has no remote
        // key: dropped. Root repos never export.
        let d = doc(vec![
            repo_k("root", "root-key"),
            group("g1", vec![repo_k("a", "amb"), repo_k("w", "work"), repo("solo")]),
            group("g2", vec![repo_k("b", "amb")]),
        ]);
        let v = export_groups(&d);
        assert_eq!(
            v,
            serde_json::json!([
                { "id": "g1", "name": "g1", "color": null, "items": ["work"] },
                { "id": "g2", "name": "g2", "color": null, "items": [] },
            ])
        );
    }

    #[test]
    fn export_strips_collapsed_and_locators_keeps_empty_groups() {
        let d = doc(vec![group_c(
            "g1",
            true,
            vec![GroupItem::Group(RepoGroup {
                id: "g2".into(),
                name: "School".into(),
                color: Some("#abc".into()),
                collapsed: true,
                items: vec![repo_k("x", "k1")],
            })],
        )]);
        let v = export_groups(&d);
        assert_eq!(
            v,
            serde_json::json!([
                { "id": "g1", "name": "g1", "color": null, "items": [
                    { "id": "g2", "name": "School", "color": "#abc", "items": ["k1"] },
                ]},
            ])
        );
        let s = serde_json::to_string(&v).unwrap();
        assert!(!s.contains("collapsed") && !s.contains("locator"));
    }

    #[test]
    fn import_removal_propagates_for_remote_keyed_members() {
        // Local has a+b in g1; synced g1 only holds a's key: b is removed.
        let local = doc(vec![group("g1", vec![repo_k("a", "ka"), repo_k("b", "kb")])]);
        let synced = serde_json::json!([
            { "id": "g1", "name": "g1", "color": null, "items": ["ka"] },
        ]);
        let n = import_groups(&local, &synced, &keys(&[("a", "ka"), ("b", "kb")]));
        let g1 = find_group(&n.items, "g1").unwrap();
        assert_eq!(g1.items, vec![repo_k("a", "ka")]);
    }

    #[test]
    fn import_preserves_local_only_members_collapsed_and_position() {
        let local = doc(vec![
            group_c("g1", true, vec![repo_k("a", "ka"), repo("solo")]),
            group("g2", vec![repo_k("b", "kb")]),
        ]);
        let synced = serde_json::json!([
            { "id": "g2", "name": "g2".to_string(), "color": null, "items": ["kb"] },
            { "id": "g1", "name": "Work", "color": "#aabbcc", "items": ["ka"] },
        ]);
        let n = import_groups(&local, &synced, &keys(&[("a", "ka"), ("b", "kb")]));
        // local top-level order wins: g1 stays before g2
        assert!(matches!(&n.items[0], GroupItem::Group(g) if g.id == "g1"));
        let g1 = find_group(&n.items, "g1").unwrap();
        assert!(g1.collapsed);
        assert_eq!(g1.name, "Work");
        assert_eq!(g1.color.as_deref(), Some("#aabbcc"));
        assert!(g1.items.contains(&repo("solo")));
    }

    #[test]
    fn import_resolves_keys_to_all_matching_locators() {
        // Two local repos share "ka" (worktrees): both join. "c" holds a
        // local-only membership elsewhere: excluded from resolution.
        let local = doc(vec![group("mine", vec![repo("c")])]);
        let synced = serde_json::json!([
            { "id": "g1", "name": "g1", "color": null, "items": ["ka"] },
        ]);
        let n = import_groups(&local, &synced, &keys(&[("a", "ka"), ("b", "ka"), ("c", "ka")]));
        let g1 = find_group(&n.items, "g1").unwrap();
        assert_eq!(g1.items, vec![repo_k("a", "ka"), repo_k("b", "ka")]);
        assert_eq!(find_group(&n.items, "mine").unwrap().items, vec![repo("c")]);
    }

    #[test]
    fn import_keeps_unmatched_keys_as_pending() {
        let synced = serde_json::json!([
            { "id": "g1", "name": "g1", "color": null, "items": ["unknown"] },
        ]);
        let n = import_groups(&doc(vec![]), &synced, &keys(&[]));
        let g1 = find_group(&n.items, "g1").unwrap();
        assert_eq!(g1.items, vec![pending("unknown")]);
    }

    #[test]
    fn import_deletes_sync_visible_groups_absent_from_doc_keeps_local_only_groups() {
        let local = doc(vec![
            group("synced-away", vec![repo_k("a", "ka")]),
            group("mine", vec![repo("solo")]),
        ]);
        let synced = serde_json::json!([]);
        let n = import_groups(&local, &synced, &keys(&[("a", "ka")]));
        assert!(find_group(&n.items, "synced-away").is_none());
        assert!(find_group(&n.items, "mine").is_some());
    }

    #[test]
    fn import_groups_tolerates_garbage() {
        let local = doc(vec![group("g1", vec![repo_k("a", "ka")])]);
        let km = keys(&[("a", "ka")]);
        for garbage in [
            serde_json::json!("nope"),
            serde_json::json!({ "not": "an array" }),
            serde_json::json!([{ "id": 7, "name": "x", "items": [] }]),
            serde_json::json!([{ "id": "g", "name": "x", "items": [42] }]),
        ] {
            assert_eq!(import_groups(&local, &garbage, &km), local, "accepted {garbage}");
        }
    }

    #[test]
    fn import_accepts_empty_group_names() {
        let synced = serde_json::json!([{ "id": "g1", "name": "  ", "color": null, "items": [] }]);
        let n = import_groups(&doc(vec![]), &synced, &keys(&[]));
        assert_eq!(find_group(&n.items, "g1").unwrap().name, "");
    }

    #[test]
    fn import_drops_invalid_synced_colors() {
        // SetColor validates at the IPC door; the sync door must too - an
        // invalid color falls back to the theme default, never to CSS.
        let synced = serde_json::json!([
            { "id": "g1", "name": "g1", "color": "red", "items": [] },
            { "id": "g2", "name": "g2", "color": "#abc", "items": [] },
        ]);
        let n = import_groups(&doc(vec![]), &synced, &keys(&[]));
        assert_eq!(find_group(&n.items, "g1").unwrap().color, None);
        assert_eq!(find_group(&n.items, "g2").unwrap().color.as_deref(), Some("#abc"));
    }

    #[test]
    fn import_flattens_beyond_depth_cap() {
        // A doc from a build with a higher cap arrives nested: absorbed.
        let synced = serde_json::json!([
            { "id": "g1", "name": "g1", "color": null, "items": [
                { "id": "g2", "name": "g2", "color": null, "items": ["k"] },
            ]},
        ]);
        let n = import_groups(&doc(vec![]), &synced, &keys(&[]));
        assert!(find_group(&n.items, "g2").is_none());
        assert_eq!(find_group(&n.items, "g1").unwrap().items, vec![pending("k")]);
    }

    #[test]
    fn place_after_puts_a_repo_beside_its_anchor_joining_its_group() {
        // A fresh submodule tab spawns right of its superproject, inheriting
        // the super's group; a missing anchor leaves the doc unchanged.
        let d = doc(vec![group("g1", vec![repo("super"), repo("x")]), repo("new")]);
        let n = place_after(&d, "new", "super");
        let g = find_group(&n.items, "g1").unwrap();
        assert_eq!(all_locators(&RepoGroupsDoc { items: g.items.clone() }), vec!["super", "new", "x"]);
        let root = doc(vec![repo("super"), repo("a"), repo("new")]);
        assert_eq!(all_locators(&place_after(&root, "new", "super")), vec!["super", "new", "a"]);
        let missing = place_after(&d, "new", "gone");
        assert_eq!(missing, d);
    }

    #[test]
    fn reorder_roots_orders_root_repos_keeps_groups() {
        let d = doc(vec![group("g1", vec![repo("a")]), repo("b"), repo("c"), repo("x")]);
        // "a" is grouped (not a root item) and must be ignored; "x" is not
        // named and keeps its place after the ordered ones.
        let n = reorder_roots(&d, &open(&["c", "a", "b"]));
        assert!(matches!(&n.items[0], GroupItem::Group(g) if g.id == "g1"));
        assert_eq!(all_locators(&n), vec!["a", "c", "b", "x"]);
    }

    #[test]
    fn note_repo_opened_refreshes_key() {
        let d = doc(vec![group("g1", vec![repo_k("a", "old-key")])]);
        let n = note_repo_opened(&d, "a", Some("new-key"));
        let g = find_group(&n.items, "g1").unwrap();
        assert!(
            matches!(&g.items[0], GroupItem::Repo(r) if r.remote_key.as_deref() == Some("new-key"))
        );
    }

    #[test]
    fn note_repo_opened_joins_first_pending_match_only() {
        let d = doc(vec![group("g1", vec![pending("k")]), group("g2", vec![pending("k"), repo("b")])]);
        let n = note_repo_opened(&d, "a", Some("k"));
        let g1 = find_group(&n.items, "g1").unwrap();
        assert!(
            matches!(&g1.items[0], GroupItem::Repo(r) if r.locator.as_deref() == Some("a") && r.remote_key.as_deref() == Some("k"))
        );
        // the second pending copy is dropped, the unrelated member stays
        let g2 = find_group(&n.items, "g2").unwrap();
        assert_eq!(g2.items, vec![repo("b")]);
    }
}
