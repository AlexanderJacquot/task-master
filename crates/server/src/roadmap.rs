//! `GET /roadmap.svg` and `GET /roadmap.png` (ADR 035): a roadmap drawn from the server's
//! replica, for integrations (a status page, a wiki, a chat bot). The core builds the
//! roadmap a saved view or the query shows (`roadmap_image`) and draws it
//! (`render_roadmap`), the same code as the desktop's "Export image" (ADR 034); the PNG is
//! that SVG rasterized here (`raster`).

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use taskmaster_core::{
    FILTER_NONE, ImageTheme, LineageCompletion, RoadmapGroup, RoadmapOptions, RoadmapZoom,
    default_roadmap_spec, now_ms, render_roadmap, roadmap_image, utc_date,
};

use crate::auth::Scope;
use crate::raster;
use crate::{ApiError, ApiResult, AppState, authorize_any, blocking};

/// The query: a saved roadmap view, or the plain roadmap's filters. `zoom`, `theme` and
/// `today` go with either.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoadmapQuery {
    /// A saved roadmap view's id: its filters, timescale, starts and folds.
    view: Option<String>,
    /// An epic's task timeline instead of the roadmap of epics.
    epic: Option<String>,
    /// Comma-separated project ids (`none`: epics without a home project). Epics only.
    projects: Option<String>,
    /// Comma-separated tag ids (`none`: tasks without tags). An epic's tasks only.
    tags: Option<String>,
    /// `open` (default), `all`, or for tasks `ready`.
    completion: Option<String>,
    /// `project` (default) or `none`. Epics only.
    group: Option<String>,
    /// `false` leaves subtasks out. An epic's tasks only.
    subtasks: Option<bool>,
    /// `day`, `week`, `month` or `quarter`.
    zoom: Option<String>,
    /// `clean` (default), `light` or `dark`.
    theme: Option<String>,
    /// The day the today line is on (`YYYY-MM-DD`); the server's UTC date by default.
    today: Option<String>,
    /// PNG only: pixels per SVG pixel, 1 to 3 (2 by default), less for a huge image.
    scale: Option<f32>,
}

fn bad(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, message)
}

/// A snake_case enum value from the query, by its serde name.
fn word<T: DeserializeOwned>(field: &str, value: &str, allowed: &str) -> ApiResult<T> {
    serde_json::from_value(serde_json::Value::String(value.to_owned()))
        .map_err(|_| bad(format!("{field} must be one of {allowed}")))
}

fn ids(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(|id| {
            if id.eq_ignore_ascii_case(FILTER_NONE) {
                FILTER_NONE.to_owned()
            } else {
                id.to_owned()
            }
        })
        .collect()
}

/// The roadmap the query asks for, ready to draw.
fn build(state: &AppState, q: RoadmapQuery) -> ApiResult<taskmaster_core::RoadmapImage> {
    let zoom: Option<RoadmapZoom> = q
        .zoom
        .as_deref()
        .map(|z| word("zoom", z, "day, week, month, quarter"))
        .transpose()?;
    let theme: ImageTheme = q
        .theme
        .as_deref()
        .map(|t| word("theme", t, "clean, light, dark"))
        .transpose()?
        .unwrap_or_default();
    let today = q.today.unwrap_or_else(|| utc_date(now_ms()));

    let snapshot = state.store().snapshot()?;
    let (mut spec, view_name) = match &q.view {
        Some(id) => {
            if q.epic.is_some()
                || q.projects.is_some()
                || q.tags.is_some()
                || q.completion.is_some()
                || q.group.is_some()
                || q.subtasks.is_some()
            {
                return Err(bad(
                    "a saved view brings its own filters: only zoom, theme and today go with view",
                ));
            }
            let view = snapshot
                .views
                .iter()
                .find(|v| v.id == *id)
                .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("no view {id}")))?;
            if view.spec.roadmap.is_none() {
                return Err(bad(format!("view {id} is not a roadmap")));
            }
            (view.spec.clone(), Some(view.name.clone()))
        }
        None => {
            let mut spec = default_roadmap_spec(q.epic.clone());
            let roadmap = spec.roadmap.as_deref_mut().expect("a roadmap spec");
            if let Some(c) = q.completion.as_deref() {
                roadmap.completion =
                    word::<LineageCompletion>("completion", c, "open, all, ready")?;
            }
            if let Some(g) = q.group.as_deref() {
                roadmap.group = word::<RoadmapGroup>("group", g, "project, none")?;
            }
            match &q.epic {
                None => {
                    if q.tags.is_some() || q.subtasks.is_some() {
                        return Err(bad("tags and subtasks go with epic"));
                    }
                    spec.filter.project_ids = q.projects.as_deref().map(ids).unwrap_or_default();
                }
                Some(_) => {
                    if q.projects.is_some() || q.group.is_some() {
                        return Err(bad("projects and group go with the roadmap of epics"));
                    }
                    spec.filter.tag_ids = q.tags.as_deref().map(ids).unwrap_or_default();
                    spec.show_subtasks = q.subtasks.unwrap_or(true);
                }
            }
            (spec, None)
        }
    };
    if let (Some(zoom), Some(roadmap)) = (zoom, spec.roadmap.as_deref_mut()) {
        roadmap.zoom = zoom;
    }
    let options = RoadmapOptions {
        view_name,
        today,
        theme,
    };
    let data = taskmaster_core::RoadmapData::of(&snapshot);
    Ok(roadmap_image(data, &spec, &options)?)
}

type QueryResult = Result<Query<RoadmapQuery>, axum::extract::rejection::QueryRejection>;

/// The data is private: no shared caches, and nothing kept once shown.
const NO_STORE: &str = "private, no-store";

/// `GET /roadmap.svg`: needs an `api:read` (or `api:write`) or a `sync` token.
pub async fn svg(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    query: QueryResult,
) -> ApiResult<Response> {
    authorize_any(&state, &headers, &[Scope::ApiRead, Scope::Sync])?;
    let Query(q) = query.map_err(|e| bad(e.body_text()))?;
    if q.scale.is_some() {
        return Err(bad("scale goes with roadmap.png"));
    }
    let rendered = blocking(move || {
        let image = build(&state, q)?;
        Ok(render_roadmap(&image)?)
    })
    .await?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/svg+xml; charset=utf-8"),
            (header::CACHE_CONTROL, NO_STORE),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            // Opened on its own, the image runs nothing and loads nothing.
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; style-src 'unsafe-inline'",
            ),
        ],
        rendered.svg,
    )
        .into_response())
}

/// Rasterizing takes memory (up to 64 MB of pixels each): two at a time, the rest wait.
static RASTERIZING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// `GET /roadmap.png`: the SVG drawn with the bundled Inter, at `scale` (2 by default).
pub async fn png(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    query: QueryResult,
) -> ApiResult<Response> {
    authorize_any(&state, &headers, &[Scope::ApiRead, Scope::Sync])?;
    let Query(q) = query.map_err(|e| bad(e.body_text()))?;
    let scale = q.scale.unwrap_or(raster::DEFAULT_SCALE);
    if !(1.0..=raster::MAX_SCALE).contains(&scale) {
        return Err(bad("scale must be from 1 to 3"));
    }
    let _permit = RASTERIZING
        .acquire()
        .await
        .map_err(|e| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, e.to_string()))?;
    let bytes = blocking(move || {
        let rendered = render_roadmap(&build(&state, q)?)?;
        raster::png(&rendered.svg, rendered.width, rendered.height, scale)
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))
    })
    .await?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, NO_STORE),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response())
}
