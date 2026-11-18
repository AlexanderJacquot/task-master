//! From recognized words and speaker turns to transcript segments (pure, unit tested).
//!
//! The microphone track is "me". On the computer's sound, each word goes to the voice
//! whose turn overlaps it most (or the nearest one), and voices are numbered `s1`, `s2`, …
//! in the order they first speak. Words are grouped into segments per speaker, cut at
//! pauses and in long monologues at a sentence end. Without headphones the others' voices
//! leak into the microphone: a microphone segment whose words mostly match words said on
//! the computer's sound at the same time is that echo, and is dropped.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// A recognized word, times from the start of the recording.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Word {
    pub start_ms: i64,
    pub end_ms: i64,
    /// As recognized, with its leading space when it starts a word.
    pub text: String,
}

/// A stretch of one voice on the computer's sound, from diarization.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Turn {
    pub start_ms: i64,
    pub end_ms: i64,
    pub speaker: i32,
}

/// A finished segment.
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub speaker: String,
    pub text: String,
}

/// A pause this long starts a new segment.
const PAUSE_MS: i64 = 1_200;
/// Past this, a segment ends at the next sentence end.
const SOFT_MAX_MS: i64 = 25_000;
/// And at the latest here.
const HARD_MAX_MS: i64 = 45_000;
/// A word with no turn this close keeps the previous word's speaker.
const NEAREST_TURN_MS: i64 = 1_000;
/// Words this close in time and equal count as the same word (echo).
const ECHO_WINDOW_MS: i64 = 700;
/// A microphone segment with at least this share of echoed words is dropped.
const ECHO_SHARE: f32 = 0.6;

/// Lowercase letters and digits only, for comparing words.
fn normalized(word: &str) -> String {
    word.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn overlap(a: (i64, i64), b: (i64, i64)) -> i64 {
    (a.1.min(b.1) - a.0.max(b.0)).max(0)
}

/// The diarization speaker of each word (`None` when no turn is near).
fn speakers_of(words: &[Word], turns: &[Turn]) -> Vec<Option<i32>> {
    words
        .iter()
        .map(|w| {
            let span = (w.start_ms, w.end_ms.max(w.start_ms + 1));
            let best = turns
                .iter()
                .map(|t| (overlap(span, (t.start_ms, t.end_ms)), t))
                .filter(|(o, _)| *o > 0)
                .max_by_key(|(o, _)| *o)
                .map(|(_, t)| t.speaker);
            best.or_else(|| {
                let mid = (w.start_ms + w.end_ms) / 2;
                turns
                    .iter()
                    .map(|t| {
                        let d = if mid < t.start_ms {
                            t.start_ms - mid
                        } else {
                            (mid - t.end_ms).max(0)
                        };
                        (d, t.speaker)
                    })
                    .filter(|(d, _)| *d <= NEAREST_TURN_MS)
                    .min_by_key(|(d, _)| *d)
                    .map(|(_, s)| s)
            })
        })
        .collect()
}

fn sentence_end(text: &str) -> bool {
    text.trim_end().ends_with(['.', '?', '!', '…'])
}

/// A change of voice this many words or fewer from a sentence end moves to it.
const SNAP_WORDS: usize = 2;

/// Moves each change of voice that falls inside a sentence to the nearest sentence end at
/// most [`SNAP_WORDS`] words away. Whisper's times are least sure around pauses, so the
/// first or last word of a turn often lands on the wrong side ("…planned. That | is great
/// news"), while people rarely hand over mid-sentence. A moved word takes the time of the
/// word it now follows or precedes.
fn snap_to_sentences(words: &mut [(Word, String)]) {
    let mut i = 1;
    while i < words.len() {
        if words[i].1 == words[i - 1].1 || sentence_end(&words[i - 1].0.text) {
            i += 1;
            continue;
        }
        let (before, after) = (words[i - 1].1.clone(), words[i].1.clone());
        // Boundaries `j` (between words j-1 and j) after a sentence end, nearest first,
        // whose moved words all belong to one side of this change.
        let target = (1..=SNAP_WORDS)
            .flat_map(|d| [i.checked_sub(d), Some(i + d)])
            .flatten()
            .filter(|&j| j >= 1 && j < words.len() && sentence_end(&words[j - 1].0.text))
            .find(|&j| {
                if j < i {
                    words[j..i].iter().all(|w| w.1 == before)
                } else {
                    words[i..j].iter().all(|w| w.1 == after)
                }
            });
        // The moved words' times were the unsure part: they join their new neighbours.
        match target {
            Some(j) if j < i => {
                let at = words[i].0.start_ms;
                for w in &mut words[j..i] {
                    w.1 = after.clone();
                    (w.0.start_ms, w.0.end_ms) = (at, at);
                }
            }
            Some(j) => {
                let at = words[i - 1].0.end_ms;
                for w in &mut words[i..j] {
                    w.1 = before.clone();
                    (w.0.start_ms, w.0.end_ms) = (at, at);
                }
                i = j;
            }
            None => {}
        }
        i += 1;
    }
}

/// Groups words of one speaker sequence into segments.
fn group(words: &[(Word, String)]) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::new();
    for (word, speaker) in words {
        let start_new = match out.last() {
            None => true,
            Some(last) => {
                let long = word.end_ms - last.start_ms;
                last.speaker != *speaker
                    || word.start_ms - last.end_ms > PAUSE_MS
                    || long > HARD_MAX_MS
                    || (long > SOFT_MAX_MS && sentence_end(&last.text))
            }
        };
        if start_new {
            out.push(Segment {
                start_ms: word.start_ms,
                end_ms: word.end_ms,
                speaker: speaker.clone(),
                text: word.text.trim_start().to_owned(),
            });
        } else if let Some(last) = out.last_mut() {
            last.end_ms = last.end_ms.max(word.end_ms);
            // Whisper words carry their leading space; punctuation does not.
            last.text.push_str(&word.text);
        }
    }
    for s in &mut out {
        s.text = s.text.trim().to_owned();
    }
    out.retain(|s| !s.text.is_empty());
    out
}

/// Whether most words of a microphone segment were said on the computer's sound at the
/// same time.
fn is_echo(segment: &Segment, mic_words: &[Word], system_words: &[Word]) -> bool {
    let words: Vec<&Word> = mic_words
        .iter()
        .filter(|w| w.start_ms >= segment.start_ms && w.end_ms <= segment.end_ms)
        .filter(|w| !normalized(&w.text).is_empty())
        .collect();
    if words.is_empty() {
        return false;
    }
    let echoed = words
        .iter()
        .filter(|w| {
            let n = normalized(&w.text);
            system_words.iter().any(|s| {
                (s.start_ms - w.start_ms).abs() <= ECHO_WINDOW_MS && normalized(&s.text) == n
            })
        })
        .count();
    echoed as f32 / words.len() as f32 >= ECHO_SHARE
}

/// The transcript of a recording: the microphone's words (me), the computer sound's words
/// and its speaker turns. `system_words` is empty when only the microphone was recorded.
pub fn merge(mic_words: &[Word], system_words: &[Word], turns: &[Turn]) -> Vec<Segment> {
    let mic: Vec<(Word, String)> = mic_words
        .iter()
        .map(|w| (w.clone(), "me".to_owned()))
        .collect();
    let mut mine = group(&mic);
    if !system_words.is_empty() {
        mine.retain(|s| !is_echo(s, mic_words, system_words));
    }

    // Diarization ids in order of first appearance become s1, s2, …
    let mut keys: HashMap<i32, String> = HashMap::new();
    let assigned = speakers_of(system_words, turns);
    let mut previous: Option<String> = None;
    let mut theirs: Vec<(Word, String)> = Vec::with_capacity(system_words.len());
    for (word, speaker) in system_words.iter().zip(assigned) {
        let key = match speaker {
            Some(id) => {
                let next = keys.len() + 1;
                keys.entry(id).or_insert_with(|| format!("s{next}")).clone()
            }
            None => previous.clone().unwrap_or_else(|| {
                let next = keys.len() + 1;
                keys.entry(-1).or_insert_with(|| format!("s{next}")).clone()
            }),
        };
        previous = Some(key.clone());
        theirs.push((word.clone(), key));
    }
    snap_to_sentences(&mut theirs);
    let mut all = mine;
    all.extend(group(&theirs));
    all.sort_by(|a, b| a.start_ms.cmp(&b.start_ms).then(a.speaker.cmp(&b.speaker)));
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Words from "text" spoken from `start` at 300 ms a word.
    fn words(start: i64, text: &str) -> Vec<Word> {
        text.split(' ')
            .enumerate()
            .map(|(i, w)| Word {
                start_ms: start + i as i64 * 300,
                end_ms: start + i as i64 * 300 + 250,
                text: format!(" {w}"),
            })
            .collect()
    }

    fn turn(start_ms: i64, end_ms: i64, speaker: i32) -> Turn {
        Turn {
            start_ms,
            end_ms,
            speaker,
        }
    }

    fn lines(segments: &[Segment]) -> Vec<(String, String)> {
        segments
            .iter()
            .map(|s| (s.speaker.clone(), s.text.clone()))
            .collect()
    }

    #[test]
    fn a_call_becomes_turns_of_me_and_numbered_voices() {
        let mic = words(0, "Hello everyone, shall we start?");
        let mut system = words(3_000, "Yes, I have the numbers.");
        system.extend(words(6_000, "And I have questions."));
        // Diarization ids are arbitrary: 7 speaks first, then 2.
        let turns = vec![turn(2_900, 4_600, 7), turn(5_900, 7_300, 2)];
        let out = merge(&mic, &system, &turns);
        assert_eq!(
            lines(&out),
            vec![
                ("me".into(), "Hello everyone, shall we start?".into()),
                ("s1".into(), "Yes, I have the numbers.".into()),
                ("s2".into(), "And I have questions.".into()),
            ]
        );
        assert_eq!(out[0].start_ms, 0);
        assert_eq!(out[2].end_ms, 6_000 + 3 * 300 + 250);
    }

    #[test]
    fn a_word_between_turns_goes_to_the_nearest_or_stays_with_the_speaker() {
        let system = words(0, "one two three four five six");
        // "three" (600–850) is in no turn, nearer the second; "five" and "six" are past the
        // end of the second turn but within reach of it.
        let turns = vec![turn(0, 550, 1), turn(860, 1_300, 2)];
        let out = merge(&[], &system, &turns);
        assert_eq!(
            lines(&out),
            vec![
                ("s1".into(), "one two".into()),
                ("s2".into(), "three four five six".into()),
            ]
        );
        // No turns at all (diarization found nobody): one voice.
        let out = merge(&[], &system, &[]);
        assert_eq!(
            lines(&out),
            vec![("s1".into(), "one two three four five six".into())]
        );
    }

    #[test]
    fn pauses_and_long_monologues_cut_segments() {
        let mut mic = words(0, "First thought.");
        mic.extend(words(5_000, "Second thought after a pause."));
        let out = merge(&mic, &[], &[]);
        assert_eq!(out.len(), 2);

        // 40 s of talk with a sentence end at 30 s: cut there, not before 25 s.
        let mut long = Vec::new();
        for i in 0..134 {
            let end = if i == 100 { "done." } else { "word" };
            long.push(Word {
                start_ms: i * 300,
                end_ms: i * 300 + 250,
                text: format!(" {end}"),
            });
        }
        let out = merge(&long, &[], &[]);
        assert_eq!(out.len(), 2);
        assert!(out[0].text.ends_with("done."));
        assert_eq!(out[1].start_ms, 101 * 300);
        // With no sentence end at all, the hard limit cuts.
        let flat: Vec<Word> = (0..200)
            .map(|i| Word {
                start_ms: i * 300,
                end_ms: i * 300 + 250,
                text: " word".into(),
            })
            .collect();
        let out = merge(&flat, &[], &[]);
        assert!(out.len() >= 2);
        assert!(out.iter().all(|s| s.end_ms - s.start_ms <= HARD_MAX_MS));
    }

    #[test]
    fn echo_of_the_speakers_in_the_microphone_is_dropped() {
        // The remote voice says a sentence; the microphone hears it 80 ms later, and also
        // has the user's own reply.
        let system = words(1_000, "Can you hear me now?");
        let mut mic: Vec<Word> = words(1_080, "Can you hear me now?");
        mic.extend(words(4_000, "Yes, loud and clear."));
        let out = merge(&mic, &system, &[turn(900, 2_600, 0)]);
        assert_eq!(
            lines(&out),
            vec![
                ("s1".into(), "Can you hear me now?".into()),
                ("me".into(), "Yes, loud and clear.".into()),
            ]
        );
        // Microphone only: nothing to compare against, nothing dropped.
        let out = merge(&mic, &[], &[]);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn punctuation_tokens_join_without_spaces() {
        let w = |s: i64, t: &str| Word {
            start_ms: s,
            end_ms: s + 100,
            text: t.into(),
        };
        let out = merge(
            &[w(0, " Hello"), w(100, ","), w(200, " world"), w(300, ".")],
            &[],
            &[],
        );
        assert_eq!(out[0].text, "Hello, world.");
    }

    #[test]
    fn a_change_of_voice_moves_to_the_nearest_sentence_end() {
        // "That" was timed with the first voice, "Of" with the second.
        let mut all = words(
            0,
            "The budget is ready. That is great news. Can you send it? Of course.",
        );
        let turns = [
            turn(0, 1_400, 0),
            turn(1_400, 3_350, 1),
            turn(3_350, 4_400, 0),
        ];
        // Words: The0 budget1 is2 ready.3 That4 is5 great6 news.7 Can8 you9 send10 it?11
        // Of12 course.13; "That" ends inside the first turn, "Of" inside the second.
        all[4].end_ms = 1_380;
        all[12].start_ms = 3_300;
        all[12].end_ms = 3_340;
        let merged = merge(&[], &all, &turns);
        // The moved words start with their new neighbours ("is", "course.").
        assert_eq!(
            merged.iter().map(|s| s.start_ms).collect::<Vec<_>>(),
            vec![0, 1_500, 3_900]
        );
        assert_eq!(
            lines(&merged),
            vec![
                ("s1".to_owned(), "The budget is ready.".to_owned()),
                (
                    "s2".to_owned(),
                    "That is great news. Can you send it?".to_owned()
                ),
                ("s1".to_owned(), "Of course.".to_owned()),
            ]
        );
        // A change far from any sentence end stays.
        let long = words(0, "one two three four five six seven eight");
        let split = merge(&[], &long, &[turn(0, 1_150, 0), turn(1_150, 2_400, 1)]);
        assert_eq!(split.len(), 2);
    }
}
