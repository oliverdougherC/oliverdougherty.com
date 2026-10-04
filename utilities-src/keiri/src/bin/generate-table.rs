//! Offline native table regeneration only. Never compiled into the web library.
use keiri::{AnchorValueTable, Ruleset};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = std::env::args().nth(1).ok_or("expected output path")?;
    let table =
        AnchorValueTable::build_limited_with_progress(Ruleset::BuddyBoardGames, 13, |progress| {
            if progress.completed_layer_states == progress.layer_states {
                eprintln!("Completed layer {} / 13", progress.open_count);
            }
        })?;
    assert_eq!(table.completed_open_layers(), (0..=13).collect::<Vec<_>>());
    table.save(output)?;
    Ok(())
}
