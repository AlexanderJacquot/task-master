//! Transcripts (Scribe M20, ADR 025): writing one as a batch with undo, correcting it
//! (text, split, delete, speakers), naming speakers, search, sync and export/import.

use taskmaster_core::*;

/// 2026-11-05 09:00 UTC.
const NINE: i64 = 1_793_869_200_000;

fn store() -> Store {
    Store::open_in_memory().unwrap()
}

fn add_meeting(s: &mut Store) -> Meeting {
    let meeting = NewMeeting {
        title: "Weekly".into(),
        started_at: NINE,
        ended_at: Some(NINE + 3_600_000),
        state: Some(MeetingState::Held),
        ..NewMeeting::default()
    };
    s.execute(Command::CreateMeeting { meeting })
        .unwrap()
        .meetings
        .remove(0)
}

fn seg(start_ms: i64, end_ms: i64, speaker: &str, text: &str) -> NewSegment {
    NewSegment {
        id: None,
        start_ms,
        end_ms,
        speaker: speaker.into(),
        text: text.into(),
    }
}

fn set(s: &mut Store, meeting_id: &str, segments: Vec<NewSegment>) -> Changes {
    s.execute(Command::SetTranscript {
        meeting_id: meeting_id.into(),
        segments,
    })
    .unwrap()
}

fn texts(s: &Store, meeting_id: &str) -> Vec<(String, String)> {
    s.transcript(meeting_id)
        .unwrap()
        .into_iter()
        .map(|t| (t.speaker, t.text))
        .collect()
}

fn invalid<T: std::fmt::Debug>(result: Result<T>) -> String {
    match result {
        Err(e) if e.kind() == "invalid" => e.to_string(),
        other => panic!("expected an invalid error, got {other:?}"),
    }
}

#[test]
fn a_transcript_is_written_as_one_batch_and_undone_as_one() {
    let mut s = store();
    let m = add_meeting(&mut s);
    let changes = set(
        &mut s,
        &m.id,
        vec![
            seg(4_000, 6_000, "s1", "Thanks, and the budget?"),
            seg(0, 3_500, "me", " Hello everyone. "),
            seg(6_500, 7_000, "s2", "   "),
        ],
    );
    // Blank segments are dropped; text is trimmed; order is by time.
    assert_eq!(changes.transcript_segments.len(), 2);
    assert_eq!(
        texts(&s, &m.id),
        vec![
            ("me".into(), "Hello everyone.".into()),
            ("s1".into(), "Thanks, and the budget?".into())
        ]
    );
    let meeting = s.meeting(&m.id).unwrap();
    assert_eq!(meeting.state, MeetingState::Review);
    assert!(meeting.transcribed_at.is_some());
    // Segments are not in the snapshot; meetings are.
    assert_eq!(s.snapshot().unwrap().meetings.len(), 1);

    // A new transcript (a retry) replaces the old one and clears the speaker names.
    s.execute(Command::UpdateMeeting {
        id: m.id.clone(),
        changes: vec![MeetingChange::SpeakerName {
            speaker: "s1".into(),
            name: Some("Ada".into()),
        }],
    })
    .unwrap();
    set(&mut s, &m.id, vec![seg(0, 1_000, "me", "Again.")]);
    assert_eq!(texts(&s, &m.id), vec![("me".into(), "Again.".into())]);
    assert!(s.meeting(&m.id).unwrap().speakers.is_empty());

    s.undo().unwrap();
    assert_eq!(texts(&s, &m.id).len(), 2);
    assert_eq!(s.meeting(&m.id).unwrap().speakers["s1"], "Ada");
    s.undo().unwrap();
    s.undo().unwrap();
    assert!(texts(&s, &m.id).is_empty());
    assert_eq!(s.meeting(&m.id).unwrap().state, MeetingState::Held);
}

#[test]
fn segments_are_corrected_split_deleted_and_reassigned() {
    let mut s = store();
    let m = add_meeting(&mut s);
    set(
        &mut s,
        &m.id,
        vec![
            seg(0, 10_000, "s1", "We ship on Friday. Any objections?"),
            seg(10_000, 12_000, "s2", "None from me."),
            seg(12_000, 13_000, "s3", "Fine."),
        ],
    );
    let ids: Vec<Id> = s
        .transcript(&m.id)
        .unwrap()
        .into_iter()
        .map(|t| t.id)
        .collect();

    s.execute(Command::UpdateSegment {
        id: ids[1].clone(),
        changes: vec![
            SegmentChange::Text("None from us.".into()),
            SegmentChange::Speaker("me".into()),
        ],
    })
    .unwrap();
    let second = &s.transcript(&m.id).unwrap()[1];
    assert_eq!((second.speaker.as_str(), second.edited), ("me", true));

    // Split after "Friday." (19 characters): times shared in proportion.
    let new_id = new_id();
    s.execute(Command::SplitSegment {
        id: ids[0].clone(),
        at: 19,
        new_id: Some(new_id.clone()),
    })
    .unwrap();
    let all = s.transcript(&m.id).unwrap();
    assert_eq!(all[0].text, "We ship on Friday.");
    assert_eq!(all[1].text, "Any objections?");
    assert_eq!(all[1].id, new_id);
    assert_eq!(all[0].end_ms, all[1].start_ms);
    assert!((5_000..6_000).contains(&all[0].end_ms), "{}", all[0].end_ms);
    assert!(
        invalid(s.execute(Command::SplitSegment {
            id: ids[0].clone(),
            at: 0,
            new_id: None,
        }))
        .contains("between two words")
    );

    // One voice found as two: s3 becomes s1.
    s.execute(Command::ReassignSpeaker {
        meeting_id: m.id.clone(),
        from: "s3".into(),
        to: "s1".into(),
    })
    .unwrap();
    assert!(
        s.transcript(&m.id)
            .unwrap()
            .iter()
            .all(|t| t.speaker != "s3")
    );

    s.execute(Command::DeleteSegment { id: ids[2].clone() })
        .unwrap();
    assert_eq!(s.transcript(&m.id).unwrap().len(), 3);
    s.undo().unwrap();
    assert_eq!(s.transcript(&m.id).unwrap().len(), 4);
}

#[test]
fn speakers_are_named_and_unnamed() {
    let mut s = store();
    let m = add_meeting(&mut s);
    let name = |s: &mut Store, speaker: &str, name: Option<&str>| {
        s.execute(Command::UpdateMeeting {
            id: m.id.clone(),
            changes: vec![MeetingChange::SpeakerName {
                speaker: speaker.into(),
                name: name.map(Into::into),
            }],
        })
    };
    name(&mut s, "s1", Some(" Ada ")).unwrap();
    name(&mut s, "s2", Some("Grace")).unwrap();
    name(&mut s, "s2", None).unwrap();
    let speakers = s.meeting(&m.id).unwrap().speakers;
    assert_eq!(speakers.len(), 1);
    assert_eq!(speakers["s1"], "Ada");
    // Two names in one update both stick.
    s.execute(Command::UpdateMeeting {
        id: m.id.clone(),
        changes: vec![
            MeetingChange::SpeakerName {
                speaker: "s2".into(),
                name: Some("Bob".into()),
            },
            MeetingChange::SpeakerName {
                speaker: "me".into(),
                name: Some("Alex".into()),
            },
        ],
    })
    .unwrap();
    assert_eq!(s.meeting(&m.id).unwrap().speakers.len(), 3);
    assert!(invalid(name(&mut s, "Ada", Some("x"))).contains("speaker"));
}

#[test]
fn bad_transcripts_are_refused() {
    let mut s = store();
    let m = add_meeting(&mut s);
    let refuse = |s: &mut Store, segment: NewSegment| {
        invalid(s.execute(Command::SetTranscript {
            meeting_id: m.id.clone(),
            segments: vec![segment],
        }))
    };
    assert!(refuse(&mut s, seg(5, 1, "me", "x")).contains("end after"));
    assert!(refuse(&mut s, seg(-1, 1, "me", "x")).contains("end after"));
    assert!(refuse(&mut s, seg(0, 1, "speaker1", "x")).contains("speaker"));
    assert!(refuse(&mut s, seg(0, 1, "s", "x")).contains("speaker"));
    assert!(refuse(&mut s, seg(0, 1, "me", &"a".repeat(10_001))).contains("characters"));
    set(&mut s, &m.id, vec![seg(0, 1, "me", "Hi")]);
    let id = s.transcript(&m.id).unwrap()[0].id.clone();
    assert!(
        invalid(s.execute(Command::UpdateSegment {
            id,
            changes: vec![SegmentChange::Text(" ".into())],
        }))
        .contains("delete it")
    );
    // A deleted meeting's transcript cannot be written.
    s.execute(Command::DeleteMeeting { id: m.id.clone() })
        .unwrap();
    let err = s
        .execute(Command::SetTranscript {
            meeting_id: m.id.clone(),
            segments: vec![],
        })
        .unwrap_err();
    assert_eq!(err.kind(), "not_found");
}

#[test]
fn transcripts_are_searched_with_the_matches_marked() {
    let mut s = store();
    let a = add_meeting(&mut s);
    let b = add_meeting(&mut s);
    set(
        &mut s,
        &a.id,
        vec![
            seg(0, 1_000, "me", "The quarterly budget is approved."),
            seg(1_000, 2_000, "s1", "Great news."),
        ],
    );
    set(
        &mut s,
        &b.id,
        vec![seg(60_000, 61_000, "s1", "Budgets again")],
    );
    let hits = s.search_transcripts("budg", 10).unwrap();
    assert_eq!(hits.len(), 2);
    let first = hits.iter().find(|h| h.meeting_id == a.id).unwrap();
    assert_eq!(first.speaker, "me");
    assert!(first.snippet.contains("[budget]"), "{}", first.snippet);
    assert_eq!(
        s.search_transcripts("budget approved", 10).unwrap().len(),
        1
    );
    assert!(s.search_transcripts("   ", 10).unwrap().is_empty());

    // Corrections are searchable; deleted meetings are not.
    let id = s.transcript(&a.id).unwrap()[1].id.clone();
    s.execute(Command::UpdateSegment {
        id,
        changes: vec![SegmentChange::Text("Great news, Ada.".into())],
    })
    .unwrap();
    assert_eq!(s.search_transcripts("ada", 10).unwrap().len(), 1);
    s.execute(Command::DeleteMeeting { id: b.id.clone() })
        .unwrap();
    assert_eq!(s.search_transcripts("budg", 10).unwrap().len(), 1);
}

fn sync(device: &mut Store, server: &mut Store) {
    loop {
        let page = device.outbox(50).unwrap();
        if !page.ops.is_empty() {
            server.apply_remote(page.ops, None).unwrap();
        }
        device.mark_pushed(page.last_seq).unwrap();
        if !page.more {
            break;
        }
    }
    loop {
        let page = server.ops_after(device.sync_cursor().unwrap(), 50).unwrap();
        device.apply_remote(page.ops, Some(page.last_seq)).unwrap();
        if !page.more {
            break;
        }
    }
}

#[test]
fn transcripts_and_speaker_names_sync() {
    let (mut a, mut b, mut server) = (store(), store(), store());
    let m = add_meeting(&mut a);
    let segments: Vec<NewSegment> = (0..120)
        .map(|i| {
            seg(
                i * 1_000,
                i * 1_000 + 900,
                if i % 2 == 0 { "me" } else { "s1" },
                "word",
            )
        })
        .collect();
    set(&mut a, &m.id, segments);
    sync(&mut a, &mut server);
    sync(&mut b, &mut server);
    assert_eq!(b.transcript(&m.id).unwrap().len(), 120);
    assert_eq!(b.meeting(&m.id).unwrap().state, MeetingState::Review);
    assert_eq!(b.search_transcripts("word", 200).unwrap().len(), 120);

    // Edits on both sides meet.
    let first = b.transcript(&m.id).unwrap()[0].id.clone();
    b.execute(Command::UpdateSegment {
        id: first.clone(),
        changes: vec![SegmentChange::Text("Hello".into())],
    })
    .unwrap();
    a.execute(Command::UpdateMeeting {
        id: m.id.clone(),
        changes: vec![MeetingChange::SpeakerName {
            speaker: "s1".into(),
            name: Some("Ada".into()),
        }],
    })
    .unwrap();
    sync(&mut b, &mut server);
    sync(&mut a, &mut server);
    sync(&mut b, &mut server);
    assert_eq!(a.transcript(&m.id).unwrap()[0].text, "Hello");
    assert_eq!(b.meeting(&m.id).unwrap().speakers["s1"], "Ada");
}

#[test]
fn export_and_import_carry_transcripts() {
    let mut s = store();
    let m = add_meeting(&mut s);
    set(&mut s, &m.id, vec![seg(0, 1_000, "me", "Kept in exports")]);
    let file = s.export().unwrap();
    let mut other = store();
    let summary = other.import(&file).unwrap();
    assert_eq!(summary.transcript_segments, 1);
    assert_eq!(
        texts(&other, &m.id),
        vec![("me".into(), "Kept in exports".into())]
    );
    assert_eq!(other.search_transcripts("exports", 5).unwrap().len(), 1);
}
