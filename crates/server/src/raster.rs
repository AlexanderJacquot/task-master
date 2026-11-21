//! SVG to PNG for roadmap images (ADR 035): `resvg` with the bundled Inter (`fonts/`, SIL
//! Open Font License, `fonts/OFL.txt`). The server image has no system fonts and none are
//! loaded, so a PNG looks the same on every host; text Inter has no glyph for is left out.

use std::sync::{Arc, OnceLock};

use resvg::{tiny_skia, usvg};

/// The longest side and the most pixels a PNG may have: 64 MB of pixels at most, since
/// the server may be a small machine. A bigger image is drawn smaller rather than refused.
pub const MAX_SIDE: u32 = 8_192;
pub const MAX_PIXELS: f64 = 16_000_000.0;
/// The scale a request may ask for, and the default (sharp on high-density screens).
pub const MAX_SCALE: f32 = 3.0;
pub const DEFAULT_SCALE: f32 = 2.0;

fn fonts() -> Arc<usvg::fontdb::Database> {
    static FONTS: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();
    FONTS
        .get_or_init(|| {
            let mut db = usvg::fontdb::Database::new();
            for data in [
                &include_bytes!("../fonts/Inter-Regular.ttf")[..],
                &include_bytes!("../fonts/Inter-Medium.ttf")[..],
                &include_bytes!("../fonts/Inter-SemiBold.ttf")[..],
            ] {
                db.load_font_data(data.to_vec());
            }
            // Whatever family the SVG names last (`sans-serif`) is Inter too.
            db.set_sans_serif_family("Inter");
            Arc::new(db)
        })
        .clone()
}

/// The scale an image of `width` × `height` is drawn at: the one asked for, less when the
/// PNG would pass [`MAX_SIDE`] or [`MAX_PIXELS`].
pub fn fit_scale(width: u32, height: u32, wanted: f32) -> f32 {
    let (w, h) = (f64::from(width.max(1)), f64::from(height.max(1)));
    let side = f64::from(MAX_SIDE);
    let most = (side / w).min(side / h).min((MAX_PIXELS / (w * h)).sqrt());
    // Narrowing is fine: the scale is at most 3 and at least a tiny positive number.
    #[allow(clippy::cast_possible_truncation)]
    let most = most as f32;
    wanted.min(most)
}

/// The PNG of `svg` (`width` × `height` pixels as drawn) at `scale` (see [`fit_scale`]).
pub fn png(svg: &str, width: u32, height: u32, scale: f32) -> Result<Vec<u8>, String> {
    let scale = fit_scale(width, height, scale);
    let options = usvg::Options {
        fontdb: fonts(),
        font_family: "Inter".into(),
        ..usvg::Options::default()
    };
    let tree = usvg::Tree::from_str(svg, &options).map_err(|e| e.to_string())?;
    let size = tree.size();
    // Rounded and at least one pixel; the caps keep them far inside u32.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let pixels = |v: f32| ((v * scale).round() as u32).max(1);
    let mut pixmap = tiny_skia::Pixmap::new(pixels(size.width()), pixels(size.height()))
        .ok_or("the image is too large to draw")?;
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    pixmap.encode_png().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Width and height from a PNG's header.
    fn png_size(png: &[u8]) -> (u32, u32) {
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let at = |i: usize| u32::from_be_bytes(png[i..i + 4].try_into().unwrap());
        (at(16), at(20))
    }

    #[test]
    fn scales_are_capped_by_side_and_area() {
        assert!((fit_scale(1000, 500, 2.0) - 2.0).abs() < f32::EPSILON);
        assert!((fit_scale(6000, 100, 2.0) - 8192.0 / 6000.0).abs() < 1e-6);
        let s = fit_scale(4000, 4000, 3.0);
        assert!((4000.0 * s).powi(2) <= 16_000_001.0, "{s}");
    }

    #[test]
    fn text_is_drawn_with_the_bundled_font() {
        let text = r#"<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text x="4" y="28" font-family="Inter, sans-serif" font-size="24" font-weight="600">Ship</text></svg>"#;
        let png = png(text, 120, 40, 1.0).unwrap();
        assert_eq!(png_size(&png), (120, 40));
        // Something was drawn: the PNG of the text is bigger than the same empty canvas.
        let empty = r#"<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"/>"#;
        let blank = super::png(empty, 120, 40, 1.0).unwrap();
        assert!(
            png.len() > blank.len() + 100,
            "{} vs {}",
            png.len(),
            blank.len()
        );
        // And no font database but ours: a family we do not ship falls back to Inter.
        assert_eq!(fonts().len(), 3);
    }

    #[test]
    fn a_roadmap_draws_at_twice_its_size() {
        let image = taskmaster_core::RoadmapImage {
            title: "Roadmap".into(),
            subtitle: "Epics across projects · 1 epic · Nov 21, 2026".into(),
            name_header: "Epic".into(),
            zoom: taskmaster_core::RoadmapZoom::Week,
            today: "2026-11-21".into(),
            deadline: None,
            rows: vec![taskmaster_core::ImageRow::Item {
                id: "e".into(),
                title: "Launch".into(),
                depth: 0,
                start: "2026-11-23".into(),
                end: "2026-12-04".into(),
                done: false,
                progress: Some(0.5),
                color: Some("#cc3333".into()),
            }],
            links: vec![],
            theme: taskmaster_core::ImageTheme::Dark,
        };
        let svg = taskmaster_core::render_roadmap(&image).unwrap();
        let png = png(&svg.svg, svg.width, svg.height, DEFAULT_SCALE).unwrap();
        assert_eq!(png_size(&png), (svg.width * 2, svg.height * 2));
    }
}
