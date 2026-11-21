//! The image of a roadmap (ADR 034): what the Roadmap page shows (ADR 031) drawn as one SVG,
//! the whole timeline at once rather than the part that is scrolled into view.
//!
//! A pure function of a [`RoadmapImage`]: the rows already worked out by whoever shows the
//! roadmap (the desktop page, or `roadmap::roadmap_image` for the sync server, ADR 035),
//! each with its bar. Only what is on the timeline is in it: epics and tasks without a
//! bar, and groups with none of them, stay out, so the image is only bars. The renderer
//! works out the rest: the range of days (the bars and the target date, a little room on
//! both sides, whole weeks, months or quarters), the scale, the arrows and what is flagged
//! (late links, overdue bars, bars past the target date). Text is measured with a width
//! table rather than a font, so labels are placed conservatively; the image names its
//! fonts and viewers fall back to their own.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::model::{IsoDate, RoadmapZoom};
use crate::parse::dates::{to_days, to_iso};

/// What a roadmap image shows. Built from the same rows as the page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct RoadmapImage {
    /// The heading: "Roadmap", the epic's name or the saved view's.
    pub title: String,
    /// A line under the heading, e.g. what it shows and as of when. Empty for none.
    #[serde(default)]
    pub subtitle: String,
    /// The name column's heading: "Epic" or "Task".
    pub name_header: String,
    pub zoom: RoadmapZoom,
    /// The day the today line is drawn on (when it falls inside the range).
    pub today: IsoDate,
    /// An epic's target date across its task timeline.
    #[serde(default)]
    pub deadline: Option<ImageDeadline>,
    /// Top to bottom: group headers and the epics or tasks under them.
    pub rows: Vec<ImageRow>,
    /// Dependency arrows, from what is waited on to what waits; links to rows that are not
    /// in the image are left out.
    #[serde(default)]
    pub links: Vec<ImageLink>,
    #[serde(default)]
    pub theme: ImageTheme,
}

/// An epic's target date: a dashed line, tagged on the scale.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ImageDeadline {
    pub date: IsoDate,
    /// What the date belongs to (the epic's name), for the image's description.
    #[serde(default)]
    pub label: String,
}

/// One line of the image.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ImageRow {
    /// A project's header, with a thin bar from its first start to its last end.
    Group {
        label: String,
        /// `#rgb` or `#rrggbb`; anything else draws in the theme's grey.
        #[serde(default)]
        color: Option<String>,
        /// How many bars it holds (folded or not).
        count: u32,
        start: IsoDate,
        end: IsoDate,
    },
    /// An epic or a task, and its bar (first and last day, both included).
    Item {
        id: String,
        title: String,
        /// Subtasks are indented under their parent.
        #[serde(default)]
        depth: u32,
        start: IsoDate,
        end: IsoDate,
        /// A done task, or an epic that is done or dropped.
        #[serde(default)]
        done: bool,
        /// An epic's share of done tasks, 0 to 1; `None` for a task.
        #[serde(default)]
        progress: Option<f64>,
        #[serde(default)]
        color: Option<String>,
    },
}

/// `to` waits on `from`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ImageLink {
    pub from: String,
    pub to: String,
}

/// The app's themes (ADR 005's light, dark and clean), as fixed colors.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum ImageTheme {
    Light,
    Dark,
    #[default]
    Clean,
}

/// At most this many rows, and this many days across.
pub const MAX_IMAGE_ROWS: usize = 5_000;
pub const MAX_IMAGE_DAYS: i64 = 366 * 20;

const PAD: f64 = 24.0;
const ROW: f64 = 32.0;
const SCALE: f64 = 44.0;
const NAME_MIN: f64 = 160.0;
const NAME_MAX: f64 = 340.0;
/// The narrowest timeline, so a short plan still reads as one.
const MIN_TIMELINE: f64 = 480.0;
/// The longest label beside a bar.
const SIDE_LABEL_MAX: f64 = 260.0;
const FONTS: &str = "Inter, 'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

fn day_width(zoom: RoadmapZoom) -> f64 {
    match zoom {
        RoadmapZoom::Day => 40.0,
        RoadmapZoom::Week => 18.0,
        RoadmapZoom::Month => 5.0,
        RoadmapZoom::Quarter => 2.0,
    }
}

/// A color and how opaque it is drawn.
#[derive(Clone, Copy)]
struct Paint(&'static str, f64);

struct Palette {
    canvas: &'static str,
    raised: &'static str,
    ink: &'static str,
    ink2: &'static str,
    ink3: &'static str,
    line: Paint,
    line_strong: Paint,
    accent: &'static str,
    danger: &'static str,
    rubric: &'static str,
    done: &'static str,
}

fn palette(theme: ImageTheme) -> Palette {
    match theme {
        ImageTheme::Light => Palette {
            canvas: "#f3eada",
            raised: "#f9f2e3",
            ink: "#2b2116",
            ink2: "#5c4a36",
            ink3: "#6e5a44",
            line: Paint("#5a3c14", 0.15),
            line_strong: Paint("#5a3c14", 0.26),
            accent: "#8b2e1f",
            danger: "#a3301f",
            rubric: "#8b2e1f",
            done: "#3f7a52",
        },
        ImageTheme::Dark => Palette {
            canvas: "#0e0e10",
            raised: "#1b1b1f",
            ink: "#ededf0",
            ink2: "#a8a8b3",
            ink3: "#8a8a95",
            line: Paint("#ffffff", 0.07),
            line_strong: Paint("#ffffff", 0.13),
            accent: "#d9a54a",
            danger: "#f2857a",
            rubric: "#d4d4da",
            done: "#6fbf8a",
        },
        ImageTheme::Clean => Palette {
            canvas: "#ffffff",
            raised: "#ffffff",
            ink: "#37352f",
            ink2: "#6b6a66",
            ink3: "#8a8984",
            line: Paint("#37352f", 0.09),
            line_strong: Paint("#37352f", 0.16),
            accent: "#2383e2",
            danger: "#d44c47",
            rubric: "#5f5e5b",
            done: "#448361",
        },
    }
}

/// The image as SVG: its text, and its size in pixels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct RenderedImage {
    pub svg: String,
    pub width: u32,
    pub height: u32,
}

// ---------------------------------------------------------------------------------------
// Text

/// Escapes text for SVG content and attribute values; control characters are dropped.
fn esc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// A generous estimate of how wide `text` is at `size` pixels in a sans-serif font.
fn text_width(text: &str, size: f64) -> f64 {
    let em: f64 = text
        .chars()
        .map(|c| match c {
            ' ' => 0.28,
            'i' | 'l' | 'j' | '.' | ',' | ':' | ';' | '!' | '|' | '\'' | 'I' | '(' | ')' => 0.3,
            'f' | 't' | 'r' => 0.38,
            'm' | 'w' | 'M' | 'W' | '@' | '%' => 0.88,
            'A'..='Z' => 0.68,
            '0'..='9' => 0.58,
            c if c.is_ascii() => 0.56,
            // CJK, kana, hangul and emoji are about square.
            c if c >= '\u{2E80}' => 1.0,
            _ => 0.62,
        })
        .sum();
    em * size
}

/// `text`, cut with an ellipsis to fit `max` pixels.
fn fit(text: &str, size: f64, max: f64) -> String {
    let text = text.trim();
    if text_width(text, size) <= max {
        return text.to_string();
    }
    let room = max - text_width("…", size);
    let mut out = String::new();
    let mut width = 0.0;
    for c in text.chars() {
        let w = text_width(c.encode_utf8(&mut [0; 4]), size);
        if width + w > room {
            break;
        }
        width += w;
        out.push(c);
    }
    format!("{}…", out.trim_end())
}

/// A number for an attribute: at most one decimal, no trailing `.0`.
fn n(value: f64) -> String {
    let rounded = (value * 10.0).round() / 10.0;
    if rounded.fract() == 0.0 {
        format!("{rounded:.0}")
    } else {
        format!("{rounded:.1}")
    }
}

/// `#rgb` or `#rrggbb`, else nothing (so nothing else reaches the SVG).
fn color(value: Option<&str>) -> Option<&str> {
    let v = value?.trim();
    let hex = v.strip_prefix('#')?;
    ((hex.len() == 3 || hex.len() == 6) && hex.bytes().all(|b| b.is_ascii_hexdigit())).then_some(v)
}

/// "Dec 1", with the year when it is not `today`'s.
fn short_date(day: i64, today: i64) -> String {
    let (y, m, d) = ymd(day);
    let month = &MONTHS[m - 1][..3];
    if y == ymd(today).0 {
        format!("{month} {d}")
    } else {
        format!("{month} {d}, {y}")
    }
}

// ---------------------------------------------------------------------------------------
// Days

fn ymd(day: i64) -> (i64, usize, i64) {
    let iso = to_iso(day);
    let num = |r: std::ops::Range<usize>| iso[r].parse::<i64>().unwrap_or(1);
    let month = usize::try_from(num(5..7)).unwrap_or(1).clamp(1, 12);
    (num(0..4), month, num(8..10))
}

/// 0 = Monday .. 6 = Sunday.
fn weekday(day: i64) -> i64 {
    (day + 3).rem_euclid(7)
}

fn is_weekend(day: i64) -> bool {
    weekday(day) >= 5
}

fn first_of_month(year: i64, month: usize) -> i64 {
    to_days(&format!("{year:04}-{month:02}-01")).unwrap_or(0)
}

/// The first day of the week, month or quarter `day` is in.
fn unit_start(day: i64, zoom: RoadmapZoom) -> i64 {
    let (y, m, _) = ymd(day);
    match zoom {
        RoadmapZoom::Day | RoadmapZoom::Week => day - weekday(day),
        RoadmapZoom::Month => first_of_month(y, m),
        RoadmapZoom::Quarter => first_of_month(y, (m - 1) / 3 * 3 + 1),
    }
}

/// The last day of the week, month or quarter `day` is in.
fn unit_end(day: i64, zoom: RoadmapZoom) -> i64 {
    let (y, m, _) = ymd(day);
    let next = |month: usize| {
        if month > 12 {
            first_of_month(y + 1, month - 12)
        } else {
            first_of_month(y, month)
        }
    };
    match zoom {
        RoadmapZoom::Day | RoadmapZoom::Week => day - weekday(day) + 6,
        RoadmapZoom::Month => next(m + 1) - 1,
        RoadmapZoom::Quarter => next((m - 1) / 3 * 3 + 4) - 1,
    }
}

/// Room left on both sides of the bars, in pixels.
const MARGIN: f64 = 16.0;
/// The range reaches out to a whole week, month or quarter when that adds at most this.
const SNAP: f64 = 72.0;

fn snap_days(dw: f64) -> i64 {
    (SNAP / dw).floor() as i64
}

/// The range's first day for bars starting on `first`.
fn range_start(first: i64, zoom: RoadmapZoom, dw: f64) -> i64 {
    let day = first - (MARGIN / dw).ceil() as i64;
    let unit = unit_start(day, zoom);
    if day - unit <= snap_days(dw) {
        unit
    } else {
        day
    }
}

/// The range's last day for bars ending on `last`.
fn range_end(last: i64, zoom: RoadmapZoom, dw: f64) -> i64 {
    snap_end(last + (MARGIN / dw).ceil() as i64, zoom, dw)
}

/// `day`, or the end of its week, month or quarter when that is near.
fn snap_end(day: i64, zoom: RoadmapZoom, dw: f64) -> i64 {
    let unit = unit_end(day, zoom);
    if unit - day <= snap_days(dw) {
        unit
    } else {
        day
    }
}

/// A labelled stretch of the scale, in days from the range's first day.
#[derive(Debug, PartialEq)]
struct Tick {
    label: String,
    offset: i64,
    length: i64,
}

/// Splits `from..from + days` wherever `key` changes; `name` labels each piece.
fn split(
    from: i64,
    days: i64,
    key: impl Fn(i64) -> i64,
    name: impl Fn(i64) -> String,
) -> Vec<Tick> {
    let mut out: Vec<Tick> = Vec::new();
    let mut last_key = None;
    for i in 0..days {
        let k = key(from + i);
        match out.last_mut() {
            Some(tick) if last_key == Some(k) => tick.length += 1,
            _ => out.push(Tick {
                label: name(from + i),
                offset: i,
                length: 1,
            }),
        }
        last_key = Some(k);
    }
    out
}

/// The coarse row of the scale (months or years) and the fine one (days, weeks, months or
/// quarters), as on the page.
fn ticks(from: i64, days: i64, zoom: RoadmapZoom) -> (Vec<Tick>, Vec<Tick>) {
    let month_key = |d: i64| {
        let (y, m, _) = ymd(d);
        y * 12 + i64::try_from(m).unwrap_or(1)
    };
    let year_key = |d: i64| ymd(d).0;
    match zoom {
        RoadmapZoom::Day => (
            split(from, days, month_key, |d| {
                let (y, m, _) = ymd(d);
                format!("{} {y}", MONTHS[m - 1])
            }),
            split(from, days, |d| d, |d| ymd(d).2.to_string()),
        ),
        RoadmapZoom::Week => (
            split(from, days, month_key, |d| {
                let (y, m, _) = ymd(d);
                format!("{} {y}", &MONTHS[m - 1][..3])
            }),
            split(
                from,
                days,
                |d| d - weekday(d),
                |d| ymd(d - weekday(d)).2.to_string(),
            ),
        ),
        RoadmapZoom::Month => (
            split(from, days, year_key, |d| ymd(d).0.to_string()),
            split(from, days, month_key, |d| {
                MONTHS[ymd(d).1 - 1][..3].to_string()
            }),
        ),
        RoadmapZoom::Quarter => (
            split(from, days, year_key, |d| ymd(d).0.to_string()),
            split(
                from,
                days,
                |d| ymd(d).0 * 4 + i64::try_from((ymd(d).1 - 1) / 3).unwrap_or(0),
                |d| format!("Q{}", (ymd(d).1 - 1) / 3 + 1),
            ),
        ),
    }
}

// ---------------------------------------------------------------------------------------
// Layout

/// A row with its days checked.
enum Line<'a> {
    Group {
        label: &'a str,
        color: Option<&'a str>,
        count: u32,
        start: i64,
        end: i64,
    },
    Item {
        title: &'a str,
        depth: u32,
        start: i64,
        end: i64,
        done: bool,
        progress: Option<f64>,
        color: Option<&'a str>,
    },
}

fn day_of(field: &str, iso: &str) -> Result<i64> {
    to_days(iso)
        .ok_or_else(|| Error::invalid(format!("{field} must be a YYYY-MM-DD date, got '{iso}'")))
}

/// A bar's two days, in order.
fn span(start: &str, end: &str) -> Result<(i64, i64)> {
    let (a, b) = (day_of("start", start)?, day_of("end", end)?);
    Ok((a.min(b), a.max(b)))
}

/// Where a bar's label goes: inside it, or beside it on the right.
enum Label {
    Inside(String),
    Beside(String),
}

const LABEL_SIZE: f64 = 12.0;
const NAME_SIZE: f64 = 13.0;

fn progress_text(progress: Option<f64>) -> String {
    progress.map_or(String::new(), |p| {
        format!(" · {}%", (p.clamp(0.0, 1.0) * 100.0).round())
    })
}

fn bar_label(title: &str, progress: Option<f64>, bar_width: f64) -> Label {
    let full = format!("{}{}", title.trim(), progress_text(progress));
    if text_width(&full, LABEL_SIZE) + 16.0 <= bar_width {
        Label::Inside(full)
    } else {
        Label::Beside(fit(&full, LABEL_SIZE, SIDE_LABEL_MAX))
    }
}

/// Renders the roadmap as SVG. Fails on a bad date, no rows, or more than the limits.
pub fn render(image: &RoadmapImage) -> Result<RenderedImage> {
    if image.rows.is_empty() {
        return Err(Error::invalid("a roadmap image needs at least one bar"));
    }
    if image.rows.len() > MAX_IMAGE_ROWS {
        return Err(Error::invalid(format!(
            "a roadmap image holds at most {MAX_IMAGE_ROWS} rows"
        )));
    }
    let today = day_of("today", &image.today)?;
    let deadline = match &image.deadline {
        Some(d) => Some(day_of("deadline", &d.date)?),
        None => None,
    };
    let mut lines = Vec::with_capacity(image.rows.len());
    let mut bars: HashMap<&str, (usize, i64, i64)> = HashMap::new();
    for row in &image.rows {
        match row {
            ImageRow::Group {
                label,
                color: c,
                count,
                start,
                end,
            } => {
                let (start, end) = span(start, end)?;
                lines.push(Line::Group {
                    label,
                    color: color(c.as_deref()),
                    count: *count,
                    start,
                    end,
                });
            }
            ImageRow::Item {
                id,
                title,
                depth,
                start,
                end,
                done,
                progress,
                color: c,
            } => {
                let (start, end) = span(start, end)?;
                bars.insert(id, (lines.len(), start, end));
                lines.push(Line::Item {
                    title,
                    depth: (*depth).min(8),
                    start,
                    end,
                    done: *done,
                    progress: progress.filter(|p| p.is_finite()),
                    color: color(c.as_deref()),
                });
            }
        }
    }

    // The days: every bar and the target date, some room, whole units of the scale.
    let mut first = i64::MAX;
    let mut last = i64::MIN;
    for line in &lines {
        let (Line::Group { start, end, .. } | Line::Item { start, end, .. }) = line;
        first = first.min(*start);
        last = last.max(*end);
    }
    if let Some(d) = deadline {
        first = first.min(d);
        last = last.max(d);
    }
    let zoom = image.zoom;
    let dw = day_width(zoom);
    let from = range_start(first, zoom, dw);
    let mut to = range_end(last, zoom, dw);
    if ((to - from + 1) as f64) * dw < MIN_TIMELINE {
        to = unit_end(from + (MIN_TIMELINE / dw).ceil() as i64 - 1, zoom);
    }
    let x = |day: i64| ((day - from) as f64) * dw;

    // Labels that do not fit in their bar go beside it: widen the timeline to hold them.
    let labels: Vec<Option<Label>> = lines
        .iter()
        .map(|line| match line {
            Line::Item {
                title,
                start,
                end,
                progress,
                ..
            } => Some(bar_label(title, *progress, x(*end + 1) - x(*start))),
            Line::Group { .. } => None,
        })
        .collect();
    let reach = lines
        .iter()
        .zip(&labels)
        .filter_map(|(line, label)| match (line, label) {
            (Line::Item { end, .. }, Some(Label::Beside(text))) => {
                Some(x(*end + 1) + 6.0 + text_width(text, LABEL_SIZE) + 8.0)
            }
            _ => None,
        })
        .fold(0.0_f64, f64::max);
    if reach > x(to + 1) {
        to = snap_end(from + (reach / dw).ceil() as i64 - 1, zoom, dw);
    }
    let days = to - from + 1;
    if days > MAX_IMAGE_DAYS {
        return Err(Error::invalid("a roadmap image spans at most twenty years"));
    }
    let timeline = (days as f64) * dw;

    // The name column: as wide as the longest name, within limits.
    let name_width = lines
        .iter()
        .map(|line| match line {
            Line::Group { label, count, .. } => {
                40.0 + text_width(label, NAME_SIZE)
                    + text_width(&count.to_string(), LABEL_SIZE)
                    + 16.0
            }
            Line::Item {
                title,
                depth,
                progress,
                ..
            } => {
                let dot = if progress.is_some() { 14.0 } else { 0.0 };
                28.0 + f64::from(*depth) * 14.0 + dot + text_width(title, NAME_SIZE) + 12.0
            }
        })
        .fold(text_width(&image.name_header, LABEL_SIZE) + 32.0, f64::max)
        .clamp(NAME_MIN, NAME_MAX)
        .ceil();

    let p = palette(image.theme);
    let title = image.title.trim();
    let subtitle = image.subtitle.trim();
    let head = if subtitle.is_empty() { 40.0 } else { 60.0 };
    let chart_width = name_width + timeline;
    let chart_height = SCALE + ROW * lines.len() as f64;
    let width = (PAD * 2.0 + chart_width).ceil();
    let height = (PAD * 2.0 + head + chart_height).ceil();
    let tx = |day: i64| name_width + x(day);

    let mut s = String::with_capacity(4096 + lines.len() * 600);
    let _ = write!(
        s,
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" font-family="{FONTS}" font-size="13">"#,
        w = n(width),
        h = n(height),
    );
    let mut description = format!("{} rows", lines.len());
    if let Some(d) = &image.deadline
        && !d.label.trim().is_empty()
    {
        let _ = write!(
            description,
            "; target date of {}: {}",
            d.label.trim(),
            d.date
        );
    }
    let _ = write!(
        s,
        "<title>{}</title><desc>{}</desc>",
        esc(title),
        esc(&description)
    );
    let _ = write!(
        s,
        r##"<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8Z" fill="{ink3}"/></marker><marker id="arrow-late" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8Z" fill="{danger}"/></marker><clipPath id="chart"><rect x="{nw}" y="0" width="{tw}" height="{ch}"/></clipPath></defs>"##,
        ink3 = p.ink3,
        danger = p.danger,
        nw = n(name_width),
        tw = n(timeline),
        ch = n(chart_height),
    );
    let _ = write!(
        s,
        r#"<rect width="{}" height="{}" fill="{}"/>"#,
        n(width),
        n(height),
        p.canvas
    );
    let _ = write!(
        s,
        r#"<text x="{PAD}" y="{}" font-size="20" font-weight="600" fill="{}">{}</text>"#,
        n(PAD + 18.0),
        p.ink,
        esc(&fit(title, 20.0, width - PAD * 2.0))
    );
    if !subtitle.is_empty() {
        let _ = write!(
            s,
            r#"<text x="{PAD}" y="{}" font-size="12" fill="{}">{}</text>"#,
            n(PAD + 40.0),
            p.ink3,
            esc(&fit(subtitle, 12.0, width - PAD * 2.0))
        );
    }

    let _ = write!(s, r#"<g transform="translate({PAD} {})">"#, n(PAD + head));
    let line = |s: &mut String, x1: f64, y1: f64, x2: f64, y2: f64, paint: Paint| {
        let _ = write!(
            s,
            r#"<path d="M{} {}L{} {}" stroke="{}" stroke-opacity="{}"/>"#,
            n(x1),
            n(y1),
            n(x2),
            n(y2),
            paint.0,
            paint.1
        );
    };
    // The panel.
    let _ = write!(
        s,
        r#"<rect x="0.5" y="0.5" width="{}" height="{}" rx="8" fill="{}" stroke="{}" stroke-opacity="{}"/>"#,
        n(chart_width - 1.0),
        n(chart_height - 1.0),
        p.raised,
        p.line_strong.0,
        p.line_strong.1
    );

    // Weekends, when days are wide enough to see them.
    if matches!(zoom, RoadmapZoom::Day | RoadmapZoom::Week) {
        let _ = write!(s, r#"<g fill="{}" fill-opacity="0.035">"#, p.ink);
        for day in (from..=to).filter(|d| is_weekend(*d)) {
            let _ = write!(
                s,
                r#"<rect x="{}" y="{SCALE}" width="{}" height="{}"/>"#,
                n(tx(day)),
                n(dw),
                n(chart_height - SCALE)
            );
        }
        s.push_str("</g>");
    }

    // The scale.
    let (top, bottom) = ticks(from, days, zoom);
    let half = SCALE / 2.0;
    for tick in &top {
        let left = tx(from + tick.offset);
        if tick.offset > 0 {
            line(&mut s, left, 0.0, left, half, p.line);
        }
        let room = (tick.length as f64) * dw - 10.0;
        if text_width(&tick.label, LABEL_SIZE) <= room {
            let _ = write!(
                s,
                r#"<text x="{}" y="{}" font-size="12" font-weight="500" fill="{}">{}</text>"#,
                n(left + 6.0),
                n(half - 7.0),
                p.ink2,
                esc(&tick.label)
            );
        }
    }
    for tick in &bottom {
        let left = tx(from + tick.offset);
        if tick.offset > 0 {
            line(&mut s, left, half, left, chart_height, p.line);
        }
        let room = (tick.length as f64) * dw - 6.0;
        if text_width(&tick.label, 11.0) <= room {
            let day = from + tick.offset;
            let quiet = zoom == RoadmapZoom::Day && is_weekend(day);
            let _ = write!(
                s,
                r#"<text x="{}" y="{}" font-size="11" fill="{}"{}>{}</text>"#,
                n(left + 4.0),
                n(SCALE - 7.0),
                p.ink3,
                if quiet { r#" fill-opacity="0.6""# } else { "" },
                esc(&tick.label)
            );
        }
    }
    line(&mut s, name_width, half, chart_width, half, p.line);
    line(&mut s, 0.0, SCALE, chart_width, SCALE, p.line_strong);
    line(
        &mut s,
        name_width,
        0.0,
        name_width,
        chart_height,
        p.line_strong,
    );
    let _ = write!(
        s,
        r#"<text x="16" y="{}" font-size="12" font-weight="500" fill="{}">{}</text>"#,
        n(SCALE - 9.0),
        p.ink3,
        esc(&fit(&image.name_header, LABEL_SIZE, name_width - 24.0))
    );

    // Rows.
    let late_into: HashSet<usize> = image
        .links
        .iter()
        .filter_map(|link| {
            let (_, _, from_end) = bars.get(link.from.as_str())?;
            let (row, to_start, _) = bars.get(link.to.as_str())?;
            (to_start <= from_end).then_some(*row)
        })
        .collect();
    let mut clip = 0;
    for (i, (row, label)) in lines.iter().zip(&labels).enumerate() {
        let top = SCALE + ROW * i as f64;
        let mid = top + ROW / 2.0;
        let text_y = mid + 4.5;
        if i + 1 < lines.len() {
            line(&mut s, 0.0, top + ROW, chart_width, top + ROW, p.line);
        }
        match row {
            Line::Group {
                label,
                color: c,
                count,
                start,
                end,
            } => {
                let dot = c.unwrap_or(p.ink3);
                let _ = write!(
                    s,
                    r#"<rect x="1" y="{}" width="{}" height="{ROW}" fill="{}" fill-opacity="0.035"/>"#,
                    n(top),
                    n(chart_width - 2.0),
                    p.ink
                );
                let count = count.to_string();
                let count_width = text_width(&count, LABEL_SIZE);
                let _ = write!(
                    s,
                    r#"<circle cx="20" cy="{}" r="4" fill="{dot}"/><text x="32" y="{}" font-weight="600" fill="{}">{}</text><text x="{}" y="{}" font-size="12" text-anchor="end" fill="{}">{count}</text>"#,
                    n(mid),
                    n(text_y),
                    p.ink,
                    esc(&fit(label, NAME_SIZE, name_width - 56.0 - count_width)),
                    n(name_width - 12.0),
                    n(text_y),
                    p.ink3,
                );
                let opacity = if c.is_some() { 0.5 } else { 0.4 };
                let _ = write!(
                    s,
                    r#"<rect x="{}" y="{}" width="{}" height="6" rx="3" fill="{dot}" fill-opacity="{opacity}"/>"#,
                    n(tx(*start)),
                    n(mid - 3.0),
                    n(x(*end + 1) - x(*start)),
                );
            }
            Line::Item {
                title,
                depth,
                start,
                end,
                done,
                progress,
                color: c,
            } => {
                let indent = 20.0 + f64::from(*depth) * 14.0;
                let mut name_x = indent;
                if progress.is_some() {
                    let _ = write!(
                        s,
                        r#"<circle cx="{}" cy="{}" r="4" fill="{}"/>"#,
                        n(indent + 4.0),
                        n(mid),
                        c.unwrap_or(p.ink3)
                    );
                    name_x += 14.0;
                }
                let name_ink = if *done {
                    p.ink3
                } else if *depth > 0 {
                    p.ink2
                } else {
                    p.ink
                };
                let _ = write!(
                    s,
                    r#"<text x="{}" y="{}" fill="{name_ink}"{}>{}</text>"#,
                    n(name_x),
                    n(text_y),
                    if *done {
                        r#" text-decoration="line-through""#
                    } else {
                        ""
                    },
                    esc(&fit(title, NAME_SIZE, name_width - name_x - 10.0))
                );

                // The bar, flagged as on the page: overdue, past the target date, late.
                let left = tx(*start);
                let bar_width = (x(*end + 1) - x(*start)).max(dw);
                let overdue = !done && *end < today;
                let past = !done && deadline.is_some_and(|d| *end > d);
                let late = late_into.contains(&i);
                let (fill, fill_opacity, stroke, stroke_opacity, ink) = if *done {
                    (
                        p.done,
                        0.25,
                        p.line_strong.0,
                        p.line_strong.1.max(0.3),
                        p.ink3,
                    )
                } else if overdue || past {
                    (c.unwrap_or(p.accent), 0.18, p.danger, 0.7, p.ink)
                } else {
                    // An epic's own color fills its whole bar, so its progress reads as one.
                    (
                        c.unwrap_or(p.accent),
                        0.18,
                        c.unwrap_or(p.accent),
                        0.6,
                        p.ink,
                    )
                };
                let (y, h) = (top + 6.0, ROW - 12.0);
                if late {
                    let _ = write!(
                        s,
                        r#"<rect x="{}" y="{}" width="{}" height="{}" rx="7" fill="none" stroke="{}" stroke-opacity="0.6" stroke-width="2"/>"#,
                        n(left - 2.0),
                        n(y - 2.0),
                        n(bar_width + 4.0),
                        n(h + 4.0),
                        p.danger
                    );
                }
                let _ = write!(
                    s,
                    r#"<rect x="{}" y="{}" width="{}" height="{}" rx="5" fill="{fill}" fill-opacity="{fill_opacity}"/>"#,
                    n(left + 0.5),
                    n(y + 0.5),
                    n(bar_width - 1.0),
                    n(h - 1.0),
                );
                if let Some(share) = progress.filter(|p| *p > 0.0) {
                    clip += 1;
                    let _ = write!(
                        s,
                        r#"<clipPath id="bar{clip}"><rect x="{}" y="{}" width="{}" height="{}" rx="5"/></clipPath><rect clip-path="url(#bar{clip})" x="{}" y="{}" width="{}" height="{}" fill="{}" fill-opacity="0.35"/>"#,
                        n(left + 0.5),
                        n(y + 0.5),
                        n(bar_width - 1.0),
                        n(h - 1.0),
                        n(left),
                        n(y),
                        n(bar_width * share.min(1.0)),
                        n(h),
                        c.unwrap_or(p.accent),
                    );
                }
                let _ = write!(
                    s,
                    r#"<rect x="{}" y="{}" width="{}" height="{}" rx="5" fill="none" stroke="{stroke}" stroke-opacity="{stroke_opacity}"/>"#,
                    n(left + 0.5),
                    n(y + 0.5),
                    n(bar_width - 1.0),
                    n(h - 1.0),
                );
                match label {
                    Some(Label::Inside(text)) => {
                        let _ = write!(
                            s,
                            r#"<text x="{}" y="{}" font-size="12" fill="{ink}">{}</text>"#,
                            n(left + 8.0),
                            n(mid + 4.0),
                            esc(text)
                        );
                    }
                    Some(Label::Beside(text)) => {
                        let _ = write!(
                            s,
                            r#"<text x="{}" y="{}" font-size="12" fill="{}">{}</text>"#,
                            n(left + bar_width + 6.0),
                            n(mid + 4.0),
                            p.ink2,
                            esc(text)
                        );
                    }
                    None => {}
                }
            }
        }
    }

    // Arrows from what is waited on to what waits, as on the page.
    let _ = write!(
        s,
        r#"<g fill="none" stroke-width="1.5" clip-path="url(#chart)">"#
    );
    for link in &image.links {
        let (Some(&(a, _, from_end)), Some(&(b, to_start, _))) =
            (bars.get(link.from.as_str()), bars.get(link.to.as_str()))
        else {
            continue;
        };
        let late = to_start <= from_end;
        let x2 = tx(to_start);
        // From the bar's end, or past its label when the label is beside it and the arrow
        // would otherwise run through it.
        let mut x1 = tx(from_end + 1);
        if let Some(Some(Label::Beside(text))) = labels.get(a) {
            let past = x1 + 6.0 + text_width(text, LABEL_SIZE) + 4.0;
            if x2 > past + 8.0 {
                x1 = past;
            }
        }
        let y1 = SCALE + ROW * a as f64 + ROW / 2.0;
        let y2 = SCALE + ROW * b as f64 + ROW / 2.0;
        let bend = (x2 - x1).abs().max(32.0) / 2.0;
        let _ = write!(
            s,
            r#"<path d="M{} {}C{} {} {} {} {} {}" stroke="{}" stroke-opacity="{}"{} marker-end="url(#{})"/>"#,
            n(x1),
            n(y1),
            n(x1 + bend),
            n(y1),
            n(x2 - bend),
            n(y2),
            n(x2 - 2.0),
            n(y2),
            if late { p.danger } else { p.ink3 },
            if late { 1.0 } else { 0.7 },
            if late {
                r#" stroke-dasharray="4 3""#
            } else {
                ""
            },
            if late { "arrow-late" } else { "arrow" },
        );
    }
    s.push_str("</g>");

    // Today and the target date, with a tag each on the scale.
    let mut tags: Vec<(f64, String, &str)> = Vec::new();
    if (from..=to).contains(&today) {
        let at = tx(today) + dw / 2.0;
        let _ = write!(
            s,
            r#"<path d="M{a} {half}L{a} {}" stroke="{}" stroke-opacity="0.7" stroke-width="2"/>"#,
            n(chart_height),
            p.accent,
            a = n(at),
        );
        tags.push((at, "Today".to_string(), p.accent));
    }
    if let Some(d) = deadline.filter(|d| (from..=to).contains(d)) {
        let at = tx(d + 1);
        let _ = write!(
            s,
            r#"<path d="M{a} {half}L{a} {}" stroke="{}" stroke-opacity="0.7" stroke-width="2" stroke-dasharray="6 4"/>"#,
            n(chart_height),
            p.rubric,
            a = n(at),
        );
        tags.push((at, format!("Target · {}", short_date(d, today)), p.rubric));
    }
    // Two tags that would overlap: the second goes to the scale's upper row.
    let mut placed: Vec<(f64, f64)> = Vec::new();
    for (at, text, fill) in &tags {
        let w = text_width(text, 11.0) + 12.0;
        let left = (at - w / 2.0)
            .min(chart_width - w - 2.0)
            .max(name_width + 2.0);
        let clash = placed
            .iter()
            .any(|(l, r)| left < *r + 4.0 && left + w + 4.0 > *l);
        let y = if clash { 3.0 } else { half + 2.0 };
        placed.push((left, left + w));
        let _ = write!(
            s,
            r#"<rect x="{}" y="{}" width="{}" height="18" rx="9" fill="{fill}"/><text x="{}" y="{}" font-size="11" font-weight="600" text-anchor="middle" fill="{}">{}</text>"#,
            n(left),
            n(y),
            n(w),
            n(left + w / 2.0),
            n(y + 12.5),
            p.raised,
            esc(text),
        );
    }

    s.push_str("</g></svg>");
    Ok(RenderedImage {
        svg: s,
        width: width as u32,
        height: height as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, title: &str, start: &str, end: &str) -> ImageRow {
        ImageRow::Item {
            id: id.into(),
            title: title.into(),
            depth: 0,
            start: start.into(),
            end: end.into(),
            done: false,
            progress: None,
            color: None,
        }
    }

    fn image(rows: Vec<ImageRow>) -> RoadmapImage {
        RoadmapImage {
            title: "Roadmap".into(),
            subtitle: String::new(),
            name_header: "Task".into(),
            zoom: RoadmapZoom::Week,
            today: "2026-11-21".into(),
            deadline: None,
            rows,
            links: vec![],
            theme: ImageTheme::Clean,
        }
    }

    #[test]
    fn units_snap_to_weeks_months_and_quarters() {
        let day = to_days("2026-11-21").unwrap(); // a Saturday
        let iso = |d| to_iso(d);
        assert_eq!(iso(unit_start(day, RoadmapZoom::Week)), "2026-11-16");
        assert_eq!(iso(unit_end(day, RoadmapZoom::Week)), "2026-11-22");
        assert_eq!(iso(unit_start(day, RoadmapZoom::Month)), "2026-11-01");
        assert_eq!(iso(unit_end(day, RoadmapZoom::Month)), "2026-11-30");
        assert_eq!(iso(unit_start(day, RoadmapZoom::Quarter)), "2026-10-01");
        assert_eq!(iso(unit_end(day, RoadmapZoom::Quarter)), "2026-12-31");
        let feb = to_days("2028-02-10").unwrap();
        assert_eq!(iso(unit_end(feb, RoadmapZoom::Month)), "2028-02-29");
    }

    #[test]
    fn ticks_label_months_and_weeks() {
        let from = to_days("2026-11-30").unwrap(); // a Monday
        let (top, bottom) = ticks(from, 14, RoadmapZoom::Week);
        assert_eq!(
            top,
            vec![
                Tick {
                    label: "Nov 2026".into(),
                    offset: 0,
                    length: 1
                },
                Tick {
                    label: "Dec 2026".into(),
                    offset: 1,
                    length: 13
                },
            ]
        );
        assert_eq!(bottom.len(), 2);
        assert_eq!(bottom[0].label, "30");
        assert_eq!(bottom[1].label, "7");
        let (_, quarters) = ticks(to_days("2026-01-01").unwrap(), 365, RoadmapZoom::Quarter);
        let labels: Vec<_> = quarters.iter().map(|t| t.label.as_str()).collect();
        assert_eq!(labels, ["Q1", "Q2", "Q3", "Q4"]);
    }

    #[test]
    fn text_is_escaped_and_cut() {
        assert_eq!(esc("a<b>&\"c'\u{7}"), "a&lt;b&gt;&amp;&quot;c&#39;");
        let long = "A very long epic name that keeps going and going";
        let cut = fit(long, 13.0, 120.0);
        assert!(cut.ends_with('…'));
        assert!(text_width(&cut, 13.0) <= 120.0);
        assert_eq!(fit("Short", 13.0, 120.0), "Short");
    }

    #[test]
    fn colors_other_than_hex_are_dropped() {
        assert_eq!(color(Some("#a1B2c3")), Some("#a1B2c3"));
        assert_eq!(color(Some("#abc")), Some("#abc"));
        assert_eq!(color(Some("red")), None);
        assert_eq!(color(Some("#abc\"/><script>")), None);
        assert_eq!(color(None), None);
    }

    #[test]
    fn the_range_covers_the_bars_not_today() {
        let out = render(&image(vec![item("a", "Plan", "2027-03-01", "2027-03-05")])).unwrap();
        // Bars in March 2027 only: no today line from November 2026.
        assert!(!out.svg.contains(">Today<"));
        assert!(out.svg.contains(">Mar 2027<"));
        assert!(!out.svg.contains("Nov 2026"));
        // The narrowest timeline still holds a few weeks.
        assert!(f64::from(out.width) >= PAD * 2.0 + NAME_MIN + MIN_TIMELINE);
    }

    #[test]
    fn today_and_the_target_date_are_drawn_when_inside() {
        let mut img = image(vec![
            item("a", "Plan", "2026-11-16", "2026-11-27"),
            item("b", "Build", "2026-11-30", "2026-12-18"),
        ]);
        img.deadline = Some(ImageDeadline {
            date: "2026-12-11".into(),
            label: "Launch".into(),
        });
        let out = render(&img).unwrap();
        assert!(out.svg.contains(">Today<"));
        assert!(out.svg.contains(">Target · Dec 11<"));
        assert!(out.svg.contains("target date of Launch: 2026-12-11"));
        // "Build" ends after the target date: drawn in the danger color.
        assert!(
            out.svg
                .contains(r##"stroke="#d44c47" stroke-opacity="0.7""##)
        );
    }

    #[test]
    fn late_links_are_dashed_and_ringed() {
        let mut img = image(vec![
            item("a", "Plan", "2026-11-16", "2026-11-27"),
            item("b", "Build", "2026-11-25", "2026-12-04"),
            item("c", "Ship", "2026-12-07", "2026-12-11"),
        ]);
        img.links = vec![
            ImageLink {
                from: "a".into(),
                to: "b".into(),
            },
            ImageLink {
                from: "b".into(),
                to: "c".into(),
            },
            ImageLink {
                from: "a".into(),
                to: "gone".into(),
            },
        ];
        let svg = render(&img).unwrap().svg;
        assert_eq!(svg.matches("marker-end=").count(), 2);
        assert_eq!(svg.matches("url(#arrow-late)").count(), 1);
        assert_eq!(svg.matches(r#"stroke-dasharray="4 3""#).count(), 1);
        assert_eq!(svg.matches(r#"rx="7""#).count(), 1, "one ring");
    }

    #[test]
    fn names_never_reach_the_svg_unescaped() {
        let mut img = image(vec![
            ImageRow::Group {
                label: "R&D <team>".into(),
                color: Some("javascript:alert(1)".into()),
                count: 1,
                start: "2026-11-16".into(),
                end: "2026-11-20".into(),
            },
            item(
                "a",
                "</text><script>alert(1)</script>",
                "2026-11-16",
                "2026-11-20",
            ),
        ]);
        img.title = "Q4 & beyond".into();
        let svg = render(&img).unwrap().svg;
        assert!(!svg.contains("<script"));
        assert!(!svg.contains("javascript:"));
        assert!(svg.contains("R&amp;D &lt;team&gt;"));
        assert!(svg.contains("<title>Q4 &amp; beyond</title>"));
    }

    #[test]
    fn short_bars_put_their_label_beside_them_and_widen_the_image() {
        let narrow = render(&image(vec![item("a", "x", "2026-11-16", "2026-11-16")])).unwrap();
        let long_title = "A task with a title far too long for a one-day bar";
        let wide = render(&image(vec![item(
            "a",
            long_title,
            "2026-11-16",
            "2026-11-16",
        )]))
        .unwrap();
        assert!(wide.width > narrow.width);
        assert!(wide.svg.contains(&format!(">{long_title}<")));
    }

    #[test]
    fn bad_input_is_refused() {
        assert!(render(&image(vec![])).is_err());
        assert!(render(&image(vec![item("a", "x", "2026-13-01", "2026-12-01")])).is_err());
        let mut img = image(vec![item("a", "x", "2026-11-16", "2026-11-20")]);
        img.today = "today".into();
        assert!(render(&img).is_err());
        let far = image(vec![
            item("a", "x", "2000-01-01", "2000-01-02"),
            item("b", "y", "2030-01-01", "2030-01-02"),
        ]);
        assert!(render(&far).is_err());
        // A reversed bar is put in order rather than refused.
        assert!(render(&image(vec![item("a", "x", "2026-11-20", "2026-11-16")])).is_ok());
    }

    #[test]
    fn a_roadmap_of_epics_renders() {
        let img = RoadmapImage {
            title: "Roadmap".into(),
            subtitle: "Epics across projects · Nov 21, 2026".into(),
            name_header: "Epic".into(),
            zoom: RoadmapZoom::Month,
            today: "2026-11-21".into(),
            deadline: None,
            rows: vec![
                ImageRow::Group {
                    label: "Task Master".into(),
                    color: Some("#2383e2".into()),
                    count: 2,
                    start: "2026-10-01".into(),
                    end: "2027-02-26".into(),
                },
                ImageRow::Item {
                    id: "e1".into(),
                    title: "UI".into(),
                    depth: 0,
                    start: "2026-10-01".into(),
                    end: "2026-12-18".into(),
                    done: false,
                    progress: Some(0.4),
                    color: Some("#e0a030".into()),
                },
                ImageRow::Item {
                    id: "e2".into(),
                    title: "Team spaces".into(),
                    depth: 0,
                    start: "2027-01-04".into(),
                    end: "2027-02-26".into(),
                    done: false,
                    progress: Some(0.0),
                    color: None,
                },
            ],
            links: vec![ImageLink {
                from: "e1".into(),
                to: "e2".into(),
            }],
            theme: ImageTheme::Dark,
        };
        let out = render(&img).unwrap();
        // One element a line, so a change reads as a diff.
        insta::assert_snapshot!(out.svg.replace("><", ">\n<"));
    }
}
