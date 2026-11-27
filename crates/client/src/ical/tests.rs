use super::*;

fn ms(rfc3339: &str) -> i64 {
    DateTime::parse_from_rfc3339(rfc3339)
        .unwrap()
        .timestamp_millis()
}

fn read(text: &str) -> Vec<Event> {
    events(&parse(text).unwrap())
}

fn timed(occ: &Occurrence<'_>) -> (String, String) {
    match occ.when {
        When::Timed { start_at, end_at } => (
            Utc.timestamp_millis_opt(start_at).unwrap().to_rfc3339(),
            Utc.timestamp_millis_opt(end_at).unwrap().to_rfc3339(),
        ),
        When::AllDay { .. } => panic!("not timed: {occ:?}"),
    }
}

#[test]
fn reads_folded_lines_parameters_and_escapes() {
    let text = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a@b\r\nDTSTART:20261105T090000Z\r\n\
        SUMMARY:Plan\\, review \\; ship\\nnow\r\nLOCATION;ALTREP=\"http://x/y:z\";LANGUAGE=fr:Sa\r\n lle 4\r\n\
        END:VEVENT\r\nEND:VCALENDAR\r\n";
    let calendars = parse(text).unwrap();
    let event = &calendars[0].children[0];
    assert_eq!(event.text("SUMMARY").unwrap(), "Plan, review ; ship\nnow");
    let location = event.prop("LOCATION").unwrap();
    assert_eq!(location.param("ALTREP"), Some("http://x/y:z"));
    assert_eq!(location.param("LANGUAGE"), Some("fr"));
    assert_eq!(location.value, "Salle 4");
    assert!(parse("hello").is_err());
}

#[test]
fn durations() {
    assert_eq!(parse_duration("PT1H30M"), Some(Duration::minutes(90)));
    assert_eq!(parse_duration("P1W"), Some(Duration::days(7)));
    assert_eq!(parse_duration("P1DT2H"), Some(Duration::hours(26)));
    assert_eq!(parse_duration("-PT15M"), Some(Duration::minutes(-15)));
    assert_eq!(parse_duration("P"), None);
    assert_eq!(parse_duration("PT5"), None);
}

#[test]
fn single_events_timed_all_day_and_zoned() {
    let events = read(
        "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nDTSTART;TZID=Europe/Paris:20261105T100000\n\
         DURATION:PT45M\nSUMMARY:Standup\nEND:VEVENT\nBEGIN:VEVENT\nUID:2\n\
         DTSTART;VALUE=DATE:20261106\nDTEND;VALUE=DATE:20261108\nSUMMARY:Off\nEND:VEVENT\n\
         BEGIN:VEVENT\nUID:3\nDTSTART;VALUE=DATE:20261120\nSUMMARY:One day\nEND:VEVENT\n\
         END:VCALENDAR",
    );
    let occ = expand(
        &events,
        ms("2026-11-01T00:00:00Z"),
        ms("2026-12-01T00:00:00Z"),
    );
    assert_eq!(occ.len(), 3);
    assert_eq!(
        timed(&occ[0]),
        (
            "2026-11-05T09:00:00+00:00".into(),
            "2026-11-05T09:45:00+00:00".into()
        )
    );
    assert_eq!(
        occ[1].when,
        When::AllDay {
            start: "2026-11-06".into(),
            end: "2026-11-08".into()
        }
    );
    assert_eq!(
        occ[2].when,
        When::AllDay {
            start: "2026-11-20".into(),
            end: "2026-11-21".into()
        }
    );
    assert!(occ.iter().all(|o| o.instance.is_none()));
    // Outside the window.
    assert!(
        expand(
            &events,
            ms("2027-01-01T00:00:00Z"),
            ms("2027-02-01T00:00:00Z")
        )
        .is_empty()
    );
}

#[test]
fn weekly_rule_keeps_wall_clock_time_across_dst() {
    let events = read(
        "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:w\nDTSTART;TZID=Europe/Paris:20261019T093000\n\
         DTEND;TZID=Europe/Paris:20261019T100000\nRRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3\n\
         SUMMARY:Weekly\nEND:VEVENT\nEND:VCALENDAR",
    );
    let occ = expand(
        &events,
        ms("2026-10-01T00:00:00Z"),
        ms("2026-12-01T00:00:00Z"),
    );
    let starts: Vec<String> = occ.iter().map(|o| timed(o).0).collect();
    assert_eq!(
        starts,
        [
            "2026-10-19T07:30:00+00:00", // CEST
            "2026-10-26T08:30:00+00:00", // CET after 25 October
            "2026-11-02T08:30:00+00:00",
        ]
    );
    assert_eq!(occ[1].instance.as_deref(), Some("20261026T083000Z"));
}

#[test]
fn exdates_overrides_and_cancelled_instances() {
    let events = read(
        "BEGIN:VCALENDAR\n\
         BEGIN:VEVENT\nUID:r\nDTSTART:20261102T090000Z\nDTEND:20261102T100000Z\n\
         RRULE:FREQ=DAILY;UNTIL=20261106T090000Z\nEXDATE:20261103T090000Z\nSUMMARY:Daily\n\
         END:VEVENT\n\
         BEGIN:VEVENT\nUID:r\nRECURRENCE-ID:20261104T090000Z\nDTSTART:20261104T140000Z\n\
         DTEND:20261104T150000Z\nSUMMARY:Daily (moved)\nEND:VEVENT\n\
         BEGIN:VEVENT\nUID:r\nRECURRENCE-ID:20261105T090000Z\nDTSTART:20261105T090000Z\n\
         DTEND:20261105T100000Z\nSTATUS:CANCELLED\nEND:VEVENT\n\
         END:VCALENDAR",
    );
    let occ = expand(
        &events,
        ms("2026-11-01T00:00:00Z"),
        ms("2026-11-30T00:00:00Z"),
    );
    let got: Vec<(String, String)> = occ
        .iter()
        .map(|o| (timed(o).0, o.event.summary.clone().unwrap()))
        .collect();
    assert_eq!(
        got,
        [
            ("2026-11-02T09:00:00+00:00".into(), "Daily".into()),
            ("2026-11-04T14:00:00+00:00".into(), "Daily (moved)".into()),
            ("2026-11-06T09:00:00+00:00".into(), "Daily".into()),
        ]
    );
    assert_eq!(occ[1].instance.as_deref(), Some("20261104T090000Z"));
}

#[test]
fn until_as_a_date_and_rdates() {
    let events = read(
        "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:u\nDTSTART;TZID=America/New_York:20261102T180000\n\
         DTEND;TZID=America/New_York:20261102T190000\nRRULE:FREQ=DAILY;UNTIL=20261103\n\
         RDATE;TZID=America/New_York:20261110T180000\nSUMMARY:Class\nEND:VEVENT\n\
         BEGIN:VEVENT\nUID:y\nDTSTART;VALUE=DATE:20200229\nRRULE:FREQ=YEARLY\n\
         SUMMARY:Leap\nEND:VEVENT\nEND:VCALENDAR",
    );
    let occ = expand(
        &events,
        ms("2026-11-01T00:00:00Z"),
        ms("2026-11-30T00:00:00Z"),
    );
    let starts: Vec<String> = occ.iter().map(|o| timed(o).0).collect();
    assert_eq!(
        starts,
        [
            "2026-11-02T23:00:00+00:00",
            "2026-11-03T23:00:00+00:00",
            "2026-11-10T23:00:00+00:00"
        ]
    );
    // A yearly rule on 29 February only matches leap years.
    let leap = expand(
        &events,
        ms("2027-01-01T00:00:00Z"),
        ms("2029-01-01T00:00:00Z"),
    );
    assert_eq!(
        leap.iter().map(|o| o.when.clone()).collect::<Vec<_>>(),
        [When::AllDay {
            start: "2028-02-29".into(),
            end: "2028-03-01".into()
        }]
    );
}

#[test]
fn monthly_by_set_pos_and_long_running_rules() {
    let events = read(
        "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:m\nDTSTART:20260130T160000Z\nDURATION:PT1H\n\
         RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1\nSUMMARY:Month end\nEND:VEVENT\n\
         BEGIN:VEVENT\nUID:d\nDTSTART:19990101T080000Z\nDURATION:PT10M\nRRULE:FREQ=DAILY\n\
         SUMMARY:Since 1999\nEND:VEVENT\nEND:VCALENDAR",
    );
    let occ = expand(
        &events,
        ms("2026-11-01T00:00:00Z"),
        ms("2027-01-01T00:00:00Z"),
    );
    let month_end: Vec<String> = occ
        .iter()
        .filter(|o| o.event.uid == "m")
        .map(|o| timed(o).0)
        .collect();
    assert_eq!(
        month_end,
        ["2026-11-30T16:00:00+00:00", "2026-12-31T16:00:00+00:00"]
    );
    assert_eq!(occ.iter().filter(|o| o.event.uid == "d").count(), 61);
}

#[test]
fn windows_zone_names_and_unknown_vtimezones() {
    let events = read(
        "BEGIN:VCALENDAR\nBEGIN:VTIMEZONE\nTZID:Customized Time Zone\nBEGIN:STANDARD\n\
         DTSTART:16010101T000000\nTZOFFSETFROM:+0600\nTZOFFSETTO:+0530\nEND:STANDARD\n\
         END:VTIMEZONE\n\
         BEGIN:VEVENT\nUID:1\nDTSTART;TZID=W. Europe Standard Time:20260701T100000\n\
         DTEND;TZID=W. Europe Standard Time:20260701T110000\nSUMMARY:Berlin\nEND:VEVENT\n\
         BEGIN:VEVENT\nUID:2\nDTSTART;TZID=Customized Time Zone:20260701T100000\n\
         DTEND;TZID=Customized Time Zone:20260701T110000\nRRULE:FREQ=DAILY;COUNT=2\n\
         SUMMARY:Fixed\nEND:VEVENT\nEND:VCALENDAR",
    );
    let occ = expand(
        &events,
        ms("2026-06-01T00:00:00Z"),
        ms("2026-08-01T00:00:00Z"),
    );
    let starts: Vec<String> = occ.iter().map(|o| timed(o).0).collect();
    assert_eq!(
        starts,
        [
            "2026-07-01T04:30:00+00:00",
            "2026-07-01T08:00:00+00:00",
            "2026-07-02T04:30:00+00:00",
        ]
    );
}

#[test]
fn writes_one_event_that_reads_back() {
    let body = EventBody {
        title: "Write the spec, part 2; with a very long title that has to be folded somewhere ✓✓✓"
            .into(),
        description: "Planned in task-master.\nSecond line".into(),
        when: When::Timed {
            start_at: ms("2026-11-05T09:00:00Z"),
            end_at: ms("2026-11-05T10:30:00Z"),
        },
        key: "block:01abc".into(),
        show_as: ShowAs::Busy,
        private: None,
    };
    let text = write_event("uid-1", &body, ms("2026-11-01T08:00:00Z"));
    assert!(text.lines().all(|l| l.len() <= 76), "{text}"); // 75 octets + CR
    assert!(text.contains("TRANSP:OPAQUE\r\n"));
    assert!(text.contains("X-TASKMASTER-KEY:block:01abc\r\n"));
    let events = read(&text);
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.uid, "uid-1");
    assert_eq!(event.summary.as_deref(), Some(body.title.as_str()));
    assert_eq!(event.key.as_deref(), Some("block:01abc"));
    let occ = expand(&events, 0, i64::MAX / 2);
    assert_eq!(occ[0].when, body.when);

    let plan = EventBody {
        title: "Plan".into(),
        description: String::new(),
        when: When::AllDay {
            start: "2026-11-05".into(),
            end: "2026-11-06".into(),
        },
        key: "plan:t".into(),
        show_as: ShowAs::Free,
        private: None,
    };
    let text = write_event("uid-2", &plan, 0);
    assert!(text.contains("DTSTART;VALUE=DATE:20261105\r\n"));
    assert!(text.contains("TRANSP:TRANSPARENT\r\n"));
    assert!(!text.contains("DESCRIPTION"));
    assert_eq!(expand(&read(&text), 0, i64::MAX / 2)[0].when, plan.when);
}

/// Real-world shapes (iCloud, Google, Outlook exports, made up but structured as those
/// services write them), expanded over a fixed window.
#[test]
fn fixtures_expand_as_snapshotted() {
    for name in ["icloud", "google", "outlook"] {
        let path = format!(
            "{}/tests/fixtures/ical/{name}.ics",
            env!("CARGO_MANIFEST_DIR")
        );
        let text = std::fs::read_to_string(&path).unwrap();
        let events = read(&text);
        let lines: Vec<String> = expand(
            &events,
            ms("2026-11-01T00:00:00Z"),
            ms("2026-12-01T00:00:00Z"),
        )
        .iter()
        .map(|o| {
            let when = match &o.when {
                When::Timed { start_at, end_at } => format!(
                    "{} → {}",
                    Utc.timestamp_millis_opt(*start_at)
                        .unwrap()
                        .format("%Y-%m-%d %H:%M"),
                    Utc.timestamp_millis_opt(*end_at)
                        .unwrap()
                        .format("%Y-%m-%d %H:%M")
                ),
                When::AllDay { start, end } => format!("{start} → {end} (all day)"),
            };
            format!(
                "{when} | {} | {}",
                o.event.summary.as_deref().unwrap_or("(no title)"),
                o.instance.as_deref().unwrap_or("-")
            )
        })
        .collect();
        insta::assert_snapshot!(format!("fixture_{name}"), lines.join("\n"));
    }
}

#[test]
fn writes_a_meetings_show_as_and_privacy() {
    let meeting = |show_as, private| EventBody {
        title: "1:1".into(),
        description: String::new(),
        when: When::Timed {
            start_at: ms("2026-11-05T09:00:00Z"),
            end_at: ms("2026-11-05T09:30:00Z"),
        },
        key: "meeting:m".into(),
        show_as,
        private,
    };
    let busy = write_event("uid-m", &meeting(ShowAs::Busy, Some(true)), 0);
    assert!(busy.contains("TRANSP:OPAQUE\r\n") && busy.contains("CLASS:PRIVATE\r\n"));
    assert!(!busy.contains("STATUS:"));
    let maybe = write_event("uid-m", &meeting(ShowAs::Tentative, Some(false)), 0);
    assert!(maybe.contains("TRANSP:OPAQUE\r\n") && maybe.contains("STATUS:TENTATIVE\r\n"));
    assert!(maybe.contains("CLASS:PUBLIC\r\n"));
    let free = write_event("uid-m", &meeting(ShowAs::Free, Some(true)), 0);
    assert!(free.contains("TRANSP:TRANSPARENT\r\n"));
    // Written tentative, read back as a live event.
    assert!(!read(&maybe)[0].cancelled);
}
