//! Small single-threaded raw WASM ABI. Every rule and decision comes from pinned Keiri.
use keiri::{
    Action, AnchorValueTable, Category, Dice, ExactTableAgent, GameState, Rules, Ruleset,
    ScoreSheet,
};
use std::cell::RefCell;

const RULESET: Ruleset = Ruleset::BuddyBoardGames;
thread_local! {
    static INPUT: RefCell<[i32; 20]> = const { RefCell::new([0; 20]) };
    static OUTPUT: RefCell<[i32; 20]> = const { RefCell::new([0; 20]) };
    static ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static TABLE_BYTES: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static AGENT: RefCell<Option<ExactTableAgent>> = const { RefCell::new(None) };
}

#[unsafe(no_mangle)]
pub extern "C" fn input_ptr() -> *mut i32 {
    INPUT.with(|v| v.borrow_mut().as_mut_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn output_ptr() -> *const i32 {
    OUTPUT.with(|v| v.borrow().as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn error_ptr() -> *const u8 {
    ERROR.with(|v| v.borrow().as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn error_len() -> usize {
    ERROR.with(|v| v.borrow().len())
}

fn checked(action: impl FnOnce() -> Result<(), String>) -> i32 {
    match action() {
        Ok(()) => {
            ERROR.with(|e| e.borrow_mut().clear());
            0
        }
        Err(message) => {
            ERROR.with(|e| *e.borrow_mut() = message.into_bytes());
            -1
        }
    }
}
fn sheet(input: &[i32; 20]) -> Result<ScoreSheet, String> {
    let mut sheet = ScoreSheet::new();
    for (category, value) in Category::ALL.into_iter().zip(input.iter()) {
        if *value == -1 {
            continue;
        }
        let score = u16::try_from(*value).map_err(|_| "Invalid recorded score")?;
        sheet
            .fill_validated(category, score)
            .map_err(|e| e.to_string())?;
    }
    let bonus = input[13];
    if bonus < 0
        || bonus % 100 != 0
        || bonus > (sheet.filled_count().saturating_sub(1) * 100) as i32
        || (bonus > 0 && !sheet.yahtzee_scored_50())
    {
        return Err("Invalid Yahtzee bonus".into());
    }
    sheet.set_yahtzee_bonus_count((bonus / 100) as u16);
    Ok(sheet)
}
fn dice(input: &[i32; 20]) -> Result<Dice, String> {
    let mut values = [0; 5];
    for (i, value) in values.iter_mut().enumerate() {
        *value = u8::try_from(input[14 + i]).map_err(|_| "Invalid die")?;
    }
    Dice::new(values).map_err(|e| e.to_string())
}
fn state(input: &[i32; 20]) -> Result<GameState, String> {
    let rolls = u8::try_from(input[19]).map_err(|_| "Invalid roll count")?;
    GameState::from_parts(Some(dice(input)?), rolls, sheet(input)?).map_err(|e| e.to_string())
}
fn write_sheet(sheet: &ScoreSheet, out: &mut [i32; 20]) {
    for (i, score) in sheet.scores().iter().enumerate() {
        out[i] = score.map_or(-1, i32::from);
    }
    out[13] = i32::from(sheet.yahtzee_bonus_score());
}

/// 0 validate, 1 preview, 2 score, 3 totals. Input: 13 scores (-1 empty),
/// bonus points, 5 unsorted dice, rolls used. Output defined per operation.
#[unsafe(no_mangle)]
pub extern "C" fn rules(operation: u32, category: usize) -> i32 {
    checked(|| {
        INPUT.with(|input| {
            OUTPUT.with(|output| {
                let input = input.borrow();
                let sheet = sheet(&input)?;
                let mut out = output.borrow_mut();
                out.fill(-1);
                match operation {
                    0 => {}
                    1 => {
                        let dice = dice(&input)?;
                        for category in
                            Rules::legal_score_categories_with_ruleset(RULESET, &sheet, dice)
                        {
                            out[category.index()] = i32::from(
                                Rules::score_with_ruleset(RULESET, category, dice, &sheet)
                                    .base_score,
                            );
                        }
                    }
                    2 => {
                        let state = state(&input)?;
                        let category = Category::from_index(category).ok_or("Invalid category")?;
                        let next = Rules::apply_score_with_ruleset(RULESET, &state, category)
                            .map_err(|e| e.to_string())?;
                        write_sheet(next.sheet(), &mut out);
                    }
                    3 => {
                        out[0] = sheet.upper_subtotal().into();
                        out[1] = sheet.upper_bonus_score().into();
                        out[2] = sheet.yahtzee_bonus_score().into();
                        out[3] = sheet.total_score().into();
                    }
                    _ => return Err("Unknown rules operation".into()),
                }
                Ok(())
            })
        })
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn table_buffer(length: usize) -> *mut u8 {
    TABLE_BYTES.with(|v| {
        let mut v = v.borrow_mut();
        v.resize(length, 0);
        v.as_mut_ptr()
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn initialize() -> i32 {
    AGENT.with(|agent| *agent.borrow_mut() = None);
    let bytes = TABLE_BYTES.with(|v| std::mem::take(&mut *v.borrow_mut()));
    checked(|| {
        let table = AnchorValueTable::from_bytes(&bytes).map_err(|e| e.to_string())?;
        if table.ruleset() != RULESET {
            return Err("The exact table must use BuddyBoardGames rules".into());
        }
        // Partial build checkpoints have valid headers/checksums but cannot power a full game.
        if table.completed_open_layers() != (0..=13).collect::<Vec<_>>() {
            return Err("The exact table is incomplete".into());
        }
        AGENT.with(|agent| *agent.borrow_mut() = Some(ExactTableAgent::new(table)));
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn decide() -> i32 {
    checked(|| {
        INPUT.with(|input| {
            let input = input.borrow();
            let state = state(&input)?;
            let decision = AGENT.with(|agent| {
                agent
                    .borrow_mut()
                    .as_mut()
                    .ok_or_else(|| "Exact table is not ready".to_string())?
                    .best_decision(&state)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "No decision for a completed sheet".to_string())
            })?;
            OUTPUT.with(|out| {
                let mut out = out.borrow_mut();
                match decision.action {
                    Action::Score { category } => {
                        out[0] = 1;
                        out[1] = category.index() as i32;
                    }
                    Action::Roll { hold_mask } => {
                        // Keiri sorts dice; translate its mask back to the caller's visible order.
                        let mut kept = [0u8; 7];
                        for face in state.dice().unwrap().kept_by_mask(hold_mask).unwrap() {
                            kept[face as usize] += 1;
                        }
                        let mut mask = 0;
                        for i in 0..5 {
                            let face = input[14 + i] as usize;
                            if kept[face] > 0 {
                                mask |= 1 << i;
                                kept[face] -= 1;
                            }
                        }
                        out[0] = 0;
                        out[1] = mask;
                    }
                }
            });
            Ok(())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_shipped_table_is_valid_and_complete() {
        let bytes = include_bytes!("../assets/bbg-anchor-v2.bin");
        let table = AnchorValueTable::from_bytes(bytes).unwrap();
        assert_eq!(table.ruleset(), RULESET);
        assert_eq!(table.completed_open_layers(), (0..=13).collect::<Vec<_>>());
        assert!(table.value_for_sheet(&ScoreSheet::new()).unwrap() > 200.0);
    }
    #[test]
    fn rejects_validly_checksummed_partial_and_other_rules_tables() {
        for rules in [Ruleset::HasbroStrict, Ruleset::BuddyBoardGames] {
            let table = AnchorValueTable::build_limited(rules, 0).unwrap();
            TABLE_BYTES.with(|bytes| *bytes.borrow_mut() = table.to_bytes());
            assert_eq!(initialize(), -1);
            assert!(AGENT.with(|agent| agent.borrow().is_none()));
            let error = ERROR.with(|error| String::from_utf8(error.borrow().clone()).unwrap());
            assert!(error.contains(if rules == Ruleset::HasbroStrict {
                "BuddyBoardGames"
            } else {
                "incomplete"
            }));
        }
    }
    #[test]
    fn rejects_impossible_bonus() {
        let mut input = [-1; 20];
        input[13] = 100;
        assert!(sheet(&input).is_err());
    }
}
