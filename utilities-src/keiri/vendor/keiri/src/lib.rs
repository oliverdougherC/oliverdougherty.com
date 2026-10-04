use std::collections::HashMap;
use std::error::Error;
use std::fmt;
#[cfg(not(target_arch = "wasm32"))]
use std::fs;
#[cfg(not(target_arch = "wasm32"))]
use std::path::Path;
#[cfg(not(target_arch = "wasm32"))]
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc,
};
#[cfg(not(target_arch = "wasm32"))]
use std::thread;

pub const DICE_COUNT: usize = 5;
const DICE_STATE_COUNT: usize = 252;
pub const YAHTZEE_BONUS: u16 = 100;
pub const UPPER_BONUS: u16 = 35;
pub const UPPER_BONUS_THRESHOLD: u16 = 63;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeiriError {
    InvalidDie(u8),
    InvalidDiceCount(usize),
    InvalidHoldMask(u8),
    InvalidRollCount(u8),
    MissingDice,
    DiceAlreadyRolled,
    NoRollsRemaining,
    CategoryAlreadyFilled(Category),
    CategoryNotLegal(Category),
    InvalidRecordedScore { category: Category, score: u16 },
    InvalidBuddyBoardGamesSnapshot(String),
    InvalidTableSlice(String),
    InvalidAnchorTable(String),
    MissingAnchorValue(String),
    TerminalState,
    ParseError(String),
}

impl fmt::Display for KeiriError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeiriError::InvalidDie(value) => write!(f, "invalid die value {value}; expected 1..=6"),
            KeiriError::InvalidDiceCount(count) => {
                write!(f, "invalid dice count {count}; expected {DICE_COUNT}")
            }
            KeiriError::InvalidHoldMask(mask) => {
                write!(f, "invalid hold mask {mask}; expected a five-bit mask")
            }
            KeiriError::InvalidRollCount(count) => {
                write!(f, "invalid roll count {count}; expected 0..=3")
            }
            KeiriError::MissingDice => write!(f, "the state has no dice to score"),
            KeiriError::DiceAlreadyRolled => write!(f, "starting a turn cannot hold existing dice"),
            KeiriError::NoRollsRemaining => write!(f, "no rolls remain in this turn"),
            KeiriError::CategoryAlreadyFilled(category) => {
                write!(f, "{category} is already filled")
            }
            KeiriError::CategoryNotLegal(category) => {
                write!(f, "{category} is not legal in this state")
            }
            KeiriError::InvalidRecordedScore { category, score } => {
                write!(f, "{score} is not a valid recorded score for {category}")
            }
            KeiriError::InvalidBuddyBoardGamesSnapshot(message) => write!(f, "{message}"),
            KeiriError::InvalidTableSlice(message) => write!(f, "{message}"),
            KeiriError::InvalidAnchorTable(message) => write!(f, "{message}"),
            KeiriError::MissingAnchorValue(message) => write!(f, "{message}"),
            KeiriError::TerminalState => write!(f, "the game is already terminal"),
            KeiriError::ParseError(message) => write!(f, "{message}"),
        }
    }
}

impl Error for KeiriError {}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum Ruleset {
    #[default]
    HasbroStrict,
    BuddyBoardGames,
}

impl Ruleset {
    pub fn from_name(name: &str) -> Option<Self> {
        match normalize_name(name).as_str() {
            "hasbro" | "hasbrostrict" | "strict" => Some(Self::HasbroStrict),
            "buddyboardgames" | "bbg" | "buddy" => Some(Self::BuddyBoardGames),
            _ => None,
        }
    }
}

impl fmt::Display for Ruleset {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Ruleset::HasbroStrict => f.write_str("hasbro"),
            Ruleset::BuddyBoardGames => f.write_str("buddyboardgames"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Category {
    Ones,
    Twos,
    Threes,
    Fours,
    Fives,
    Sixes,
    ThreeKind,
    FourKind,
    FullHouse,
    SmallStraight,
    LargeStraight,
    Yahtzee,
    Chance,
}

impl Category {
    pub const ALL: [Category; 13] = [
        Category::Ones,
        Category::Twos,
        Category::Threes,
        Category::Fours,
        Category::Fives,
        Category::Sixes,
        Category::ThreeKind,
        Category::FourKind,
        Category::FullHouse,
        Category::SmallStraight,
        Category::LargeStraight,
        Category::Yahtzee,
        Category::Chance,
    ];

    pub const UPPER: [Category; 6] = [
        Category::Ones,
        Category::Twos,
        Category::Threes,
        Category::Fours,
        Category::Fives,
        Category::Sixes,
    ];

    pub const LOWER: [Category; 7] = [
        Category::ThreeKind,
        Category::FourKind,
        Category::FullHouse,
        Category::SmallStraight,
        Category::LargeStraight,
        Category::Yahtzee,
        Category::Chance,
    ];

    pub fn index(self) -> usize {
        match self {
            Category::Ones => 0,
            Category::Twos => 1,
            Category::Threes => 2,
            Category::Fours => 3,
            Category::Fives => 4,
            Category::Sixes => 5,
            Category::ThreeKind => 6,
            Category::FourKind => 7,
            Category::FullHouse => 8,
            Category::SmallStraight => 9,
            Category::LargeStraight => 10,
            Category::Yahtzee => 11,
            Category::Chance => 12,
        }
    }

    pub fn from_index(index: usize) -> Option<Self> {
        Self::ALL.get(index).copied()
    }

    pub fn is_upper(self) -> bool {
        self.index() < 6
    }

    pub fn upper_face(self) -> Option<u8> {
        match self {
            Category::Ones => Some(1),
            Category::Twos => Some(2),
            Category::Threes => Some(3),
            Category::Fours => Some(4),
            Category::Fives => Some(5),
            Category::Sixes => Some(6),
            _ => None,
        }
    }

    pub fn upper_for_face(face: u8) -> Option<Self> {
        match face {
            1 => Some(Category::Ones),
            2 => Some(Category::Twos),
            3 => Some(Category::Threes),
            4 => Some(Category::Fours),
            5 => Some(Category::Fives),
            6 => Some(Category::Sixes),
            _ => None,
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        let normalized = normalize_name(name);
        match normalized.as_str() {
            "ones" | "one" | "aces" | "ace" => Some(Category::Ones),
            "twos" | "two" => Some(Category::Twos),
            "threes" | "three" => Some(Category::Threes),
            "fours" | "four" => Some(Category::Fours),
            "fives" | "five" => Some(Category::Fives),
            "sixes" | "six" => Some(Category::Sixes),
            "threekind" | "threeofakind" | "3kind" | "3ofakind" => Some(Category::ThreeKind),
            "fourkind" | "fourofakind" | "4kind" | "4ofakind" => Some(Category::FourKind),
            "fullhouse" => Some(Category::FullHouse),
            "smallstraight" | "smstraight" => Some(Category::SmallStraight),
            "largestraight" | "lgstraight" => Some(Category::LargeStraight),
            "yahtzee" | "yatzy" => Some(Category::Yahtzee),
            "chance" => Some(Category::Chance),
            _ => None,
        }
    }
}

impl fmt::Display for Category {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Category::Ones => "ones",
            Category::Twos => "twos",
            Category::Threes => "threes",
            Category::Fours => "fours",
            Category::Fives => "fives",
            Category::Sixes => "sixes",
            Category::ThreeKind => "three-kind",
            Category::FourKind => "four-kind",
            Category::FullHouse => "full-house",
            Category::SmallStraight => "small-straight",
            Category::LargeStraight => "large-straight",
            Category::Yahtzee => "yahtzee",
            Category::Chance => "chance",
        };
        f.write_str(name)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Dice {
    values: [u8; DICE_COUNT],
}

impl Dice {
    pub fn new(mut values: [u8; DICE_COUNT]) -> Result<Self, KeiriError> {
        for value in values {
            if !(1..=6).contains(&value) {
                return Err(KeiriError::InvalidDie(value));
            }
        }
        values.sort_unstable();
        Ok(Self { values })
    }

    pub fn from_slice(values: &[u8]) -> Result<Self, KeiriError> {
        let array: [u8; DICE_COUNT] = values
            .try_into()
            .map_err(|_| KeiriError::InvalidDiceCount(values.len()))?;
        Self::new(array)
    }

    pub fn parse(input: &str) -> Result<Self, KeiriError> {
        let values = input
            .split(',')
            .map(|part| {
                part.trim().parse::<u8>().map_err(|_| {
                    KeiriError::ParseError(format!("invalid die value `{}`", part.trim()))
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Self::from_slice(&values)
    }

    pub fn values(self) -> [u8; DICE_COUNT] {
        self.values
    }

    pub fn all_canonical() -> Vec<Self> {
        fn walk(start: u8, depth: usize, values: &mut Vec<u8>, output: &mut Vec<Dice>) {
            if depth == DICE_COUNT {
                let array: [u8; DICE_COUNT] = values
                    .as_slice()
                    .try_into()
                    .expect("canonical dice builder always emits five dice");
                output.push(Dice::new(array).expect("canonical dice builder emits valid faces"));
                return;
            }

            for face in start..=6 {
                values.push(face);
                walk(face, depth + 1, values, output);
                values.pop();
            }
        }

        let mut output = Vec::new();
        let mut values = Vec::with_capacity(DICE_COUNT);
        walk(1, 0, &mut values, &mut output);
        output
    }

    pub fn sum(self) -> u16 {
        self.values.iter().map(|value| u16::from(*value)).sum()
    }

    pub fn counts(self) -> [u8; 7] {
        let mut counts = [0; 7];
        for value in self.values {
            counts[usize::from(value)] += 1;
        }
        counts
    }

    pub fn is_yahtzee(self) -> bool {
        self.values[0] == self.values[DICE_COUNT - 1]
    }

    pub fn yahtzee_face(self) -> Option<u8> {
        self.is_yahtzee().then_some(self.values[0])
    }

    pub fn kept_by_mask(self, mask: u8) -> Result<Vec<u8>, KeiriError> {
        validate_hold_mask(mask)?;
        Ok(self
            .values
            .iter()
            .enumerate()
            .filter_map(|(index, value)| ((mask & (1 << index)) != 0).then_some(*value))
            .collect())
    }
}

impl fmt::Display for Dice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, value) in self.values.iter().enumerate() {
            if index > 0 {
                f.write_str(",")?;
            }
            write!(f, "{value}")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ScoreSheet {
    scores: [Option<u16>; 13],
    yahtzee_bonus_count: u16,
}

impl Default for ScoreSheet {
    fn default() -> Self {
        Self::new()
    }
}

impl ScoreSheet {
    pub fn new() -> Self {
        Self {
            scores: [None; 13],
            yahtzee_bonus_count: 0,
        }
    }

    pub fn scores(&self) -> &[Option<u16>; 13] {
        &self.scores
    }

    pub fn score(&self, category: Category) -> Option<u16> {
        self.scores[category.index()]
    }

    pub fn filled_scores(&self) -> Vec<(Category, u16)> {
        Category::ALL
            .iter()
            .filter_map(|category| self.score(*category).map(|score| (*category, score)))
            .collect()
    }

    pub fn fill_raw(&mut self, category: Category, score: u16) -> Result<(), KeiriError> {
        if self.is_filled(category) {
            return Err(KeiriError::CategoryAlreadyFilled(category));
        }
        self.scores[category.index()] = Some(score);
        Ok(())
    }

    pub fn fill_validated(&mut self, category: Category, score: u16) -> Result<(), KeiriError> {
        if !Rules::is_valid_recorded_score(category, score) {
            return Err(KeiriError::InvalidRecordedScore { category, score });
        }
        self.fill_raw(category, score)
    }

    pub fn set_yahtzee_bonus_count(&mut self, count: u16) {
        self.yahtzee_bonus_count = count;
    }

    pub fn add_yahtzee_bonus(&mut self) {
        self.yahtzee_bonus_count += 1;
    }

    pub fn yahtzee_bonus_count(&self) -> u16 {
        self.yahtzee_bonus_count
    }

    pub fn is_filled(&self, category: Category) -> bool {
        self.score(category).is_some()
    }

    pub fn filled_count(&self) -> usize {
        self.scores.iter().flatten().count()
    }

    pub fn filled_mask(&self) -> u16 {
        Category::ALL.iter().fold(0u16, |mask, category| {
            if self.is_filled(*category) {
                mask | (1 << category.index())
            } else {
                mask
            }
        })
    }

    pub fn remaining_categories(&self) -> Vec<Category> {
        Category::ALL
            .iter()
            .copied()
            .filter(|category| !self.is_filled(*category))
            .collect()
    }

    pub fn is_complete(&self) -> bool {
        self.filled_count() == Category::ALL.len()
    }

    pub fn upper_subtotal(&self) -> u16 {
        Category::UPPER
            .iter()
            .filter_map(|category| self.score(*category))
            .sum()
    }

    pub fn upper_subtotal_capped(&self) -> u8 {
        self.upper_subtotal().min(UPPER_BONUS_THRESHOLD) as u8
    }

    pub fn has_upper_bonus(&self) -> bool {
        self.upper_subtotal() >= UPPER_BONUS_THRESHOLD
    }

    pub fn upper_bonus_score(&self) -> u16 {
        if self.has_upper_bonus() {
            UPPER_BONUS
        } else {
            0
        }
    }

    pub fn yahtzee_bonus_score(&self) -> u16 {
        self.yahtzee_bonus_count * YAHTZEE_BONUS
    }

    pub fn yahtzee_scored_50(&self) -> bool {
        self.score(Category::Yahtzee) == Some(50)
    }

    pub fn total_score(&self) -> u16 {
        self.scores.iter().flatten().sum::<u16>()
            + self.upper_bonus_score()
            + self.yahtzee_bonus_score()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct GameState {
    dice: Option<Dice>,
    rolls_used: u8,
    sheet: ScoreSheet,
}

impl Default for GameState {
    fn default() -> Self {
        Self::new()
    }
}

impl GameState {
    pub fn new() -> Self {
        Self {
            dice: None,
            rolls_used: 0,
            sheet: ScoreSheet::new(),
        }
    }

    pub fn from_parts(
        dice: Option<Dice>,
        rolls_used: u8,
        sheet: ScoreSheet,
    ) -> Result<Self, KeiriError> {
        if rolls_used > 3 {
            return Err(KeiriError::InvalidRollCount(rolls_used));
        }
        if dice.is_none() && rolls_used != 0 {
            return Err(KeiriError::InvalidRollCount(rolls_used));
        }
        if dice.is_some() && rolls_used == 0 {
            return Err(KeiriError::InvalidRollCount(rolls_used));
        }
        Ok(Self {
            dice,
            rolls_used,
            sheet,
        })
    }

    pub fn dice(&self) -> Option<Dice> {
        self.dice
    }

    pub fn rolls_used(&self) -> u8 {
        self.rolls_used
    }

    pub fn sheet(&self) -> &ScoreSheet {
        &self.sheet
    }

    pub fn is_terminal(&self) -> bool {
        self.sheet.is_complete()
    }

    pub fn to_compact(&self) -> String {
        let mut parts = Vec::new();
        match self.dice {
            Some(dice) => parts.push(format!("dice={dice}")),
            None => parts.push("dice=none".to_string()),
        }
        parts.push(format!("rolls={}", self.rolls_used));
        let scores = self
            .sheet
            .filled_scores()
            .into_iter()
            .map(|(category, score)| format!("{category}:{score}"))
            .collect::<Vec<_>>()
            .join(",");
        if !scores.is_empty() {
            parts.push(format!("scores={scores}"));
        }
        if self.sheet.yahtzee_bonus_count() > 0 {
            parts.push(format!(
                "yahtzee_bonus={}",
                self.sheet.yahtzee_bonus_count()
            ));
        }
        parts.join(" ")
    }

    pub fn parse_compact(input: &str) -> Result<Self, KeiriError> {
        parse_compact_state_tokens(input.split_whitespace())
    }

    pub fn parse_compact_tokens<'a, I>(tokens: I) -> Result<Self, KeiriError>
    where
        I: IntoIterator<Item = &'a str>,
    {
        parse_compact_state_tokens(tokens)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Action {
    Roll { hold_mask: u8 },
    Score { category: Category },
}

impl fmt::Display for Action {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Action::Roll { hold_mask } => write!(f, "roll hold_mask={hold_mask:05b}"),
            Action::Score { category } => write!(f, "score {category}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScoreResult {
    pub category: Category,
    pub base_score: u16,
    pub yahtzee_bonus: u16,
    pub upper_bonus: u16,
    pub total_delta: u16,
}

pub struct Rules;

impl Rules {
    pub fn max_base_score(category: Category) -> u16 {
        match category {
            Category::Ones => 5,
            Category::Twos => 10,
            Category::Threes => 15,
            Category::Fours => 20,
            Category::Fives => 25,
            Category::Sixes => 30,
            Category::ThreeKind | Category::FourKind | Category::Chance => 30,
            Category::FullHouse => 25,
            Category::SmallStraight => 30,
            Category::LargeStraight => 40,
            Category::Yahtzee => 50,
        }
    }

    pub fn is_valid_recorded_score(category: Category, score: u16) -> bool {
        match category {
            Category::Ones => score <= Self::max_base_score(category),
            Category::Twos => score <= Self::max_base_score(category) && score.is_multiple_of(2),
            Category::Threes => score <= Self::max_base_score(category) && score.is_multiple_of(3),
            Category::Fours => score <= Self::max_base_score(category) && score.is_multiple_of(4),
            Category::Fives => score <= Self::max_base_score(category) && score.is_multiple_of(5),
            Category::Sixes => score <= Self::max_base_score(category) && score.is_multiple_of(6),
            Category::ThreeKind | Category::FourKind | Category::Chance => {
                score <= Self::max_base_score(category)
            }
            Category::FullHouse => matches!(score, 0 | 25),
            Category::SmallStraight => matches!(score, 0 | 30),
            Category::LargeStraight => matches!(score, 0 | 40),
            Category::Yahtzee => matches!(score, 0 | 50),
        }
    }

    pub fn score(category: Category, dice: Dice, sheet: &ScoreSheet) -> ScoreResult {
        Self::score_with_ruleset(Ruleset::HasbroStrict, category, dice, sheet)
    }

    pub fn score_with_ruleset(
        ruleset: Ruleset,
        category: Category,
        dice: Dice,
        sheet: &ScoreSheet,
    ) -> ScoreResult {
        let yahtzee_bonus = if Self::earns_yahtzee_bonus(dice, sheet) {
            YAHTZEE_BONUS
        } else {
            0
        };
        let base_score = Self::base_score(
            category,
            dice,
            Self::joker_active_with_ruleset(ruleset, dice, sheet),
        );
        let upper_before = sheet.upper_subtotal();
        let upper_bonus = if category.is_upper()
            && upper_before < UPPER_BONUS_THRESHOLD
            && upper_before + base_score >= UPPER_BONUS_THRESHOLD
        {
            UPPER_BONUS
        } else {
            0
        };

        ScoreResult {
            category,
            base_score,
            yahtzee_bonus,
            upper_bonus,
            total_delta: base_score + yahtzee_bonus + upper_bonus,
        }
    }

    pub fn legal_actions(state: &GameState) -> Vec<Action> {
        Self::legal_actions_with_ruleset(Ruleset::HasbroStrict, state)
    }

    pub fn legal_actions_with_ruleset(ruleset: Ruleset, state: &GameState) -> Vec<Action> {
        if state.is_terminal() {
            return Vec::new();
        }

        let mut actions = Vec::new();
        match state.dice {
            None => actions.push(Action::Roll { hold_mask: 0 }),
            Some(dice) => {
                if state.rolls_used < 3 {
                    actions.extend((0..32).map(|hold_mask| Action::Roll { hold_mask }));
                }
                actions.extend(
                    Self::legal_score_categories_with_ruleset(ruleset, state.sheet(), dice)
                        .into_iter()
                        .map(|category| Action::Score { category }),
                );
            }
        }
        actions
    }

    pub fn legal_score_categories(sheet: &ScoreSheet, dice: Dice) -> Vec<Category> {
        Self::legal_score_categories_with_ruleset(Ruleset::HasbroStrict, sheet, dice)
    }

    pub fn legal_score_categories_with_ruleset(
        ruleset: Ruleset,
        sheet: &ScoreSheet,
        dice: Dice,
    ) -> Vec<Category> {
        if ruleset == Ruleset::BuddyBoardGames {
            return sheet.remaining_categories();
        }

        if !Self::forced_joker_active_with_ruleset(ruleset, dice, sheet) {
            return sheet.remaining_categories();
        }

        let face = dice.yahtzee_face().expect("forced-joker dice are yahtzee");
        let matching_upper = Category::upper_for_face(face).expect("die face has upper category");
        if !sheet.is_filled(matching_upper) {
            return vec![matching_upper];
        }

        let lower: Vec<Category> = Category::LOWER
            .iter()
            .copied()
            .filter(|category| !sheet.is_filled(*category))
            .collect();
        if !lower.is_empty() {
            return lower;
        }

        Category::UPPER
            .iter()
            .copied()
            .filter(|category| !sheet.is_filled(*category))
            .collect()
    }

    pub fn apply_score(state: &GameState, category: Category) -> Result<GameState, KeiriError> {
        Self::apply_score_with_ruleset(Ruleset::HasbroStrict, state, category)
    }

    pub fn apply_score_with_ruleset(
        ruleset: Ruleset,
        state: &GameState,
        category: Category,
    ) -> Result<GameState, KeiriError> {
        if state.is_terminal() {
            return Err(KeiriError::TerminalState);
        }
        let dice = state.dice.ok_or(KeiriError::MissingDice)?;
        if state.sheet.is_filled(category) {
            return Err(KeiriError::CategoryAlreadyFilled(category));
        }
        if !Self::legal_score_categories_with_ruleset(ruleset, &state.sheet, dice)
            .contains(&category)
        {
            return Err(KeiriError::CategoryNotLegal(category));
        }

        let result = Self::score_with_ruleset(ruleset, category, dice, &state.sheet);
        let mut sheet = state.sheet.clone();
        sheet.fill_raw(category, result.base_score)?;
        if result.yahtzee_bonus > 0 {
            sheet.add_yahtzee_bonus();
        }
        GameState::from_parts(None, 0, sheet)
    }

    pub fn apply_roll(
        state: &GameState,
        hold_mask: u8,
        rolled_faces: &[u8],
    ) -> Result<GameState, KeiriError> {
        if state.is_terminal() {
            return Err(KeiriError::TerminalState);
        }
        validate_hold_mask(hold_mask)?;

        let mut next_faces = match state.dice {
            None => {
                if hold_mask != 0 {
                    return Err(KeiriError::DiceAlreadyRolled);
                }
                Vec::new()
            }
            Some(dice) => {
                if state.rolls_used >= 3 {
                    return Err(KeiriError::NoRollsRemaining);
                }
                dice.kept_by_mask(hold_mask)?
            }
        };

        let expected_rolls = DICE_COUNT - next_faces.len();
        if rolled_faces.len() != expected_rolls {
            return Err(KeiriError::InvalidDiceCount(rolled_faces.len()));
        }
        next_faces.extend_from_slice(rolled_faces);
        let dice = Dice::from_slice(&next_faces)?;
        GameState::from_parts(Some(dice), state.rolls_used + 1, state.sheet.clone())
    }

    pub fn joker_active(dice: Dice, sheet: &ScoreSheet) -> bool {
        Self::joker_active_with_ruleset(Ruleset::HasbroStrict, dice, sheet)
    }

    pub fn joker_active_with_ruleset(ruleset: Ruleset, dice: Dice, sheet: &ScoreSheet) -> bool {
        if !dice.is_yahtzee() {
            return false;
        }
        let Some(face) = dice.yahtzee_face() else {
            return false;
        };
        let Some(matching_upper) = Category::upper_for_face(face) else {
            return false;
        };

        match ruleset {
            Ruleset::HasbroStrict => sheet.yahtzee_scored_50() && sheet.is_filled(matching_upper),
            Ruleset::BuddyBoardGames => {
                sheet.is_filled(Category::Yahtzee) && sheet.is_filled(matching_upper)
            }
        }
    }

    fn forced_joker_active_with_ruleset(ruleset: Ruleset, dice: Dice, sheet: &ScoreSheet) -> bool {
        match ruleset {
            Ruleset::HasbroStrict => dice.is_yahtzee() && sheet.yahtzee_scored_50(),
            Ruleset::BuddyBoardGames => false,
        }
    }

    fn earns_yahtzee_bonus(dice: Dice, sheet: &ScoreSheet) -> bool {
        dice.is_yahtzee() && sheet.yahtzee_scored_50()
    }

    fn base_score(category: Category, dice: Dice, joker_active: bool) -> u16 {
        if joker_active {
            match category {
                Category::FullHouse => return 25,
                Category::SmallStraight => return 30,
                Category::LargeStraight => return 40,
                _ => {}
            }
        }

        let counts = dice.counts();
        match category {
            Category::Ones
            | Category::Twos
            | Category::Threes
            | Category::Fours
            | Category::Fives
            | Category::Sixes => {
                let face = category.upper_face().expect("upper category has face");
                u16::from(counts[usize::from(face)]) * u16::from(face)
            }
            Category::ThreeKind => {
                if counts.iter().any(|count| *count >= 3) {
                    dice.sum()
                } else {
                    0
                }
            }
            Category::FourKind => {
                if counts.iter().any(|count| *count >= 4) {
                    dice.sum()
                } else {
                    0
                }
            }
            Category::FullHouse => {
                if counts.contains(&3) && counts.contains(&2) {
                    25
                } else {
                    0
                }
            }
            Category::SmallStraight => {
                let has = |face: usize| counts[face] > 0;
                if (has(1) && has(2) && has(3) && has(4))
                    || (has(2) && has(3) && has(4) && has(5))
                    || (has(3) && has(4) && has(5) && has(6))
                {
                    30
                } else {
                    0
                }
            }
            Category::LargeStraight => {
                if counts[1..=5].iter().all(|count| *count == 1)
                    || counts[2..=6].iter().all(|count| *count == 1)
                {
                    40
                } else {
                    0
                }
            }
            Category::Yahtzee => {
                if dice.is_yahtzee() {
                    50
                } else {
                    0
                }
            }
            Category::Chance => dice.sum(),
        }
    }
}

pub trait Agent {
    fn select_action(&mut self, state: &GameState) -> Option<Action>;
    fn explain(&mut self, state: &GameState) -> String;
    fn confidence(&self, _state: &GameState) -> f64 {
        1.0
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub action: Action,
    pub expected_value: f64,
    pub source: DecisionSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionSource {
    RecursiveOracle,
    ExactTable,
    Heuristic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct OracleKey {
    dice: Option<Dice>,
    rolls_used: u8,
    filled_mask: u16,
    upper_subtotal_capped: u8,
    yahtzee_scored_50: bool,
}

impl OracleKey {
    fn from_state(state: &GameState) -> Self {
        Self {
            dice: state.dice,
            rolls_used: state.rolls_used,
            filled_mask: state.sheet.filled_mask(),
            upper_subtotal_capped: state.sheet.upper_subtotal_capped(),
            yahtzee_scored_50: state.sheet.yahtzee_scored_50(),
        }
    }
}

pub struct OptimalAgent {
    ruleset: Ruleset,
    cache: HashMap<OracleKey, f64>,
    distributions: Vec<Vec<(Vec<u8>, u32)>>,
}

impl Default for OptimalAgent {
    fn default() -> Self {
        Self::new()
    }
}

impl OptimalAgent {
    pub fn new() -> Self {
        Self::with_ruleset(Ruleset::HasbroStrict)
    }

    pub fn with_ruleset(ruleset: Ruleset) -> Self {
        Self {
            ruleset,
            cache: HashMap::new(),
            distributions: build_distributions(),
        }
    }

    pub fn cache_len(&self) -> usize {
        self.cache.len()
    }

    pub fn clear_cache(&mut self) {
        self.cache.clear();
    }

    pub fn expected_value(&mut self, state: &GameState) -> f64 {
        self.value(state)
    }

    pub fn best_action(&mut self, state: &GameState) -> Option<Decision> {
        if state.is_terminal() {
            return None;
        }

        let mut best: Option<Decision> = None;
        for action in Rules::legal_actions_with_ruleset(self.ruleset, state) {
            let expected_value = self.action_value(state, action);
            if best
                .as_ref()
                .is_none_or(|current| expected_value > current.expected_value)
            {
                best = Some(Decision {
                    action,
                    expected_value,
                    source: DecisionSource::RecursiveOracle,
                });
            }
        }
        best
    }

    pub fn reroll_distribution(&self, dice_count: usize) -> Option<&[(Vec<u8>, u32)]> {
        self.distributions.get(dice_count).map(Vec::as_slice)
    }

    fn value(&mut self, state: &GameState) -> f64 {
        if state.is_terminal() {
            return 0.0;
        }
        let key = OracleKey::from_state(state);
        if let Some(value) = self.cache.get(&key) {
            return *value;
        }

        let value = self
            .best_action(state)
            .map(|decision| decision.expected_value)
            .unwrap_or(0.0);
        self.cache.insert(key, value);
        value
    }

    fn action_value(&mut self, state: &GameState, action: Action) -> f64 {
        match action {
            Action::Score { category } => {
                match Rules::apply_score_with_ruleset(self.ruleset, state, category) {
                    Ok(next) => {
                        let dice = state.dice.expect("score actions require dice");
                        f64::from(
                            Rules::score_with_ruleset(self.ruleset, category, dice, &state.sheet)
                                .total_delta,
                        ) + self.value(&next)
                    }
                    Err(_) => f64::NEG_INFINITY,
                }
            }
            Action::Roll { hold_mask } => self.roll_action_value(state, hold_mask),
        }
    }

    fn roll_action_value(&mut self, state: &GameState, hold_mask: u8) -> f64 {
        let kept = match state.dice {
            None => Vec::new(),
            Some(dice) => match dice.kept_by_mask(hold_mask) {
                Ok(kept) => kept,
                Err(_) => return f64::NEG_INFINITY,
            },
        };
        let reroll_count = DICE_COUNT - kept.len();
        let distribution = self.distributions[reroll_count].clone();
        let denominator = 6u32.pow(reroll_count as u32);
        let weighted_sum = distribution
            .iter()
            .map(|(rolled_faces, weight)| {
                let mut faces = kept.clone();
                faces.extend_from_slice(rolled_faces);
                let next = match Rules::apply_roll(state, hold_mask, &faces[kept.len()..]) {
                    Ok(next) => next,
                    Err(_) => return f64::NEG_INFINITY,
                };
                self.value(&next) * f64::from(*weight)
            })
            .sum::<f64>();
        weighted_sum / f64::from(denominator)
    }
}

impl Agent for OptimalAgent {
    fn select_action(&mut self, state: &GameState) -> Option<Action> {
        self.best_action(state).map(|decision| decision.action)
    }

    fn explain(&mut self, state: &GameState) -> String {
        match self.best_action(state) {
            Some(decision) => format!(
                "optimal action is `{}` with expected future value {:.3}",
                decision.action, decision.expected_value
            ),
            None => "terminal state; no action available".to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OracleTableRow {
    pub state: GameState,
    pub best_action: Option<Action>,
    pub expected_value: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OracleTable {
    rows: Vec<OracleTableRow>,
    cache_states: usize,
}

impl OracleTable {
    pub fn build_endgame(sheet: ScoreSheet, rolls_used: &[u8]) -> Result<Self, KeiriError> {
        let remaining = sheet.remaining_categories();
        if remaining.len() != 1 {
            return Err(KeiriError::InvalidTableSlice(format!(
                "endgame table slices require exactly one open category; found {}",
                remaining.len()
            )));
        }
        if rolls_used.is_empty() {
            return Err(KeiriError::InvalidTableSlice(
                "table slice requires at least one roll depth".to_string(),
            ));
        }
        for roll_count in rolls_used {
            if !(1..=3).contains(roll_count) {
                return Err(KeiriError::InvalidRollCount(*roll_count));
            }
        }

        let mut agent = OptimalAgent::new();
        let mut rows = Vec::with_capacity(Dice::all_canonical().len() * rolls_used.len());
        for roll_count in rolls_used {
            for dice in Dice::all_canonical() {
                let state = GameState::from_parts(Some(dice), *roll_count, sheet.clone())?;
                let decision = agent.best_action(&state);
                rows.push(OracleTableRow {
                    state,
                    best_action: decision.as_ref().map(|decision| decision.action),
                    expected_value: decision.map_or(0.0, |decision| decision.expected_value),
                });
            }
        }

        Ok(Self {
            rows,
            cache_states: agent.cache_len(),
        })
    }

    pub fn rows(&self) -> &[OracleTableRow] {
        &self.rows
    }

    pub fn cache_states(&self) -> usize {
        self.cache_states
    }

    pub fn to_tsv(&self) -> String {
        let mut output = String::from("state\taction\texpected_value\n");
        for row in &self.rows {
            let action = row
                .best_action
                .map_or_else(|| "terminal".to_string(), |action| action.to_string());
            output.push_str(&format!(
                "{}\t{}\t{:.6}\n",
                row.state.to_compact(),
                action,
                row.expected_value
            ));
        }
        output
    }
}

const ANCHOR_TABLE_MAGIC: &[u8; 8] = b"KEIRIAT1";
const ANCHOR_TABLE_VERSION: u32 = 2;
const ANCHOR_MASK_COUNT: usize = 1 << 13;
const ANCHOR_UPPER_COUNT: usize = 64;
const ANCHOR_YAHTZEE_STATE_COUNT: usize = 3;
const ANCHOR_VALUE_COUNT: usize =
    ANCHOR_MASK_COUNT * ANCHOR_UPPER_COUNT * ANCHOR_YAHTZEE_STATE_COUNT;
const EXACT_TIE_EPSILON: f64 = 1e-12;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AnchorYahtzeeState {
    Open,
    Zero,
    Fifty,
}

impl AnchorYahtzeeState {
    fn to_u8(self) -> u8 {
        match self {
            AnchorYahtzeeState::Open => 0,
            AnchorYahtzeeState::Zero => 1,
            AnchorYahtzeeState::Fifty => 2,
        }
    }

    fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(AnchorYahtzeeState::Open),
            1 => Some(AnchorYahtzeeState::Zero),
            2 => Some(AnchorYahtzeeState::Fifty),
            _ => None,
        }
    }
}

impl fmt::Display for AnchorYahtzeeState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AnchorYahtzeeState::Open => f.write_str("open"),
            AnchorYahtzeeState::Zero => f.write_str("zero"),
            AnchorYahtzeeState::Fifty => f.write_str("fifty"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AnchorKey {
    pub filled_mask: u16,
    pub upper_subtotal_capped: u8,
    pub yahtzee_state: AnchorYahtzeeState,
}

impl AnchorKey {
    pub fn from_sheet(sheet: &ScoreSheet) -> Self {
        let yahtzee_state = match sheet.score(Category::Yahtzee) {
            None => AnchorYahtzeeState::Open,
            Some(0) => AnchorYahtzeeState::Zero,
            Some(50) => AnchorYahtzeeState::Fifty,
            Some(score) => {
                debug_assert!(
                    false,
                    "validated score sheets only allow Yahtzee scores 0 or 50, found {score}"
                );
                AnchorYahtzeeState::Zero
            }
        };
        Self {
            filled_mask: sheet.filled_mask(),
            upper_subtotal_capped: sheet.upper_subtotal_capped(),
            yahtzee_state,
        }
    }

    fn index(self) -> usize {
        ((usize::from(self.filled_mask) * ANCHOR_UPPER_COUNT
            + usize::from(self.upper_subtotal_capped))
            * ANCHOR_YAHTZEE_STATE_COUNT)
            + usize::from(self.yahtzee_state.to_u8())
    }

    fn has_category(self, category: Category) -> bool {
        (self.filled_mask & (1 << category.index())) != 0
    }
}

#[derive(Clone)]
pub struct AnchorValueTable {
    ruleset: Ruleset,
    values: Vec<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnchorBuildProgress {
    pub open_count: usize,
    pub total_open_count: usize,
    pub layer_states: usize,
    pub completed_layer_states: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorBuildStrategy {
    Dense,
    Recursive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnchorBuildOptions {
    pub threads: Option<usize>,
    pub strategy: AnchorBuildStrategy,
}

impl Default for AnchorBuildOptions {
    fn default() -> Self {
        Self {
            threads: None,
            strategy: AnchorBuildStrategy::Dense,
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl AnchorBuildOptions {
    fn thread_count(self) -> usize {
        self.threads
            .unwrap_or_else(|| {
                thread::available_parallelism()
                    .map(usize::from)
                    .unwrap_or(1)
            })
            .max(1)
    }
}

impl AnchorValueTable {
    #[cfg(not(target_arch = "wasm32"))]
    pub fn build(ruleset: Ruleset) -> Result<Self, KeiriError> {
        Self::build_limited(ruleset, Category::ALL.len())
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn build_limited(ruleset: Ruleset, max_open_categories: usize) -> Result<Self, KeiriError> {
        Self::build_limited_with_progress(ruleset, max_open_categories, |_| {})
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn build_limited_with_options(
        ruleset: Ruleset,
        max_open_categories: usize,
        options: AnchorBuildOptions,
    ) -> Result<Self, KeiriError> {
        Self::build_limited_with_options_and_progress(ruleset, max_open_categories, options, |_| {})
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn build_limited_with_progress<F>(
        ruleset: Ruleset,
        max_open_categories: usize,
        mut progress: F,
    ) -> Result<Self, KeiriError>
    where
        F: FnMut(AnchorBuildProgress),
    {
        Self::build_limited_with_options_and_progress(
            ruleset,
            max_open_categories,
            AnchorBuildOptions::default(),
            &mut progress,
        )
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn build_limited_with_options_and_progress<F>(
        ruleset: Ruleset,
        max_open_categories: usize,
        options: AnchorBuildOptions,
        mut progress: F,
    ) -> Result<Self, KeiriError>
    where
        F: FnMut(AnchorBuildProgress),
    {
        if max_open_categories > Category::ALL.len() {
            return Err(KeiriError::InvalidAnchorTable(format!(
                "max_open_categories must be 0..={}",
                Category::ALL.len()
            )));
        }

        let mut table = Self {
            ruleset,
            values: vec![f64::NAN; ANCHOR_VALUE_COUNT],
        };
        table.build_missing_layers_with_callbacks(
            max_open_categories,
            options,
            &mut progress,
            &mut |_, _| Ok(()),
        )?;
        Ok(table)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn build_from_partial_with_callbacks<F, G>(
        mut table: Self,
        max_open_categories: usize,
        mut progress: F,
        mut layer_done: G,
    ) -> Result<Self, KeiriError>
    where
        F: FnMut(AnchorBuildProgress),
        G: FnMut(usize, &Self) -> Result<(), KeiriError>,
    {
        table.build_missing_layers_with_callbacks(
            max_open_categories,
            AnchorBuildOptions::default(),
            &mut progress,
            &mut layer_done,
        )?;
        Ok(table)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn build_from_partial_with_options_and_callbacks<F, G>(
        mut table: Self,
        max_open_categories: usize,
        options: AnchorBuildOptions,
        mut progress: F,
        mut layer_done: G,
    ) -> Result<Self, KeiriError>
    where
        F: FnMut(AnchorBuildProgress),
        G: FnMut(usize, &Self) -> Result<(), KeiriError>,
    {
        table.build_missing_layers_with_callbacks(
            max_open_categories,
            options,
            &mut progress,
            &mut layer_done,
        )?;
        Ok(table)
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn build_missing_layers_with_callbacks<F, G>(
        &mut self,
        max_open_categories: usize,
        options: AnchorBuildOptions,
        progress: &mut F,
        layer_done: &mut G,
    ) -> Result<(), KeiriError>
    where
        F: FnMut(AnchorBuildProgress),
        G: FnMut(usize, &Self) -> Result<(), KeiriError>,
    {
        if max_open_categories > Category::ALL.len() {
            return Err(KeiriError::InvalidAnchorTable(format!(
                "max_open_categories must be 0..={}",
                Category::ALL.len()
            )));
        }

        let distributions = build_distributions();
        let dense_tables = DenseTurnTables::new()?;
        let upper_scores = build_upper_score_cache();

        for open_count in 0..=max_open_categories {
            let work = anchor_layer_work(open_count, &upper_scores);
            let layer_states = work.len();
            if self.layer_is_complete(open_count, &upper_scores) {
                progress(AnchorBuildProgress {
                    open_count,
                    total_open_count: max_open_categories,
                    layer_states,
                    completed_layer_states: layer_states,
                });
                continue;
            }
            progress(AnchorBuildProgress {
                open_count,
                total_open_count: max_open_categories,
                layer_states,
                completed_layer_states: 0,
            });

            if open_count == 0 {
                for (key, _) in work {
                    self.values[key.index()] = 0.0;
                }
                progress(AnchorBuildProgress {
                    open_count,
                    total_open_count: max_open_categories,
                    layer_states,
                    completed_layer_states: layer_states,
                });
                layer_done(open_count, self)?;
                continue;
            }

            let previous = self.clone();
            let results = match options.strategy {
                AnchorBuildStrategy::Dense => build_anchor_layer_dense(
                    &previous,
                    &work,
                    &dense_tables,
                    options.thread_count(),
                    |completed| {
                        progress(AnchorBuildProgress {
                            open_count,
                            total_open_count: max_open_categories,
                            layer_states,
                            completed_layer_states: completed,
                        });
                    },
                )?,
                AnchorBuildStrategy::Recursive => build_anchor_layer_recursive(
                    &previous,
                    &work,
                    &distributions,
                    options.thread_count(),
                    |completed| {
                        progress(AnchorBuildProgress {
                            open_count,
                            total_open_count: max_open_categories,
                            layer_states,
                            completed_layer_states: completed,
                        });
                    },
                )?,
            };

            for (index, value) in results {
                self.values[index] = value;
            }
            layer_done(open_count, self)?;
        }

        Ok(())
    }

    pub fn ruleset(&self) -> Ruleset {
        self.ruleset
    }

    pub fn completed_open_layers(&self) -> Vec<usize> {
        let upper_scores = build_upper_score_cache();
        (0..=Category::ALL.len())
            .filter(|open_count| self.layer_is_complete(*open_count, &upper_scores))
            .collect()
    }

    fn layer_is_complete(&self, open_count: usize, upper_scores: &[Vec<Option<[u16; 6]>>]) -> bool {
        let work = anchor_layer_work(open_count, upper_scores);
        !work.is_empty()
            && work
                .iter()
                .all(|(key, _)| self.values[key.index()].is_finite())
    }

    pub fn value_for_key(&self, key: AnchorKey) -> Option<f64> {
        self.values
            .get(key.index())
            .copied()
            .filter(|value| !value.is_nan())
    }

    pub fn value_for_sheet(&self, sheet: &ScoreSheet) -> Option<f64> {
        self.value_for_key(AnchorKey::from_sheet(sheet))
    }

    pub fn set_value_for_sheet(&mut self, sheet: &ScoreSheet, value: f64) {
        let key = AnchorKey::from_sheet(sheet);
        self.values[key.index()] = value;
    }

    pub fn expected_value(&self, state: &GameState) -> Result<f64, KeiriError> {
        if state.dice().is_none() {
            return self.value_for_sheet(state.sheet()).ok_or_else(|| {
                KeiriError::MissingAnchorValue(format!(
                    "missing exact table anchor for {}",
                    state.to_compact()
                ))
            });
        }
        let distributions = build_distributions();
        let mut solver = TurnSolver::new(self, &distributions);
        solver.state_value(state)
    }

    pub fn best_action(&self, state: &GameState) -> Result<Option<Decision>, KeiriError> {
        if state.is_terminal() {
            return Ok(None);
        }
        if state.dice().is_none() {
            return Ok(Some(Decision {
                action: Action::Roll { hold_mask: 0 },
                expected_value: self.expected_value(state)?,
                source: DecisionSource::ExactTable,
            }));
        }
        let distributions = build_distributions();
        let mut solver = TurnSolver::new(self, &distributions);
        solver.best_decision(state).map(Some)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn save<P: AsRef<Path>>(&self, path: P) -> Result<(), KeiriError> {
        let path = path.as_ref();
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent).map_err(|error| {
                KeiriError::ParseError(format!("failed to create {}: {error}", parent.display()))
            })?;
        }
        fs::write(path, self.to_bytes()).map_err(|error| {
            KeiriError::ParseError(format!("failed to write {}: {error}", path.display()))
        })
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn load<P: AsRef<Path>>(path: P) -> Result<Self, KeiriError> {
        let path = path.as_ref();
        let bytes = fs::read(path).map_err(|error| {
            KeiriError::ParseError(format!("failed to read {}: {error}", path.display()))
        })?;
        Self::from_bytes(&bytes)
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut header = Vec::new();
        header.extend_from_slice(ANCHOR_TABLE_MAGIC);
        header.extend_from_slice(&ANCHOR_TABLE_VERSION.to_le_bytes());
        header.push(ruleset_byte(self.ruleset));
        header.extend(Category::ALL.iter().map(|category| category.index() as u8));
        header.extend_from_slice(&(self.values.len() as u64).to_le_bytes());

        let mut value_bytes = Vec::with_capacity(self.values.len() * 8);
        for value in &self.values {
            value_bytes.extend_from_slice(&value.to_le_bytes());
        }

        let checksum = checksum64(header.iter().chain(value_bytes.iter()).copied());
        let mut bytes = header;
        bytes.extend_from_slice(&checksum.to_le_bytes());
        bytes.extend_from_slice(&value_bytes);
        bytes
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, KeiriError> {
        let header_len = ANCHOR_TABLE_MAGIC.len() + 4 + 1 + Category::ALL.len() + 8;
        let checksum_len = 8;
        if bytes.len() < header_len + checksum_len {
            return Err(KeiriError::InvalidAnchorTable(
                "anchor table is too short".to_string(),
            ));
        }
        if &bytes[..ANCHOR_TABLE_MAGIC.len()] != ANCHOR_TABLE_MAGIC {
            return Err(KeiriError::InvalidAnchorTable(
                "anchor table has an unknown magic header".to_string(),
            ));
        }

        let mut offset = ANCHOR_TABLE_MAGIC.len();
        let version = read_u32(bytes, &mut offset)?;
        if version != ANCHOR_TABLE_VERSION {
            return Err(KeiriError::InvalidAnchorTable(format!(
                "unsupported anchor table version {version}"
            )));
        }

        let ruleset = ruleset_from_byte(bytes[offset]).ok_or_else(|| {
            KeiriError::InvalidAnchorTable(format!("unknown ruleset id {}", bytes[offset]))
        })?;
        offset += 1;

        for category in Category::ALL {
            let actual = bytes[offset];
            let expected = category.index() as u8;
            if actual != expected {
                return Err(KeiriError::InvalidAnchorTable(format!(
                    "category order mismatch at {}; expected {expected}, found {actual}",
                    category.index()
                )));
            }
            offset += 1;
        }

        let value_count = read_u64(bytes, &mut offset)? as usize;
        if value_count != ANCHOR_VALUE_COUNT {
            return Err(KeiriError::InvalidAnchorTable(format!(
                "anchor table value count mismatch; expected {ANCHOR_VALUE_COUNT}, found {value_count}"
            )));
        }

        let stored_checksum = read_u64(bytes, &mut offset)?;
        let expected_len = header_len + checksum_len + value_count * 8;
        if bytes.len() != expected_len {
            return Err(KeiriError::InvalidAnchorTable(format!(
                "anchor table length mismatch; expected {expected_len}, found {}",
                bytes.len()
            )));
        }

        let computed_checksum = checksum64(
            bytes[..header_len]
                .iter()
                .chain(bytes[header_len + checksum_len..].iter())
                .copied(),
        );
        if stored_checksum != computed_checksum {
            return Err(KeiriError::InvalidAnchorTable(
                "anchor table checksum mismatch".to_string(),
            ));
        }

        let mut values = Vec::with_capacity(value_count);
        for chunk in bytes[offset..].chunks_exact(8) {
            values.push(f64::from_le_bytes(
                chunk
                    .try_into()
                    .expect("chunks_exact(8) always yields eight bytes"),
            ));
        }

        Ok(Self { ruleset, values })
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn build_anchor_layer_recursive<F>(
    previous: &AnchorValueTable,
    work: &[(AnchorKey, ScoreSheet)],
    distributions: &[Vec<(Vec<u8>, u32)>],
    workers: usize,
    mut progress: F,
) -> Result<Vec<(usize, f64)>, KeiriError>
where
    F: FnMut(usize),
{
    let chunk_size = work.len().div_ceil(workers).max(1);
    let mut results = Vec::with_capacity(work.len());

    thread::scope(|scope| {
        let mut handles = Vec::new();
        for chunk in work.chunks(chunk_size) {
            handles.push(
                scope.spawn(move || -> Result<Vec<(usize, f64)>, KeiriError> {
                    let mut solver = TurnSolver::new(previous, distributions);
                    chunk
                        .iter()
                        .map(|(key, sheet)| {
                            let value = solver.anchor_value(sheet)?;
                            Ok((key.index(), value))
                        })
                        .collect()
                }),
            );
        }

        for handle in handles {
            let mut chunk_results = handle.join().map_err(|_| {
                KeiriError::InvalidAnchorTable("anchor table worker thread panicked".to_string())
            })??;
            results.append(&mut chunk_results);
            progress(results.len());
        }
        Ok::<(), KeiriError>(())
    })?;

    Ok(results)
}

#[cfg(not(target_arch = "wasm32"))]
fn build_anchor_layer_dense<F>(
    previous: &AnchorValueTable,
    work: &[(AnchorKey, ScoreSheet)],
    tables: &DenseTurnTables,
    workers: usize,
    mut progress: F,
) -> Result<Vec<(usize, f64)>, KeiriError>
where
    F: FnMut(usize),
{
    let batch_size = dense_batch_size(work.len(), workers);
    let next_index = AtomicUsize::new(0);
    let (tx, rx) = mpsc::channel::<Result<Vec<(usize, f64)>, KeiriError>>();
    let mut results = Vec::with_capacity(work.len());

    thread::scope(|scope| {
        for _ in 0..workers {
            let tx = tx.clone();
            let next_index = &next_index;
            scope.spawn(move || {
                let solver = DenseTurnSolver::new(previous, tables);
                loop {
                    let start = next_index.fetch_add(batch_size, Ordering::Relaxed);
                    if start >= work.len() {
                        break;
                    }
                    let end = (start + batch_size).min(work.len());
                    let mut batch = Vec::with_capacity(end - start);
                    for (key, sheet) in &work[start..end] {
                        match solver.anchor_value(sheet) {
                            Ok(value) => batch.push((key.index(), value)),
                            Err(error) => {
                                let _ = tx.send(Err(error));
                                return;
                            }
                        }
                    }
                    if tx.send(Ok(batch)).is_err() {
                        return;
                    }
                }
            });
        }
        drop(tx);

        for message in rx {
            let mut batch = message?;
            results.append(&mut batch);
            progress(results.len());
        }
        Ok::<(), KeiriError>(())
    })?;

    Ok(results)
}

#[cfg(not(target_arch = "wasm32"))]
fn dense_batch_size(work_len: usize, workers: usize) -> usize {
    let target_batches_per_worker = 2;
    work_len
        .div_ceil(workers.max(1) * target_batches_per_worker)
        .clamp(1, 2048)
}

#[cfg(not(target_arch = "wasm32"))]
struct DenseTurnTables {
    dice: Vec<DenseDiceState>,
    holds: Vec<Vec<DenseHoldTransition>>,
}

#[cfg(not(target_arch = "wasm32"))]
struct DenseDiceState {
    dice: Dice,
    first_roll_weight: u32,
    base_scores: [u16; 13],
    joker_scores: [u16; 13],
}

#[cfg(not(target_arch = "wasm32"))]
struct DenseHoldTransition {
    denominator: f64,
    outcomes: Vec<(usize, u32)>,
}

#[cfg(not(target_arch = "wasm32"))]
impl DenseTurnTables {
    fn new() -> Result<Self, KeiriError> {
        let canonical = Dice::all_canonical();
        debug_assert_eq!(canonical.len(), DICE_STATE_COUNT);
        let dice_ids = canonical
            .iter()
            .enumerate()
            .map(|(index, dice)| (*dice, index))
            .collect::<HashMap<_, _>>();
        let first_weights = distribution_for_count(DICE_COUNT)
            .into_iter()
            .map(|(faces, weight)| Ok((Dice::from_slice(&faces)?, weight)))
            .collect::<Result<HashMap<_, _>, KeiriError>>()?;

        let mut dice = Vec::with_capacity(DICE_STATE_COUNT);
        for current in &canonical {
            let mut base_scores = [0u16; 13];
            let mut joker_scores = [0u16; 13];
            for category in Category::ALL {
                let index = category.index();
                let base = Rules::score_with_ruleset(
                    Ruleset::HasbroStrict,
                    category,
                    *current,
                    &ScoreSheet::new(),
                )
                .base_score;
                base_scores[index] = base;
                joker_scores[index] = match category {
                    Category::FullHouse => 25,
                    Category::SmallStraight => 30,
                    Category::LargeStraight => 40,
                    _ => base,
                };
            }
            dice.push(DenseDiceState {
                dice: *current,
                first_roll_weight: *first_weights.get(current).ok_or_else(|| {
                    KeiriError::InvalidAnchorTable(format!(
                        "missing first-roll weight for canonical dice {current}"
                    ))
                })?,
                base_scores,
                joker_scores,
            });
        }

        let distributions = build_distributions();
        let mut holds = Vec::with_capacity(DICE_STATE_COUNT);
        for current in &canonical {
            let mut transitions = Vec::new();
            for hold_mask in canonical_hold_masks(*current) {
                let kept = current.kept_by_mask(hold_mask)?;
                let reroll_count = DICE_COUNT - kept.len();
                let mut outcomes = Vec::with_capacity(distributions[reroll_count].len());
                for (rolled, weight) in &distributions[reroll_count] {
                    let mut faces = kept.clone();
                    faces.extend_from_slice(rolled);
                    let next = Dice::from_slice(&faces)?;
                    let next_id = *dice_ids.get(&next).ok_or_else(|| {
                        KeiriError::InvalidAnchorTable(format!(
                            "missing canonical id for transition dice {next}"
                        ))
                    })?;
                    outcomes.push((next_id, *weight));
                }
                transitions.push(DenseHoldTransition {
                    denominator: f64::from(6u32.pow(reroll_count as u32)),
                    outcomes,
                });
            }
            holds.push(transitions);
        }

        Ok(Self { dice, holds })
    }
}

#[cfg(not(target_arch = "wasm32"))]
struct DenseTurnSolver<'a> {
    table: &'a AnchorValueTable,
    dense: &'a DenseTurnTables,
}

#[cfg(not(target_arch = "wasm32"))]
impl<'a> DenseTurnSolver<'a> {
    fn new(table: &'a AnchorValueTable, dense: &'a DenseTurnTables) -> Self {
        Self { table, dense }
    }

    fn anchor_value(&self, sheet: &ScoreSheet) -> Result<f64, KeiriError> {
        if sheet.is_complete() {
            return Ok(0.0);
        }

        let mut values = [[0.0_f64; DICE_STATE_COUNT]; 4];
        for roll in (1..=3).rev() {
            for dice_id in 0..DICE_STATE_COUNT {
                let score_value = self.best_score_value(sheet, dice_id)?;
                values[roll][dice_id] = if roll == 3 {
                    score_value
                } else {
                    self.best_roll_or_score_value(score_value, &values[roll + 1], dice_id)
                };
            }
        }

        let weighted_sum = self
            .dense
            .dice
            .iter()
            .enumerate()
            .map(|(dice_id, dice)| values[1][dice_id] * f64::from(dice.first_roll_weight))
            .sum::<f64>();
        Ok(weighted_sum / f64::from(6u32.pow(DICE_COUNT as u32)))
    }

    fn best_roll_or_score_value(
        &self,
        score_value: f64,
        next_roll_values: &[f64; DICE_STATE_COUNT],
        dice_id: usize,
    ) -> f64 {
        self.dense.holds[dice_id]
            .iter()
            .map(|hold| {
                hold.outcomes
                    .iter()
                    .map(|(next_id, weight)| next_roll_values[*next_id] * f64::from(*weight))
                    .sum::<f64>()
                    / hold.denominator
            })
            .fold(score_value, f64::max)
    }

    fn best_score_value(&self, sheet: &ScoreSheet, dice_id: usize) -> Result<f64, KeiriError> {
        let legal_mask =
            dense_legal_category_mask(self.table.ruleset, sheet, self.dense.dice[dice_id].dice);
        let mut best = f64::NEG_INFINITY;
        for category in Category::ALL {
            if (legal_mask & category_bit(category)) == 0 {
                continue;
            }
            let result = self.score_result(sheet, dice_id, category);
            let future_key = dense_next_anchor_key(sheet, category, result.base_score);
            let future = self.table.value_for_key(future_key).ok_or_else(|| {
                KeiriError::MissingAnchorValue(format!(
                    "missing exact table anchor after scoring {category}"
                ))
            })?;
            best = best.max(f64::from(result.total_delta) + future);
        }
        Ok(best)
    }

    fn score_result(&self, sheet: &ScoreSheet, dice_id: usize, category: Category) -> ScoreResult {
        let dice = &self.dense.dice[dice_id];
        let joker_active = dense_joker_active_with_ruleset(self.table.ruleset, dice.dice, sheet);
        let base_score = if joker_active {
            dice.joker_scores[category.index()]
        } else {
            dice.base_scores[category.index()]
        };
        let yahtzee_bonus = if dice.dice.is_yahtzee() && sheet.yahtzee_scored_50() {
            YAHTZEE_BONUS
        } else {
            0
        };
        let upper_before = sheet.upper_subtotal();
        let upper_bonus = if category.is_upper()
            && upper_before < UPPER_BONUS_THRESHOLD
            && upper_before + base_score >= UPPER_BONUS_THRESHOLD
        {
            UPPER_BONUS
        } else {
            0
        };
        ScoreResult {
            category,
            base_score,
            yahtzee_bonus,
            upper_bonus,
            total_delta: base_score + yahtzee_bonus + upper_bonus,
        }
    }
}

fn dense_legal_category_mask(ruleset: Ruleset, sheet: &ScoreSheet, dice: Dice) -> u16 {
    let remaining = remaining_category_mask(sheet);
    if ruleset == Ruleset::BuddyBoardGames
        || !Rules::forced_joker_active_with_ruleset(ruleset, dice, sheet)
    {
        return remaining;
    }

    let face = dice
        .yahtzee_face()
        .expect("forced-joker-active dice are yahtzee");
    let matching_upper = Category::upper_for_face(face).expect("die face has upper category");
    if !sheet.is_filled(matching_upper) {
        return category_bit(matching_upper);
    }

    let lower = category_mask(&Category::LOWER) & remaining;
    if lower != 0 {
        return lower;
    }
    category_mask(&Category::UPPER) & remaining
}

fn dense_joker_active_with_ruleset(ruleset: Ruleset, dice: Dice, sheet: &ScoreSheet) -> bool {
    if !dice.is_yahtzee() {
        return false;
    }
    let face = dice
        .yahtzee_face()
        .expect("yahtzee dice always have a face");
    let matching_upper = Category::upper_for_face(face).expect("die face has upper category");
    match ruleset {
        Ruleset::HasbroStrict => sheet.yahtzee_scored_50() && sheet.is_filled(matching_upper),
        Ruleset::BuddyBoardGames => {
            sheet.is_filled(Category::Yahtzee) && sheet.is_filled(matching_upper)
        }
    }
}

fn dense_next_anchor_key(sheet: &ScoreSheet, category: Category, base_score: u16) -> AnchorKey {
    let yahtzee_state = if category == Category::Yahtzee {
        if base_score == 50 {
            AnchorYahtzeeState::Fifty
        } else {
            AnchorYahtzeeState::Zero
        }
    } else {
        AnchorKey::from_sheet(sheet).yahtzee_state
    };
    let upper_subtotal_capped = if category.is_upper() {
        (sheet.upper_subtotal() + base_score).min(UPPER_BONUS_THRESHOLD) as u8
    } else {
        sheet.upper_subtotal_capped()
    };
    AnchorKey {
        filled_mask: sheet.filled_mask() | category_bit(category),
        upper_subtotal_capped,
        yahtzee_state,
    }
}

fn remaining_category_mask(sheet: &ScoreSheet) -> u16 {
    Category::ALL.iter().fold(0u16, |mask, category| {
        if sheet.is_filled(*category) {
            mask
        } else {
            mask | category_bit(*category)
        }
    })
}

fn category_mask(categories: &[Category]) -> u16 {
    categories
        .iter()
        .fold(0u16, |mask, category| mask | category_bit(*category))
}

fn category_bit(category: Category) -> u16 {
    1 << category.index()
}

pub struct TurnSolver<'a> {
    table: &'a AnchorValueTable,
    distributions: &'a [Vec<(Vec<u8>, u32)>],
    cache: HashMap<OracleKey, f64>,
}

impl<'a> TurnSolver<'a> {
    pub fn new(table: &'a AnchorValueTable, distributions: &'a [Vec<(Vec<u8>, u32)>]) -> Self {
        Self {
            table,
            distributions,
            cache: HashMap::new(),
        }
    }

    pub fn anchor_value(&mut self, sheet: &ScoreSheet) -> Result<f64, KeiriError> {
        if sheet.is_complete() {
            return Ok(0.0);
        }
        let distribution = self.distributions[DICE_COUNT].clone();
        let denominator = 6u32.pow(DICE_COUNT as u32);
        let mut weighted_sum = 0.0;
        for (rolled_faces, weight) in distribution {
            let dice = Dice::from_slice(&rolled_faces)?;
            let state = GameState::from_parts(Some(dice), 1, sheet.clone())?;
            weighted_sum += self.state_value(&state)? * f64::from(weight);
        }
        Ok(weighted_sum / f64::from(denominator))
    }

    pub fn state_value(&mut self, state: &GameState) -> Result<f64, KeiriError> {
        if state.is_terminal() {
            return Ok(0.0);
        }
        if state.dice().is_none() {
            return self.table.value_for_sheet(state.sheet()).ok_or_else(|| {
                KeiriError::MissingAnchorValue(format!(
                    "missing exact table anchor for {}",
                    state.to_compact()
                ))
            });
        }
        let key = OracleKey::from_state(state);
        if let Some(value) = self.cache.get(&key) {
            return Ok(*value);
        }
        let value = self.best_decision(state)?.expected_value;
        self.cache.insert(key, value);
        Ok(value)
    }

    pub fn best_decision(&mut self, state: &GameState) -> Result<Decision, KeiriError> {
        self.ranked_decisions(state, 1)?
            .into_iter()
            .next()
            .ok_or(KeiriError::TerminalState)
    }

    pub fn ranked_decisions(
        &mut self,
        state: &GameState,
        limit: usize,
    ) -> Result<Vec<Decision>, KeiriError> {
        if state.is_terminal() {
            return Ok(Vec::new());
        }
        let mut decisions = Vec::new();
        for action in exact_candidate_actions(self.table.ruleset, state) {
            let expected_value = self.action_value(state, action)?;
            decisions.push(Decision {
                action,
                expected_value,
                source: DecisionSource::ExactTable,
            });
        }
        decisions.sort_by(|left, right| {
            if (right.expected_value - left.expected_value).abs() > EXACT_TIE_EPSILON {
                right.expected_value.total_cmp(&left.expected_value)
            } else {
                action_tie_key(state, left.action).cmp(&action_tie_key(state, right.action))
            }
        });
        if decisions.len() > limit {
            decisions.truncate(limit);
        }
        Ok(decisions)
    }

    fn action_value(&mut self, state: &GameState, action: Action) -> Result<f64, KeiriError> {
        match action {
            Action::Score { category } => {
                let dice = state.dice().ok_or(KeiriError::MissingDice)?;
                let result =
                    Rules::score_with_ruleset(self.table.ruleset, category, dice, state.sheet());
                let next = Rules::apply_score_with_ruleset(self.table.ruleset, state, category)?;
                let future = self.table.value_for_sheet(next.sheet()).ok_or_else(|| {
                    KeiriError::MissingAnchorValue(format!(
                        "missing exact table anchor after scoring {category} from {}",
                        state.to_compact()
                    ))
                })?;
                Ok(f64::from(result.total_delta) + future)
            }
            Action::Roll { hold_mask } => self.roll_action_value(state, hold_mask),
        }
    }

    fn roll_action_value(&mut self, state: &GameState, hold_mask: u8) -> Result<f64, KeiriError> {
        let dice = state.dice().ok_or(KeiriError::MissingDice)?;
        let kept = dice.kept_by_mask(hold_mask)?;
        let reroll_count = DICE_COUNT - kept.len();
        let distribution = self.distributions[reroll_count].clone();
        let denominator = 6u32.pow(reroll_count as u32);
        let mut weighted_sum = 0.0;
        for (rolled_faces, weight) in distribution {
            let next = Rules::apply_roll(state, hold_mask, &rolled_faces)?;
            weighted_sum += self.state_value(&next)? * f64::from(weight);
        }
        Ok(weighted_sum / f64::from(denominator))
    }
}

pub struct ExactTableAgent {
    table: AnchorValueTable,
    distributions: Vec<Vec<(Vec<u8>, u32)>>,
}

impl ExactTableAgent {
    pub fn new(table: AnchorValueTable) -> Self {
        Self {
            table,
            distributions: build_distributions(),
        }
    }

    pub fn table(&self) -> &AnchorValueTable {
        &self.table
    }

    pub fn best_decision(&mut self, state: &GameState) -> Result<Option<Decision>, KeiriError> {
        if state.is_terminal() {
            return Ok(None);
        }
        if state.dice().is_none() {
            return Ok(Some(Decision {
                action: Action::Roll { hold_mask: 0 },
                expected_value: self.table.expected_value(state)?,
                source: DecisionSource::ExactTable,
            }));
        }
        let mut solver = TurnSolver::new(&self.table, &self.distributions);
        solver.best_decision(state).map(Some)
    }

    pub fn ranked_decisions(
        &mut self,
        state: &GameState,
        limit: usize,
    ) -> Result<Vec<Decision>, KeiriError> {
        if state.dice().is_none() {
            return self
                .best_decision(state)
                .map(|decision| decision.into_iter().take(limit.max(1)).collect::<Vec<_>>());
        }
        let mut solver = TurnSolver::new(&self.table, &self.distributions);
        solver.ranked_decisions(state, limit)
    }
}

impl Agent for ExactTableAgent {
    fn select_action(&mut self, state: &GameState) -> Option<Action> {
        self.best_decision(state)
            .ok()
            .flatten()
            .map(|decision| decision.action)
    }

    fn explain(&mut self, state: &GameState) -> String {
        match self.best_decision(state) {
            Ok(Some(decision)) => format!(
                "exact-table action is `{}` with expected future value {:.3}",
                decision.action, decision.expected_value
            ),
            Ok(None) => "terminal state; no action available".to_string(),
            Err(error) => format!("exact-table decision failed: {error}"),
        }
    }
}

pub fn simulate_with_agent<A: Agent>(
    seed: u64,
    ruleset: Ruleset,
    agent: &mut A,
    verbose: bool,
) -> Result<SimulationReport, KeiriError> {
    let mut rng = Rng64::new(seed);
    simulate_with_rng(seed, &mut rng, ruleset, agent, verbose)
}

fn exact_candidate_actions(ruleset: Ruleset, state: &GameState) -> Vec<Action> {
    let mut actions = Vec::new();
    let Some(dice) = state.dice() else {
        actions.push(Action::Roll { hold_mask: 0 });
        return actions;
    };

    actions.extend(
        Rules::legal_score_categories_with_ruleset(ruleset, state.sheet(), dice)
            .into_iter()
            .map(|category| Action::Score { category }),
    );

    if state.rolls_used() < 3 {
        actions.extend(
            canonical_hold_masks(dice)
                .into_iter()
                .map(|hold_mask| Action::Roll { hold_mask }),
        );
    }

    actions
}

fn canonical_hold_masks(dice: Dice) -> Vec<u8> {
    let mut kept = Vec::<(Vec<u8>, u8)>::new();
    for mask in 0..(1 << DICE_COUNT) {
        let values = dice
            .kept_by_mask(mask)
            .expect("generated masks are valid five-bit masks");
        match kept.iter_mut().find(|(existing, _)| *existing == values) {
            Some((_, existing_mask)) if mask < *existing_mask => *existing_mask = mask,
            Some(_) => {}
            None => kept.push((values, mask)),
        }
    }
    kept.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    kept.into_iter().map(|(_, mask)| mask).collect()
}

fn action_tie_key(state: &GameState, action: Action) -> (u8, Vec<u8>, u8) {
    match action {
        Action::Score { category } => (0, vec![category.index() as u8], 0),
        Action::Roll { hold_mask } => {
            let kept = state
                .dice()
                .and_then(|dice| dice.kept_by_mask(hold_mask).ok())
                .unwrap_or_default();
            (1, kept, hold_mask)
        }
    }
}

fn build_upper_score_cache() -> Vec<Vec<Option<[u16; 6]>>> {
    let mut cache = vec![vec![None; ANCHOR_UPPER_COUNT]; 1 << Category::UPPER.len()];
    for (upper_mask, subtotals) in cache.iter_mut().enumerate() {
        for (subtotal, entry) in subtotals.iter_mut().enumerate() {
            *entry = find_upper_scores(upper_mask as u8, subtotal as u8);
        }
    }
    cache
}

fn anchor_layer_work(
    open_count: usize,
    upper_scores: &[Vec<Option<[u16; 6]>>],
) -> Vec<(AnchorKey, ScoreSheet)> {
    let filled_count = Category::ALL.len() - open_count;
    let mut work = Vec::new();
    for filled_mask in 0..ANCHOR_MASK_COUNT {
        if filled_mask.count_ones() as usize != filled_count {
            continue;
        }
        for upper_subtotal_capped in 0..ANCHOR_UPPER_COUNT {
            for yahtzee_state_index in 0..ANCHOR_YAHTZEE_STATE_COUNT {
                let key = AnchorKey {
                    filled_mask: filled_mask as u16,
                    upper_subtotal_capped: upper_subtotal_capped as u8,
                    yahtzee_state: AnchorYahtzeeState::from_u8(yahtzee_state_index as u8)
                        .expect("loop emits valid Yahtzee states"),
                };
                if let Some(sheet) = sheet_for_anchor_key(key, upper_scores) {
                    work.push((key, sheet));
                }
            }
        }
    }
    work
}

fn find_upper_scores(upper_mask: u8, subtotal_capped: u8) -> Option<[u16; 6]> {
    fn walk(
        index: usize,
        upper_mask: u8,
        subtotal_capped: u8,
        scores: &mut [u16; 6],
        current: u16,
    ) -> bool {
        if index == Category::UPPER.len() {
            return if subtotal_capped == UPPER_BONUS_THRESHOLD as u8 {
                current >= UPPER_BONUS_THRESHOLD
            } else {
                current == u16::from(subtotal_capped)
            };
        }

        if (upper_mask & (1 << index)) == 0 {
            scores[index] = 0;
            return walk(index + 1, upper_mask, subtotal_capped, scores, current);
        }

        let face = u16::from(Category::UPPER[index].upper_face().expect("upper face"));
        for count in 0..=5 {
            let score = count * face;
            scores[index] = score;
            if walk(
                index + 1,
                upper_mask,
                subtotal_capped,
                scores,
                current + score,
            ) {
                return true;
            }
        }
        false
    }

    let mut scores = [0u16; 6];
    walk(0, upper_mask, subtotal_capped, &mut scores, 0).then_some(scores)
}

fn sheet_for_anchor_key(
    key: AnchorKey,
    upper_scores: &[Vec<Option<[u16; 6]>>],
) -> Option<ScoreSheet> {
    if usize::from(key.upper_subtotal_capped) >= ANCHOR_UPPER_COUNT {
        return None;
    }
    let yahtzee_filled = key.has_category(Category::Yahtzee);
    match (yahtzee_filled, key.yahtzee_state) {
        (false, AnchorYahtzeeState::Open) => {}
        (true, AnchorYahtzeeState::Zero | AnchorYahtzeeState::Fifty) => {}
        _ => return None,
    }

    let upper_mask = Category::UPPER.iter().fold(0u8, |mask, category| {
        if key.has_category(*category) {
            mask | (1 << category.index())
        } else {
            mask
        }
    });
    let scores = upper_scores
        .get(usize::from(upper_mask))?
        .get(usize::from(key.upper_subtotal_capped))?
        .as_ref()?;

    let mut sheet = ScoreSheet::new();
    for category in Category::UPPER {
        if key.has_category(category) {
            sheet.fill_raw(category, scores[category.index()]).ok()?;
        }
    }
    for category in Category::LOWER {
        if !key.has_category(category) {
            continue;
        }
        let score = match category {
            Category::Yahtzee => match key.yahtzee_state {
                AnchorYahtzeeState::Fifty => 50,
                AnchorYahtzeeState::Zero => 0,
                AnchorYahtzeeState::Open => return None,
            },
            _ => 0,
        };
        sheet.fill_raw(category, score).ok()?;
    }
    Some(sheet)
}

fn ruleset_byte(ruleset: Ruleset) -> u8 {
    match ruleset {
        Ruleset::HasbroStrict => 1,
        Ruleset::BuddyBoardGames => 2,
    }
}

fn ruleset_from_byte(value: u8) -> Option<Ruleset> {
    match value {
        1 => Some(Ruleset::HasbroStrict),
        2 => Some(Ruleset::BuddyBoardGames),
        _ => None,
    }
}

fn checksum64<I>(bytes: I) -> u64
where
    I: IntoIterator<Item = u8>,
{
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn read_u32(bytes: &[u8], offset: &mut usize) -> Result<u32, KeiriError> {
    let end = *offset + 4;
    let chunk = bytes.get(*offset..end).ok_or_else(|| {
        KeiriError::InvalidAnchorTable("anchor table ended while reading u32".to_string())
    })?;
    *offset = end;
    Ok(u32::from_le_bytes(
        chunk.try_into().expect("u32 chunk has four bytes"),
    ))
}

fn read_u64(bytes: &[u8], offset: &mut usize) -> Result<u64, KeiriError> {
    let end = *offset + 8;
    let chunk = bytes.get(*offset..end).ok_or_else(|| {
        KeiriError::InvalidAnchorTable("anchor table ended while reading u64".to_string())
    })?;
    *offset = end;
    Ok(u64::from_le_bytes(
        chunk.try_into().expect("u64 chunk has eight bytes"),
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rng64 {
    state: u64,
}

impl Rng64 {
    pub fn new(seed: u64) -> Self {
        Self { state: seed.max(1) }
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }

    pub fn next_die(&mut self) -> u8 {
        (self.next_u64() % 6) as u8 + 1
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SimulationReport {
    pub final_score: u16,
    pub seed: u64,
    pub turn_count: u8,
    pub upper_bonus: bool,
    pub yahtzee_bonus_count: u16,
    pub turn_log: Vec<String>,
}

pub struct GameSimulator {
    seed: u64,
    rng: Rng64,
    ruleset: Ruleset,
    agent: HybridAgent,
}

impl GameSimulator {
    pub fn new(seed: u64, ruleset: Ruleset, oracle_endgame: usize) -> Self {
        Self {
            seed,
            rng: Rng64::new(seed),
            ruleset,
            agent: HybridAgent::new(ruleset, oracle_endgame),
        }
    }

    pub fn simulate(&mut self, verbose: bool) -> Result<SimulationReport, KeiriError> {
        simulate_with_rng(
            self.seed,
            &mut self.rng,
            self.ruleset,
            &mut self.agent,
            verbose,
        )
    }
}

fn simulate_with_rng<A: Agent>(
    seed: u64,
    rng: &mut Rng64,
    ruleset: Ruleset,
    agent: &mut A,
    verbose: bool,
) -> Result<SimulationReport, KeiriError> {
    let mut state = GameState::new();
    let mut turn_count = 0;
    let mut turn_log = Vec::new();

    while !state.is_terminal() {
        turn_count += 1;
        loop {
            let action = agent.select_action(&state);
            match action {
                Some(Action::Roll { hold_mask }) => {
                    let rolled_faces = roll_faces_for_action(rng, &state, hold_mask)?;
                    let previous = state.to_compact();
                    state = Rules::apply_roll(&state, hold_mask, &rolled_faces)?;
                    if verbose {
                        let action = Action::Roll { hold_mask };
                        turn_log.push(format!(
                            "turn {turn_count}: {previous} -> {action}; rolled={}",
                            format_faces(&rolled_faces)
                        ));
                    }
                }
                Some(Action::Score { category }) => {
                    let dice = state.dice.ok_or(KeiriError::MissingDice)?;
                    let result = Rules::score_with_ruleset(ruleset, category, dice, state.sheet());
                    state = Rules::apply_score_with_ruleset(ruleset, &state, category)?;
                    if verbose {
                        turn_log.push(format!(
                            "turn {turn_count}: score {category}; delta={}; total={}",
                            result.total_delta,
                            state.sheet().total_score()
                        ));
                    }
                    break;
                }
                None => return Err(KeiriError::TerminalState),
            }
        }
    }

    Ok(SimulationReport {
        final_score: state.sheet().total_score(),
        seed,
        turn_count,
        upper_bonus: state.sheet().has_upper_bonus(),
        yahtzee_bonus_count: state.sheet().yahtzee_bonus_count(),
        turn_log,
    })
}

fn roll_faces_for_action(
    rng: &mut Rng64,
    state: &GameState,
    hold_mask: u8,
) -> Result<Vec<u8>, KeiriError> {
    validate_hold_mask(hold_mask)?;
    let kept_count = match state.dice {
        Some(dice) => dice.kept_by_mask(hold_mask)?.len(),
        None => 0,
    };
    Ok((0..(DICE_COUNT - kept_count))
        .map(|_| rng.next_die())
        .collect())
}

pub struct HybridAgent {
    ruleset: Ruleset,
    oracle_endgame: usize,
    oracle: OptimalAgent,
    distributions: Vec<Vec<(Vec<u8>, u32)>>,
}

impl HybridAgent {
    pub fn new(ruleset: Ruleset, oracle_endgame: usize) -> Self {
        Self {
            ruleset,
            oracle_endgame: oracle_endgame.min(Category::ALL.len()),
            oracle: OptimalAgent::with_ruleset(ruleset),
            distributions: build_distributions(),
        }
    }

    pub fn select_action(&mut self, state: &GameState) -> Action {
        if state.dice().is_none() {
            return Action::Roll { hold_mask: 0 };
        }

        if state.sheet().remaining_categories().len() <= self.oracle_endgame
            && let Some(decision) = self.oracle.best_action(state)
        {
            return decision.action;
        }

        let mut evaluator = HeuristicTurnEvaluator::new(self.ruleset, &self.distributions);
        evaluator.best_action(state)
    }

    pub fn uses_oracle_for(&self, state: &GameState) -> bool {
        state.dice().is_some()
            && self.oracle_endgame > 0
            && state.sheet().remaining_categories().len() <= self.oracle_endgame
    }
}

impl Agent for HybridAgent {
    fn select_action(&mut self, state: &GameState) -> Option<Action> {
        Some(HybridAgent::select_action(self, state))
    }

    fn explain(&mut self, state: &GameState) -> String {
        if self.uses_oracle_for(state) {
            return self.oracle.explain(state);
        }
        let mut evaluator = HeuristicTurnEvaluator::new(self.ruleset, &self.distributions);
        let action = evaluator.best_action(state);
        format!("heuristic action is `{action}`")
    }
}

struct HeuristicTurnEvaluator<'a> {
    ruleset: Ruleset,
    distributions: &'a [Vec<(Vec<u8>, u32)>],
}

impl<'a> HeuristicTurnEvaluator<'a> {
    fn new(ruleset: Ruleset, distributions: &'a [Vec<(Vec<u8>, u32)>]) -> Self {
        Self {
            ruleset,
            distributions,
        }
    }

    fn best_action(&mut self, state: &GameState) -> Action {
        self.candidate_actions(state)
            .into_iter()
            .max_by(|left, right| {
                self.action_value(state, *left)
                    .total_cmp(&self.action_value(state, *right))
            })
            .expect("non-terminal states have at least one legal action")
    }

    fn action_value(&mut self, state: &GameState, action: Action) -> f64 {
        match action {
            Action::Score { category } => self.score_utility(state, category),
            Action::Roll { hold_mask } => self.hold_utility(state, hold_mask),
        }
    }

    fn hold_utility(&mut self, state: &GameState, hold_mask: u8) -> f64 {
        let Some(dice) = state.dice() else {
            return 0.0;
        };
        let Ok(kept) = dice.kept_by_mask(hold_mask) else {
            return f64::NEG_INFINITY;
        };
        let reroll_count = DICE_COUNT - kept.len();
        let denominator = 6u32.pow(reroll_count as u32);

        self.distributions[reroll_count]
            .iter()
            .map(|(rolled, weight)| {
                let mut faces = kept.clone();
                faces.extend_from_slice(rolled);
                let Ok(next_dice) = Dice::from_slice(&faces) else {
                    return f64::NEG_INFINITY;
                };
                let Ok(next_state) = GameState::from_parts(
                    Some(next_dice),
                    state.rolls_used() + 1,
                    state.sheet().clone(),
                ) else {
                    return f64::NEG_INFINITY;
                };
                let next_values = next_dice.values();
                let base_score = self.best_score_value(&next_state);
                let pattern_score = dice_pattern_bonus(&next_values) * 0.25;
                (base_score + pattern_score) * f64::from(*weight)
            })
            .sum::<f64>()
            / f64::from(denominator)
    }

    fn best_score_value(&mut self, state: &GameState) -> f64 {
        let Some(dice) = state.dice() else {
            return f64::NEG_INFINITY;
        };
        Rules::legal_score_categories_with_ruleset(self.ruleset, state.sheet(), dice)
            .into_iter()
            .map(|category| self.score_utility(state, category))
            .fold(f64::NEG_INFINITY, f64::max)
    }

    fn score_utility(&mut self, state: &GameState, category: Category) -> f64 {
        let Some(dice) = state.dice() else {
            return f64::NEG_INFINITY;
        };
        let result = Rules::score_with_ruleset(self.ruleset, category, dice, state.sheet());
        let mut utility = f64::from(result.total_delta);

        if category.is_upper() {
            let face = f64::from(category.upper_face().expect("upper category has a face"));
            let base = f64::from(result.base_score);
            utility += base / face;
            if state.sheet().upper_subtotal() < UPPER_BONUS_THRESHOLD {
                let target = face * 3.0;
                utility += (base - target) * 1.7;
                utility += (base / target) * 5.0;

                // Dynamic upper bonus utility — ~10% of the 35-point swing
                let upper_filled = state.sheet().filled_count() as f64;
                let upper_remaining = 13.0 - upper_filled; // all remaining = upper or bonus, rough
                let time_ratio = 1.0 - upper_remaining / 12.0; // 0 at start → 1 at end

                let still_possible = {
                    let subtotal = state.sheet().upper_subtotal() + result.base_score;
                    let max_remaining = Category::UPPER
                        .iter()
                        .filter(|u| **u != category && !state.sheet().is_filled(**u))
                        .copied()
                        .map(Rules::max_base_score)
                        .sum::<u16>();
                    subtotal + max_remaining >= UPPER_BONUS_THRESHOLD
                };

                if still_possible {
                    // Per-slot credit: spread bonus value across remaining unfilled upper slots
                    let slots = (Category::UPPER
                        .iter()
                        .filter(|u| **u != category && !state.sheet().is_filled(**u))
                        .count() as f64)
                        .max(1.0);
                    let bonus_per_slot = UPPER_BONUS as f64 * (0.25 + 0.4 * time_ratio) / slots;
                    utility += bonus_per_slot;
                } else {
                    // Penalty for burning the last opening that could reach the bonus
                    utility -= UPPER_BONUS as f64 * (0.1 + 0.25 * time_ratio);
                }
            }
        }

        // Time-pressure weight: early game de-emphasizes maximal categories,
        // late game heavily emphasizes them since every point matters.
        let remaining_f = state.sheet().remaining_categories().len() as f64;
        let time_pressure = 1.0 - remaining_f / 13.0;

        if result.base_score == 0 {
            utility -= match category {
                Category::Yahtzee => 45.0 * (1.0 + time_pressure * 0.3),
                Category::LargeStraight => 18.0 * (1.0 + time_pressure),
                Category::SmallStraight => 10.0 * (1.0 + time_pressure),
                Category::FullHouse => 16.0,
                Category::FourKind => 10.0,
                Category::ThreeKind => 8.0,
                Category::Chance => 35.0,
                _ => 2.0,
            };
        } else {
            let category_cry = match category {
                Category::Yahtzee => 18.0 + 12.0 * time_pressure,
                Category::LargeStraight => 12.0 + 4.0 * time_pressure,
                Category::SmallStraight => 12.0 + 4.0 * time_pressure,
                Category::FullHouse => 8.0 + 2.0 * time_pressure,
                Category::FourKind => (f64::from(result.base_score) - 18.0) * 0.5,
                Category::ThreeKind => (f64::from(result.base_score) - 15.0) * 0.25,
                Category::Chance => (f64::from(result.base_score) - 22.0) * 0.7,
                _ => 0.0,
            };
            utility += category_cry;
        }

        utility
    }

    fn candidate_actions(&self, state: &GameState) -> Vec<Action> {
        let mut actions = Vec::new();
        let Some(dice) = state.dice() else {
            actions.push(Action::Roll { hold_mask: 0 });
            return actions;
        };

        actions.extend(
            Rules::legal_score_categories_with_ruleset(self.ruleset, state.sheet(), dice)
                .into_iter()
                .map(|category| Action::Score { category }),
        );

        if state.rolls_used() < 3 {
            actions.extend(
                candidate_hold_masks(dice)
                    .into_iter()
                    .map(|hold_mask| Action::Roll { hold_mask }),
            );
        }

        actions
    }
}

fn dice_pattern_bonus(dice: &[u8; DICE_COUNT]) -> f64 {
    let mut count = [0u8; 7];
    for &v in dice {
        count[v as usize] += 1;
    }
    let mut bonus = 0.0;
    for &c in &count[1..] {
        match c {
            2 => bonus += 2.0,
            3 => bonus += 6.0,
            4 => bonus += 10.0,
            5 => bonus += 15.0,
            _ => {}
        }
    }

    // Deduplicated sorted values for straight detection
    let mut unique = Vec::new();
    let mut last = 0u8;
    let mut sorted_vals = *dice;
    sorted_vals.sort();
    for v in sorted_vals {
        if v != last {
            unique.push(v);
            last = v;
        }
    }
    // Check for 4-in-a-row sequences (smallest straight)
    let mut consec = 1u8;
    for i in 1..unique.len() {
        if unique[i] == unique[i - 1] + 1 {
            consec += 1;
            if consec == 4 {
                bonus += 6.0;
            }
            if consec == 5 {
                bonus += 12.0;
            }
        } else {
            consec = 1;
        }
    }
    bonus
}

fn candidate_hold_masks(dice: Dice) -> Vec<u8> {
    let values = dice.values();
    let mut masks = vec![0, (1 << DICE_COUNT) - 1];

    for face in 1..=6 {
        push_unique_mask(&mut masks, mask_for_faces(&values, &[face]));
    }

    for run in [1..=4, 2..=5, 3..=6, 1..=5, 2..=6] {
        let faces = run.collect::<Vec<_>>();
        push_unique_mask(&mut masks, mask_for_one_each(&values, &faces));
    }

    push_unique_mask(
        &mut masks,
        values.iter().enumerate().fold(0u8, |mask, (index, value)| {
            if *value >= 5 {
                mask | (1 << index)
            } else {
                mask
            }
        }),
    );

    for index in 0..DICE_COUNT {
        push_unique_mask(&mut masks, 1 << index);
    }

    masks
}

fn push_unique_mask(masks: &mut Vec<u8>, mask: u8) {
    if !masks.contains(&mask) {
        masks.push(mask);
    }
}

fn mask_for_faces(values: &[u8; DICE_COUNT], faces: &[u8]) -> u8 {
    values.iter().enumerate().fold(0u8, |mask, (index, value)| {
        if faces.contains(value) {
            mask | (1 << index)
        } else {
            mask
        }
    })
}

fn mask_for_one_each(values: &[u8; DICE_COUNT], faces: &[u8]) -> u8 {
    let mut used_faces = Vec::new();
    values.iter().enumerate().fold(0u8, |mask, (index, value)| {
        if faces.contains(value) && !used_faces.contains(value) {
            used_faces.push(*value);
            mask | (1 << index)
        } else {
            mask
        }
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuddyBoardGamesRow {
    pub client_row: usize,
    pub value: u16,
    pub selected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuddyBoardGamesSnapshot {
    pub game_state: String,
    pub me_idx: usize,
    pub turn_idx: usize,
    pub is_spectator: bool,
    pub roll_pending: bool,
    pub rolls_used: u8,
    pub dice: Dice,
    pub page_dice: [u8; DICE_COUNT],
    pub selected_dice: [bool; DICE_COUNT],
    pub rows: Vec<BuddyBoardGamesRow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BuddyBoardGamesAdvice {
    pub action: Action,
    pub category: Option<Category>,
    pub client_row: Option<usize>,
    pub hold_mask: Option<u8>,
    pub page_hold_mask: Option<u8>,
    pub toggle_dice: Vec<usize>,
    pub selector: String,
    pub expected_value: Option<f64>,
    pub source: DecisionSource,
    pub state_compact: String,
    pub upper_subtotal: u16,
    pub upper_bonus_needed: u16,
    pub remaining_upper: Vec<Category>,
    pub alternatives: Vec<Decision>,
}

impl BuddyBoardGamesSnapshot {
    pub fn parse_compact(input: &str) -> Result<Self, KeiriError> {
        Self::parse_compact_tokens(input.split_whitespace())
    }

    pub fn parse_compact_tokens<'a, I>(tokens: I) -> Result<Self, KeiriError>
    where
        I: IntoIterator<Item = &'a str>,
    {
        parse_bbg_snapshot_tokens(tokens)
    }

    pub fn validate_turn(&self) -> Result<(), KeiriError> {
        if self.game_state != "STARTED" {
            return Err(KeiriError::InvalidBuddyBoardGamesSnapshot(format!(
                "BuddyBoardGames state must be STARTED; found {}",
                self.game_state
            )));
        }
        if self.is_spectator {
            return Err(KeiriError::InvalidBuddyBoardGamesSnapshot(
                "cannot autoplay as a spectator".to_string(),
            ));
        }
        if self.me_idx != self.turn_idx {
            return Err(KeiriError::InvalidBuddyBoardGamesSnapshot(format!(
                "not this player's turn: me={} turn={}",
                self.me_idx, self.turn_idx
            )));
        }
        if self.roll_pending {
            return Err(KeiriError::InvalidBuddyBoardGamesSnapshot(
                "roll animation or update is pending".to_string(),
            ));
        }
        if self.rows.is_empty() {
            return Err(KeiriError::InvalidBuddyBoardGamesSnapshot(
                "missing score rows".to_string(),
            ));
        }
        Ok(())
    }

    pub fn to_game_state(&self) -> Result<GameState, KeiriError> {
        self.validate_turn()?;
        let mut sheet = ScoreSheet::new();
        for row in &self.rows {
            if row.selected
                && let Some(category) = bbg_client_row_to_category(row.client_row)
            {
                let value = normalize_bbg_recorded_score(category, row.value, &mut sheet)?;
                sheet.fill_validated(category, value)?;
            }
        }
        let dice = (self.rolls_used > 0).then_some(self.dice);
        GameState::from_parts(dice, self.rolls_used, sheet)
    }

    pub fn current_hold_mask(&self) -> u8 {
        self.selected_dice
            .iter()
            .enumerate()
            .fold(
                0u8,
                |mask, (index, selected)| {
                    if *selected { mask | (1 << index) } else { mask }
                },
            )
    }

    fn page_hold_mask_for_canonical(&self, hold_mask: u8) -> Result<u8, KeiriError> {
        validate_hold_mask(hold_mask)?;
        let held = self.dice.kept_by_mask(hold_mask)?;
        let mut needed = [0u8; 7];
        for value in held {
            needed[usize::from(value)] += 1;
        }

        let mut page_mask = 0u8;
        for selected in [true, false] {
            for (index, value) in self.page_dice.iter().enumerate() {
                if self.selected_dice[index] != selected || needed[usize::from(*value)] == 0 {
                    continue;
                }
                page_mask |= 1 << index;
                needed[usize::from(*value)] -= 1;
            }
        }

        if needed.iter().any(|count| *count > 0) {
            return Err(KeiriError::InvalidBuddyBoardGamesSnapshot(
                "canonical hold mask cannot be mapped to page dice".to_string(),
            ));
        }

        Ok(page_mask)
    }
}

fn normalize_bbg_recorded_score(
    category: Category,
    value: u16,
    sheet: &mut ScoreSheet,
) -> Result<u16, KeiriError> {
    if category != Category::Yahtzee || value <= 50 {
        return Ok(value);
    }
    if !(value - 50).is_multiple_of(YAHTZEE_BONUS) {
        return Err(KeiriError::InvalidRecordedScore {
            category,
            score: value,
        });
    }
    sheet.set_yahtzee_bonus_count((value - 50) / YAHTZEE_BONUS);
    Ok(50)
}

impl BuddyBoardGamesAdvice {
    pub fn from_snapshot(
        snapshot: &BuddyBoardGamesSnapshot,
        action: Action,
        expected_value: Option<f64>,
        source: DecisionSource,
        state_compact: String,
        alternatives: Vec<Decision>,
    ) -> Result<Self, KeiriError> {
        let state = snapshot.to_game_state()?;
        let upper_subtotal = state.sheet().upper_subtotal();
        let upper_bonus_needed = UPPER_BONUS_THRESHOLD.saturating_sub(upper_subtotal);
        let remaining_upper = Category::UPPER
            .iter()
            .copied()
            .filter(|category| !state.sheet().is_filled(*category))
            .collect::<Vec<_>>();

        match action {
            Action::Roll { hold_mask } => {
                validate_hold_mask(hold_mask)?;
                let page_hold_mask = snapshot.page_hold_mask_for_canonical(hold_mask)?;
                let current = snapshot.current_hold_mask();
                let toggle_dice = (0..DICE_COUNT)
                    .filter(|index| ((current ^ page_hold_mask) & (1 << index)) != 0)
                    .collect::<Vec<_>>();
                Ok(Self {
                    action,
                    category: None,
                    client_row: None,
                    hold_mask: Some(hold_mask),
                    page_hold_mask: Some(page_hold_mask),
                    toggle_dice,
                    selector: "#roll-dice".to_string(),
                    expected_value,
                    source,
                    state_compact,
                    upper_subtotal,
                    upper_bonus_needed,
                    remaining_upper,
                    alternatives,
                })
            }
            Action::Score { category } => {
                let row = bbg_category_to_client_row(category).ok_or_else(|| {
                    KeiriError::InvalidBuddyBoardGamesSnapshot(format!(
                        "no BuddyBoardGames row mapping for {category}"
                    ))
                })?;
                Ok(Self {
                    action,
                    category: Some(category),
                    client_row: Some(row),
                    hold_mask: None,
                    page_hold_mask: None,
                    toggle_dice: Vec::new(),
                    selector: format!("#player-{}-scoreboard-row-{row}", snapshot.me_idx),
                    expected_value,
                    source,
                    state_compact,
                    upper_subtotal,
                    upper_bonus_needed,
                    remaining_upper,
                    alternatives,
                })
            }
        }
    }

    pub fn to_cli_lines(&self) -> String {
        let mut lines = vec![format!("action: {}", self.action)];
        lines.push(format!("source: {:?}", self.source));
        lines.push(format!("state: {}", self.state_compact));
        if let Some(value) = self.expected_value {
            lines.push(format!("expected_value: {value:.6}"));
        }
        lines.push(format!("upper_subtotal: {}", self.upper_subtotal));
        lines.push(format!("upper_bonus_needed: {}", self.upper_bonus_needed));
        lines.push(format!(
            "remaining_upper: {}",
            if self.remaining_upper.is_empty() {
                "none".to_string()
            } else {
                self.remaining_upper
                    .iter()
                    .map(Category::to_string)
                    .collect::<Vec<_>>()
                    .join(",")
            }
        ));
        if let Some(category) = self.category {
            lines.push(format!("category: {category}"));
        }
        if let Some(row) = self.client_row {
            lines.push(format!("client_row: {row}"));
        }
        if let Some(mask) = self.hold_mask {
            lines.push(format!("hold_mask: {mask:05b}"));
        }
        if let Some(mask) = self.page_hold_mask {
            lines.push(format!("page_hold_mask: {mask:05b}"));
        }
        if !self.toggle_dice.is_empty() {
            lines.push(format!(
                "toggle_dice: {}",
                self.toggle_dice
                    .iter()
                    .map(usize::to_string)
                    .collect::<Vec<_>>()
                    .join(",")
            ));
        }
        if !self.alternatives.is_empty() {
            lines.push(format!(
                "alternatives: {}",
                self.alternatives
                    .iter()
                    .map(|decision| format!("{}={:.6}", decision.action, decision.expected_value))
                    .collect::<Vec<_>>()
                    .join("|")
            ));
        }
        lines.push(format!("selector: {}", self.selector));
        lines.join("\n")
    }
}

pub fn advise_buddyboardgames_snapshot(
    snapshot: &BuddyBoardGamesSnapshot,
    oracle_endgame: usize,
) -> Result<BuddyBoardGamesAdvice, KeiriError> {
    let state = snapshot.to_game_state()?;
    let mut agent = HybridAgent::new(Ruleset::BuddyBoardGames, oracle_endgame);
    let action = agent.select_action(&state);
    let expected_value = if agent.uses_oracle_for(&state) {
        let mut oracle = OptimalAgent::with_ruleset(Ruleset::BuddyBoardGames);
        oracle
            .best_action(&state)
            .map(|decision| decision.expected_value)
    } else {
        None
    };
    BuddyBoardGamesAdvice::from_snapshot(
        snapshot,
        action,
        expected_value,
        DecisionSource::Heuristic,
        state.to_compact(),
        Vec::new(),
    )
}

pub fn advise_buddyboardgames_snapshot_exact(
    snapshot: &BuddyBoardGamesSnapshot,
    table: AnchorValueTable,
    alternatives_limit: usize,
) -> Result<BuddyBoardGamesAdvice, KeiriError> {
    if table.ruleset() != Ruleset::BuddyBoardGames {
        return Err(KeiriError::InvalidAnchorTable(format!(
            "BuddyBoardGames advice requires a buddyboardgames table; found {}",
            table.ruleset()
        )));
    }
    let state = snapshot.to_game_state()?;
    let mut agent = ExactTableAgent::new(table);
    let alternatives = agent.ranked_decisions(&state, alternatives_limit.max(1))?;
    let decision = alternatives
        .first()
        .cloned()
        .ok_or(KeiriError::TerminalState)?;
    BuddyBoardGamesAdvice::from_snapshot(
        snapshot,
        decision.action,
        Some(decision.expected_value),
        DecisionSource::ExactTable,
        state.to_compact(),
        alternatives,
    )
}

pub fn bbg_client_row_to_category(row: usize) -> Option<Category> {
    match row {
        0 => Some(Category::Ones),
        1 => Some(Category::Twos),
        2 => Some(Category::Threes),
        3 => Some(Category::Fours),
        4 => Some(Category::Fives),
        5 => Some(Category::Sixes),
        7 => Some(Category::ThreeKind),
        8 => Some(Category::FourKind),
        9 => Some(Category::FullHouse),
        10 => Some(Category::SmallStraight),
        11 => Some(Category::LargeStraight),
        12 => Some(Category::Yahtzee),
        13 => Some(Category::Chance),
        _ => None,
    }
}

pub fn bbg_category_to_client_row(category: Category) -> Option<usize> {
    match category {
        Category::Ones => Some(0),
        Category::Twos => Some(1),
        Category::Threes => Some(2),
        Category::Fours => Some(3),
        Category::Fives => Some(4),
        Category::Sixes => Some(5),
        Category::ThreeKind => Some(7),
        Category::FourKind => Some(8),
        Category::FullHouse => Some(9),
        Category::SmallStraight => Some(10),
        Category::LargeStraight => Some(11),
        Category::Yahtzee => Some(12),
        Category::Chance => Some(13),
    }
}

fn build_distributions() -> Vec<Vec<(Vec<u8>, u32)>> {
    (0..=DICE_COUNT).map(distribution_for_count).collect()
}

fn distribution_for_count(dice_count: usize) -> Vec<(Vec<u8>, u32)> {
    fn walk(
        face: u8,
        remaining: usize,
        counts: &mut [u8; 7],
        output: &mut Vec<(Vec<u8>, u32)>,
        total: usize,
    ) {
        if face == 7 {
            if remaining == 0 {
                let mut values = Vec::with_capacity(total);
                for (value, count) in counts.iter().enumerate().take(7).skip(1) {
                    values.extend(std::iter::repeat_n(value as u8, usize::from(*count)));
                }
                output.push((values, multinomial_weight(total, counts)));
            }
            return;
        }

        for count in 0..=remaining {
            counts[usize::from(face)] = count as u8;
            walk(face + 1, remaining - count, counts, output, total);
        }
        counts[usize::from(face)] = 0;
    }

    let mut output = Vec::new();
    let mut counts = [0; 7];
    walk(1, dice_count, &mut counts, &mut output, dice_count);
    output
}

fn multinomial_weight(total: usize, counts: &[u8; 7]) -> u32 {
    let denominator = counts[1..=6]
        .iter()
        .map(|count| factorial(usize::from(*count)))
        .product::<u32>();
    factorial(total) / denominator
}

fn factorial(value: usize) -> u32 {
    (1..=value as u32).product::<u32>().max(1)
}

fn validate_hold_mask(mask: u8) -> Result<(), KeiriError> {
    if mask >= (1 << DICE_COUNT) {
        Err(KeiriError::InvalidHoldMask(mask))
    } else {
        Ok(())
    }
}

fn parse_compact_state_tokens<'a, I>(tokens: I) -> Result<GameState, KeiriError>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut dice = None;
    let mut rolls = None;
    let mut sheet = ScoreSheet::new();

    for token in tokens {
        let (key, value) = token.split_once('=').ok_or_else(|| {
            KeiriError::ParseError(format!("state token `{token}` must be key=value"))
        })?;
        match key {
            "dice" => {
                dice = if matches!(value, "-" | "none" | "None") {
                    None
                } else {
                    Some(Dice::parse(value)?)
                };
            }
            "rolls" => {
                rolls = Some(value.parse::<u8>().map_err(|_| {
                    KeiriError::ParseError(format!("invalid rolls value `{value}`"))
                })?);
            }
            "scores" => parse_compact_scores(value, &mut sheet)?,
            "yahtzee_bonus" => {
                let count = value.parse::<u16>().map_err(|_| {
                    KeiriError::ParseError(format!("invalid yahtzee_bonus value `{value}`"))
                })?;
                sheet.set_yahtzee_bonus_count(count);
            }
            other => {
                return Err(KeiriError::ParseError(format!(
                    "unknown state key `{other}`"
                )));
            }
        }
    }

    let rolls = rolls.unwrap_or(if dice.is_some() { 1 } else { 0 });
    GameState::from_parts(dice, rolls, sheet)
}

fn parse_compact_scores(value: &str, sheet: &mut ScoreSheet) -> Result<(), KeiriError> {
    if value.trim().is_empty() {
        return Ok(());
    }
    for entry in value.split(',') {
        let (category, score) = entry.split_once(':').ok_or_else(|| {
            KeiriError::ParseError(format!("score entry `{entry}` must be category:score"))
        })?;
        let category = Category::from_name(category)
            .ok_or_else(|| KeiriError::ParseError(format!("unknown category `{category}`")))?;
        let score = score
            .parse::<u16>()
            .map_err(|_| KeiriError::ParseError(format!("invalid score `{score}`")))?;
        sheet.fill_validated(category, score)?;
    }
    Ok(())
}

fn parse_bbg_snapshot_tokens<'a, I>(tokens: I) -> Result<BuddyBoardGamesSnapshot, KeiriError>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut game_state = None;
    let mut me_idx = None;
    let mut turn_idx = None;
    let mut is_spectator = false;
    let mut roll_pending = false;
    let mut rolls_used = None;
    let mut dice = None;
    let mut page_dice = None;
    let mut selected_dice = None;
    let mut rows = None;

    for token in tokens {
        let (key, value) = token.split_once('=').ok_or_else(|| {
            KeiriError::ParseError(format!("BuddyBoardGames token `{token}` must be key=value"))
        })?;
        match key {
            "state" | "game_state" => game_state = Some(value.to_string()),
            "me" | "me_idx" => me_idx = Some(parse_usize_field("me", value)?),
            "turn" | "turn_idx" => turn_idx = Some(parse_usize_field("turn", value)?),
            "spectator" => is_spectator = parse_bool_field("spectator", value)?,
            "pending" | "roll_pending" => roll_pending = parse_bool_field("pending", value)?,
            "rolls" => {
                rolls_used = Some(value.parse::<u8>().map_err(|_| {
                    KeiriError::ParseError(format!("invalid rolls value `{value}`"))
                })?)
            }
            "dice" => {
                let ordered = parse_ordered_dice(value)?;
                page_dice = Some(ordered);
                dice = Some(Dice::new(ordered)?);
            }
            "selected" | "held" => selected_dice = Some(parse_selected_dice(value)?),
            "rows" => rows = Some(parse_bbg_rows(value)?),
            other => {
                return Err(KeiriError::ParseError(format!(
                    "unknown BuddyBoardGames key `{other}`"
                )));
            }
        }
    }

    let snapshot = BuddyBoardGamesSnapshot {
        game_state: game_state.unwrap_or_else(|| "STARTED".to_string()),
        me_idx: me_idx.ok_or_else(|| {
            KeiriError::InvalidBuddyBoardGamesSnapshot("missing me index".to_string())
        })?,
        turn_idx: turn_idx.ok_or_else(|| {
            KeiriError::InvalidBuddyBoardGamesSnapshot("missing turn index".to_string())
        })?,
        is_spectator,
        roll_pending,
        rolls_used: rolls_used.unwrap_or(0),
        dice: dice.ok_or_else(|| {
            KeiriError::InvalidBuddyBoardGamesSnapshot("missing dice".to_string())
        })?,
        page_dice: page_dice.ok_or_else(|| {
            KeiriError::InvalidBuddyBoardGamesSnapshot("missing dice".to_string())
        })?,
        selected_dice: selected_dice.unwrap_or([false; DICE_COUNT]),
        rows: rows.ok_or_else(|| {
            KeiriError::InvalidBuddyBoardGamesSnapshot("missing rows".to_string())
        })?,
    };
    snapshot.validate_turn()?;
    Ok(snapshot)
}

fn parse_ordered_dice(value: &str) -> Result<[u8; DICE_COUNT], KeiriError> {
    let values = value
        .split(',')
        .map(|part| {
            let value = part.trim().parse::<u8>().map_err(|_| {
                KeiriError::ParseError(format!("invalid die value `{}`", part.trim()))
            })?;
            if !(1..=6).contains(&value) {
                return Err(KeiriError::InvalidDie(value));
            }
            Ok(value)
        })
        .collect::<Result<Vec<_>, _>>()?;
    values
        .try_into()
        .map_err(|values: Vec<u8>| KeiriError::InvalidDiceCount(values.len()))
}

fn parse_usize_field(name: &str, value: &str) -> Result<usize, KeiriError> {
    value
        .parse::<usize>()
        .map_err(|_| KeiriError::ParseError(format!("invalid {name} value `{value}`")))
}

fn parse_bool_field(name: &str, value: &str) -> Result<bool, KeiriError> {
    match value {
        "true" | "1" | "yes" => Ok(true),
        "false" | "0" | "no" => Ok(false),
        _ => Err(KeiriError::ParseError(format!(
            "invalid {name} boolean `{value}`"
        ))),
    }
}

fn parse_selected_dice(value: &str) -> Result<[bool; DICE_COUNT], KeiriError> {
    let values = value
        .split(',')
        .map(|part| parse_bool_field("selected die", part))
        .collect::<Result<Vec<_>, _>>()?;
    values
        .try_into()
        .map_err(|values: Vec<bool>| KeiriError::InvalidDiceCount(values.len()))
}

fn parse_bbg_rows(value: &str) -> Result<Vec<BuddyBoardGamesRow>, KeiriError> {
    if value.trim().is_empty() {
        return Ok(Vec::new());
    }

    value
        .split(',')
        .map(|entry| {
            let fields = entry.split(':').collect::<Vec<_>>();
            if fields.len() != 3 {
                return Err(KeiriError::ParseError(format!(
                    "BuddyBoardGames row `{entry}` must be row:value:selected"
                )));
            }
            let client_row = fields[0].parse::<usize>().map_err(|_| {
                KeiriError::ParseError(format!("invalid BuddyBoardGames row `{}`", fields[0]))
            })?;
            let value = fields[1].parse::<u16>().map_err(|_| {
                KeiriError::ParseError(format!("invalid BuddyBoardGames row value `{}`", fields[1]))
            })?;
            let selected = parse_bool_field("row selected", fields[2])?;
            Ok(BuddyBoardGamesRow {
                client_row,
                value,
                selected,
            })
        })
        .collect()
}

fn format_faces(faces: &[u8]) -> String {
    faces
        .iter()
        .map(u8::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

fn normalize_name(name: &str) -> String {
    name.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dice(values: [u8; 5]) -> Dice {
        Dice::new(values).unwrap()
    }

    #[test]
    fn scoring_examples_cover_all_categories() {
        let sheet = ScoreSheet::new();
        assert_eq!(
            Rules::score(Category::Ones, dice([1, 1, 3, 4, 6]), &sheet).base_score,
            2
        );
        assert_eq!(
            Rules::score(Category::Twos, dice([2, 2, 2, 4, 6]), &sheet).base_score,
            6
        );
        assert_eq!(
            Rules::score(Category::Threes, dice([3, 3, 3, 4, 6]), &sheet).base_score,
            9
        );
        assert_eq!(
            Rules::score(Category::Fours, dice([4, 4, 4, 4, 6]), &sheet).base_score,
            16
        );
        assert_eq!(
            Rules::score(Category::Fives, dice([5, 5, 1, 2, 3]), &sheet).base_score,
            10
        );
        assert_eq!(
            Rules::score(Category::Sixes, dice([6, 6, 6, 1, 2]), &sheet).base_score,
            18
        );
        assert_eq!(
            Rules::score(Category::ThreeKind, dice([2, 2, 2, 4, 6]), &sheet).base_score,
            16
        );
        assert_eq!(
            Rules::score(Category::FourKind, dice([4, 4, 4, 4, 6]), &sheet).base_score,
            22
        );
        assert_eq!(
            Rules::score(Category::FullHouse, dice([2, 2, 3, 3, 3]), &sheet).base_score,
            25
        );
        assert_eq!(
            Rules::score(Category::SmallStraight, dice([1, 2, 3, 4, 6]), &sheet).base_score,
            30
        );
        assert_eq!(
            Rules::score(Category::LargeStraight, dice([2, 3, 4, 5, 6]), &sheet).base_score,
            40
        );
        assert_eq!(
            Rules::score(Category::Yahtzee, dice([6, 6, 6, 6, 6]), &sheet).base_score,
            50
        );
        assert_eq!(
            Rules::score(Category::Chance, dice([1, 2, 3, 4, 6]), &sheet).base_score,
            16
        );
    }
}
