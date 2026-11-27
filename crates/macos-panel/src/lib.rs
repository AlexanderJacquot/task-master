//! macOS: the quick-capture window as a non-activating panel (ADR 027).
//!
//! An ordinary window cannot appear over another app's full-screen Space: showing it
//! activates task-master, and macOS then switches to the Space holding the main window.
//! Spotlight-style launchers use an `NSPanel` with the non-activating style instead. It
//! takes the keyboard without activating its app, so the full-screen app keeps its Space.
//! With `CanJoinAllSpaces | FullScreenAuxiliary` the panel is allowed on every Space,
//! full-screen ones included. Tauri has no panel window, so the window's `NSWindow`
//! (tao's `TaoWindow`) has its class swapped for an `NSPanel` subclass of the same size.
//!
//! The workspace forbids unsafe code; this crate is the exception, so that the shell stays
//! free of it. Its API is safe: the window comes from Tauri, and the main thread is checked.
#![cfg(target_os = "macos")]

use std::sync::atomic::AtomicBool;

use objc2::runtime::{AnyObject, NSObject};
use objc2::{ClassType, MainThreadMarker, MainThreadOnly, define_class};
use objc2_app_kit::{
    NSPanel, NSResponder, NSStatusWindowLevel, NSWindow, NSWindowCollectionBehavior,
    NSWindowStyleMask,
};

/// Mirrors tao's `WindowState` (one `AtomicBool`), so that this class has exactly the
/// instance size of `TaoWindow`: swapping an object's class needs equal sizes. Never read
/// here; tao keeps using its own copy at the same offset.
struct MirrorOfTaoState {
    _focusable: AtomicBool,
}

define_class!(
    // SAFETY: `NSPanel` may be subclassed; the ivars need no drop, and the two overrides
    // have the signatures AppKit declares.
    #[unsafe(super(NSPanel, NSWindow, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "TaskMasterCapturePanel"]
    #[ivars = MirrorOfTaoState]
    struct CapturePanel;

    impl CapturePanel {
        // The window has no title bar, and a borderless window refuses to become key by
        // default (tao's own class says yes; the swap drops that override).
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> bool {
            true
        }

        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main_window(&self) -> bool {
            false
        }
    }
);

/// Turns `window` into a panel that shows over full-screen apps and on every Space without
/// activating the app. Call once, on the main thread (Tauri's `setup`), before the window
/// is first shown. Show it with `show()` alone afterwards: `set_focus()` activates the app.
pub fn make_panel<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    MainThreadMarker::new().ok_or("not on the main thread")?;
    let ptr = window.ns_window().map_err(|e| e.to_string())?;
    if ptr.is_null() {
        return Err("the window has no NSWindow".into());
    }
    // SAFETY: Tauri returns the window's live `NSWindow`, which the window keeps alive
    // for as long as `window` is borrowed; we are on the main thread (checked above).
    let ns_window: &NSWindow = unsafe { &*ptr.cast::<NSWindow>() };
    let object: &AnyObject = ns_window.as_ref();
    let panel_class = CapturePanel::class();
    // Swapping the class of an object needs both classes to have the same instance size.
    // A tao update that changes its window's ivars ends up here: capture then stays an
    // ordinary window rather than risk memory errors.
    let current = object.class();
    if panel_class.instance_size() != current.instance_size() {
        return Err(format!(
            "{} has {} bytes, {} has {}",
            panel_class.name().to_string_lossy(),
            panel_class.instance_size(),
            current.name().to_string_lossy(),
            current.instance_size()
        ));
    }
    // SAFETY: `CapturePanel` descends from `NSWindow` like the current class and has the
    // same instance size (checked above). Its ivars are never initialised or read, need no
    // drop, and overlap tao's own, which tao keeps reading at their fixed offset.
    unsafe { AnyObject::set_class(object, panel_class) };
    // SAFETY: the object is now an instance of an `NSPanel` subclass.
    let panel: &NSPanel = unsafe { &*ptr.cast::<NSPanel>() };
    panel.setStyleMask(panel.styleMask() | NSWindowStyleMask::NonactivatingPanel);
    // Panels hide when their app deactivates by default; this one shows over other apps.
    panel.setHidesOnDeactivate(false);
    // Above the menu bar of a full-screen app, like Spotlight.
    panel.setLevel(NSStatusWindowLevel);
    panel.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary,
    );
    Ok(())
}
