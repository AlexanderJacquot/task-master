//! Time zones named by `TZID` (ADR 037): IANA names, Windows names (Outlook and Exchange
//! feeds), IANA names inside vendor prefixes (`/mozilla.org/20050126_1/Europe/Paris`),
//! and, for a name none of those match, the fixed offset its `VTIMEZONE` gives.

use chrono::{DateTime, FixedOffset, NaiveDateTime, Offset, TimeZone, Utc};
use chrono_tz::Tz;

use super::Component;

/// Where a local time is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zone {
    Iana(Tz),
    /// Seconds east of UTC (an unknown `TZID`).
    Fixed(i32),
    /// The machine's own zone (floating times).
    Local,
}

impl Zone {
    /// The instant of a wall-clock time here. A time skipped by a DST change moves
    /// forward by the gap; an ambiguous one takes the earlier instant.
    pub fn to_utc(self, local: NaiveDateTime) -> DateTime<Utc> {
        fn pick<T: TimeZone>(tz: &T, local: NaiveDateTime) -> DateTime<Utc> {
            match tz.from_local_datetime(&local) {
                chrono::LocalResult::Single(t) => t.with_timezone(&Utc),
                chrono::LocalResult::Ambiguous(a, _) => a.with_timezone(&Utc),
                chrono::LocalResult::None => {
                    // In a spring-forward gap: the offset from before the gap.
                    let before = local - chrono::Duration::hours(3);
                    let offset = match tz.from_local_datetime(&before) {
                        chrono::LocalResult::Single(t) | chrono::LocalResult::Ambiguous(t, _) => {
                            t.offset().fix().local_minus_utc()
                        }
                        chrono::LocalResult::None => 0,
                    };
                    Utc.from_utc_datetime(&(local - chrono::Duration::seconds(offset.into())))
                }
            }
        }
        match self {
            Zone::Iana(tz) => pick(&tz, local),
            Zone::Fixed(secs) => pick(
                &FixedOffset::east_opt(secs).unwrap_or_else(|| Utc.fix()),
                local,
            ),
            Zone::Local => pick(&chrono::Local, local),
        }
    }

    /// For recurrence expansion: the rrule crate's zone, or `None` for a fixed offset
    /// (expanded in UTC, which a fixed offset matches up to the shift).
    pub fn rrule_tz(self) -> Option<rrule::Tz> {
        match self {
            Zone::Iana(tz) => Some(rrule::Tz::Tz(tz)),
            Zone::Local => Some(rrule::Tz::LOCAL),
            Zone::Fixed(_) => None,
        }
    }
}

/// The zone a `TZID` names. `timezones` are the calendar's `VTIMEZONE` components.
pub fn resolve(tzid: &str, timezones: &[&Component]) -> Zone {
    let name = tzid.trim().trim_matches('"');
    if let Some(zone) = by_name(name) {
        return zone;
    }
    // A VTIMEZONE may carry the IANA name it was made from.
    if let Some(vtz) = timezones
        .iter()
        .find(|c| c.value("TZID").is_some_and(|id| id.trim() == name))
    {
        for prop in ["X-LIC-LOCATION", "X-MICROSOFT-CDO-TZID-NAME", "TZNAME"] {
            if let Some(zone) = vtz.value(prop).and_then(by_name) {
                return zone;
            }
        }
        if let Some(offset) = standard_offset(vtz) {
            return Zone::Fixed(offset);
        }
    }
    Zone::Local
}

fn by_name(name: &str) -> Option<Zone> {
    if let Ok(tz) = name.parse::<Tz>() {
        return Some(Zone::Iana(tz));
    }
    if let Some(iana) = windows_to_iana(name) {
        return iana.parse::<Tz>().ok().map(Zone::Iana);
    }
    // `/mozilla.org/20050126_1/Europe/Paris`, `/softwarestudio.org/Olson_20011030_5/…`:
    // the longest tail that is an IANA name.
    let parts: Vec<&str> = name.split('/').filter(|p| !p.is_empty()).collect();
    for start in 0..parts.len() {
        if let Ok(tz) = parts[start..].join("/").parse::<Tz>()
            && parts.len() - start >= 2
        {
            return Some(Zone::Iana(tz));
        }
    }
    None
}

/// `TZOFFSETTO` of the `STANDARD` observance (`+0100`, `-0530`, `+013000`), in seconds.
fn standard_offset(vtz: &Component) -> Option<i32> {
    let observance = vtz
        .children
        .iter()
        .find(|c| c.name == "STANDARD")
        .or_else(|| vtz.children.first())?;
    parse_offset(observance.value("TZOFFSETTO")?)
}

pub fn parse_offset(text: &str) -> Option<i32> {
    let text = text.trim();
    let (sign, digits) = match text.as_bytes().first()? {
        b'+' => (1, &text[1..]),
        b'-' => (-1, &text[1..]),
        _ => (1, text),
    };
    if !(digits.len() == 4 || digits.len() == 6) || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let h: i32 = digits[0..2].parse().ok()?;
    let m: i32 = digits[2..4].parse().ok()?;
    let s: i32 = digits.get(4..6).map_or(Some(0), |s| s.parse().ok())?;
    Some(sign * (h * 3600 + m * 60 + s))
}

/// Windows time zone names to IANA, after CLDR's `windowsZones.xml` (territory 001).
fn windows_to_iana(name: &str) -> Option<&'static str> {
    WINDOWS_ZONES
        .iter()
        .find(|(windows, _)| windows.eq_ignore_ascii_case(name))
        .map(|(_, iana)| *iana)
}

const WINDOWS_ZONES: &[(&str, &str)] = &[
    ("Dateline Standard Time", "Etc/GMT+12"),
    ("UTC-11", "Etc/GMT+11"),
    ("Aleutian Standard Time", "America/Adak"),
    ("Hawaiian Standard Time", "Pacific/Honolulu"),
    ("Marquesas Standard Time", "Pacific/Marquesas"),
    ("Alaskan Standard Time", "America/Anchorage"),
    ("UTC-09", "Etc/GMT+9"),
    ("Pacific Standard Time (Mexico)", "America/Tijuana"),
    ("UTC-08", "Etc/GMT+8"),
    ("Pacific Standard Time", "America/Los_Angeles"),
    ("US Mountain Standard Time", "America/Phoenix"),
    ("Mountain Standard Time (Mexico)", "America/Mazatlan"),
    ("Mountain Standard Time", "America/Denver"),
    ("Yukon Standard Time", "America/Whitehorse"),
    ("Central America Standard Time", "America/Guatemala"),
    ("Central Standard Time", "America/Chicago"),
    ("Easter Island Standard Time", "Pacific/Easter"),
    ("Central Standard Time (Mexico)", "America/Mexico_City"),
    ("Canada Central Standard Time", "America/Regina"),
    ("SA Pacific Standard Time", "America/Bogota"),
    ("Eastern Standard Time (Mexico)", "America/Cancun"),
    ("Eastern Standard Time", "America/New_York"),
    ("Haiti Standard Time", "America/Port-au-Prince"),
    ("Cuba Standard Time", "America/Havana"),
    ("US Eastern Standard Time", "America/Indianapolis"),
    ("Turks And Caicos Standard Time", "America/Grand_Turk"),
    ("Paraguay Standard Time", "America/Asuncion"),
    ("Atlantic Standard Time", "America/Halifax"),
    ("Venezuela Standard Time", "America/Caracas"),
    ("Central Brazilian Standard Time", "America/Cuiaba"),
    ("SA Western Standard Time", "America/La_Paz"),
    ("Pacific SA Standard Time", "America/Santiago"),
    ("Newfoundland Standard Time", "America/St_Johns"),
    ("Tocantins Standard Time", "America/Araguaina"),
    ("E. South America Standard Time", "America/Sao_Paulo"),
    ("SA Eastern Standard Time", "America/Cayenne"),
    ("Argentina Standard Time", "America/Buenos_Aires"),
    ("Greenland Standard Time", "America/Godthab"),
    ("Montevideo Standard Time", "America/Montevideo"),
    ("Magallanes Standard Time", "America/Punta_Arenas"),
    ("Saint Pierre Standard Time", "America/Miquelon"),
    ("Bahia Standard Time", "America/Bahia"),
    ("UTC-02", "Etc/GMT+2"),
    ("Mid-Atlantic Standard Time", "Etc/GMT+2"),
    ("Azores Standard Time", "Atlantic/Azores"),
    ("Cape Verde Standard Time", "Atlantic/Cape_Verde"),
    ("UTC", "Etc/UTC"),
    ("Coordinated Universal Time", "Etc/UTC"),
    ("GMT Standard Time", "Europe/London"),
    ("Greenwich Standard Time", "Atlantic/Reykjavik"),
    ("Sao Tome Standard Time", "Africa/Sao_Tome"),
    ("Morocco Standard Time", "Africa/Casablanca"),
    ("W. Europe Standard Time", "Europe/Berlin"),
    ("Central Europe Standard Time", "Europe/Budapest"),
    ("Romance Standard Time", "Europe/Paris"),
    ("Central European Standard Time", "Europe/Warsaw"),
    ("W. Central Africa Standard Time", "Africa/Lagos"),
    ("Jordan Standard Time", "Asia/Amman"),
    ("GTB Standard Time", "Europe/Bucharest"),
    ("Middle East Standard Time", "Asia/Beirut"),
    ("Egypt Standard Time", "Africa/Cairo"),
    ("E. Europe Standard Time", "Europe/Chisinau"),
    ("Syria Standard Time", "Asia/Damascus"),
    ("West Bank Standard Time", "Asia/Hebron"),
    ("South Africa Standard Time", "Africa/Johannesburg"),
    ("FLE Standard Time", "Europe/Kiev"),
    ("Israel Standard Time", "Asia/Jerusalem"),
    ("South Sudan Standard Time", "Africa/Juba"),
    ("Kaliningrad Standard Time", "Europe/Kaliningrad"),
    ("Sudan Standard Time", "Africa/Khartoum"),
    ("Libya Standard Time", "Africa/Tripoli"),
    ("Namibia Standard Time", "Africa/Windhoek"),
    ("Arabic Standard Time", "Asia/Baghdad"),
    ("Turkey Standard Time", "Europe/Istanbul"),
    ("Arab Standard Time", "Asia/Riyadh"),
    ("Belarus Standard Time", "Europe/Minsk"),
    ("Russian Standard Time", "Europe/Moscow"),
    ("E. Africa Standard Time", "Africa/Nairobi"),
    ("Volgograd Standard Time", "Europe/Volgograd"),
    ("Iran Standard Time", "Asia/Tehran"),
    ("Arabian Standard Time", "Asia/Dubai"),
    ("Astrakhan Standard Time", "Europe/Astrakhan"),
    ("Azerbaijan Standard Time", "Asia/Baku"),
    ("Russia Time Zone 3", "Europe/Samara"),
    ("Mauritius Standard Time", "Indian/Mauritius"),
    ("Saratov Standard Time", "Europe/Saratov"),
    ("Georgian Standard Time", "Asia/Tbilisi"),
    ("Caucasus Standard Time", "Asia/Yerevan"),
    ("Afghanistan Standard Time", "Asia/Kabul"),
    ("West Asia Standard Time", "Asia/Tashkent"),
    ("Qyzylorda Standard Time", "Asia/Qyzylorda"),
    ("Ekaterinburg Standard Time", "Asia/Yekaterinburg"),
    ("Pakistan Standard Time", "Asia/Karachi"),
    ("India Standard Time", "Asia/Calcutta"),
    ("Sri Lanka Standard Time", "Asia/Colombo"),
    ("Nepal Standard Time", "Asia/Katmandu"),
    ("Central Asia Standard Time", "Asia/Bishkek"),
    ("Bangladesh Standard Time", "Asia/Dhaka"),
    ("Omsk Standard Time", "Asia/Omsk"),
    ("Myanmar Standard Time", "Asia/Rangoon"),
    ("SE Asia Standard Time", "Asia/Bangkok"),
    ("Altai Standard Time", "Asia/Barnaul"),
    ("W. Mongolia Standard Time", "Asia/Hovd"),
    ("North Asia Standard Time", "Asia/Krasnoyarsk"),
    ("N. Central Asia Standard Time", "Asia/Novosibirsk"),
    ("Tomsk Standard Time", "Asia/Tomsk"),
    ("China Standard Time", "Asia/Shanghai"),
    ("North Asia East Standard Time", "Asia/Irkutsk"),
    ("Singapore Standard Time", "Asia/Singapore"),
    ("W. Australia Standard Time", "Australia/Perth"),
    ("Taipei Standard Time", "Asia/Taipei"),
    ("Ulaanbaatar Standard Time", "Asia/Ulaanbaatar"),
    ("Aus Central W. Standard Time", "Australia/Eucla"),
    ("Transbaikal Standard Time", "Asia/Chita"),
    ("Tokyo Standard Time", "Asia/Tokyo"),
    ("North Korea Standard Time", "Asia/Pyongyang"),
    ("Korea Standard Time", "Asia/Seoul"),
    ("Yakutsk Standard Time", "Asia/Yakutsk"),
    ("Cen. Australia Standard Time", "Australia/Adelaide"),
    ("AUS Central Standard Time", "Australia/Darwin"),
    ("E. Australia Standard Time", "Australia/Brisbane"),
    ("AUS Eastern Standard Time", "Australia/Sydney"),
    ("West Pacific Standard Time", "Pacific/Port_Moresby"),
    ("Tasmania Standard Time", "Australia/Hobart"),
    ("Vladivostok Standard Time", "Asia/Vladivostok"),
    ("Lord Howe Standard Time", "Australia/Lord_Howe"),
    ("Bougainville Standard Time", "Pacific/Bougainville"),
    ("Russia Time Zone 10", "Asia/Srednekolymsk"),
    ("Magadan Standard Time", "Asia/Magadan"),
    ("Norfolk Standard Time", "Pacific/Norfolk"),
    ("Sakhalin Standard Time", "Asia/Sakhalin"),
    ("Central Pacific Standard Time", "Pacific/Guadalcanal"),
    ("Russia Time Zone 11", "Asia/Kamchatka"),
    ("New Zealand Standard Time", "Pacific/Auckland"),
    ("UTC+12", "Etc/GMT-12"),
    ("Fiji Standard Time", "Pacific/Fiji"),
    ("Chatham Islands Standard Time", "Pacific/Chatham"),
    ("UTC+13", "Etc/GMT-13"),
    ("Tonga Standard Time", "Pacific/Tongatapu"),
    ("Samoa Standard Time", "Pacific/Apia"),
    ("Line Islands Standard Time", "Pacific/Kiritimati"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_resolve_to_zones() {
        assert_eq!(
            resolve("Europe/Paris", &[]),
            Zone::Iana(chrono_tz::Europe::Paris)
        );
        assert_eq!(
            resolve("Romance Standard Time", &[]),
            Zone::Iana(chrono_tz::Europe::Paris)
        );
        assert_eq!(
            resolve("/mozilla.org/20050126_1/America/New_York", &[]),
            Zone::Iana(chrono_tz::America::New_York)
        );
        assert_eq!(parse_offset("+0530"), Some(19_800));
        assert_eq!(parse_offset("-0800"), Some(-28_800));
        assert_eq!(parse_offset("+013000"), Some(5_400));
        assert_eq!(parse_offset("bad"), None);
        for (_, iana) in WINDOWS_ZONES {
            assert!(iana.parse::<Tz>().is_ok(), "{iana} is not an IANA name");
        }
    }

    #[test]
    fn dst_gaps_and_overlaps_resolve() {
        let paris = Zone::Iana(chrono_tz::Europe::Paris);
        let at = |s: &str| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap();
        // 2026-03-29 02:30 does not exist in Paris: read with the winter offset.
        assert_eq!(
            paris.to_utc(at("2026-03-29 02:30")).to_rfc3339(),
            "2026-03-29T01:30:00+00:00"
        );
        // 2026-10-25 02:30 happens twice: the first one.
        assert_eq!(
            paris.to_utc(at("2026-10-25 02:30")).to_rfc3339(),
            "2026-10-25T00:30:00+00:00"
        );
        assert_eq!(
            Zone::Fixed(3600)
                .to_utc(at("2026-01-01 10:00"))
                .to_rfc3339(),
            "2026-01-01T09:00:00+00:00"
        );
    }
}
