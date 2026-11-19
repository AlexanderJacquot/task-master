fn main() {
    // Windows: Tauri and the dialog plugin call `TaskDialogIndirect`, which only the
    // Common Controls 6 DLL has, and an executable gets that DLL only when its manifest
    // asks for it. tauri-build puts its manifest in a resource linked into the app alone,
    // so the test executables started without it (STATUS_ENTRYPOINT_NOT_FOUND). The
    // linker embeds the same dependency into every executable instead.
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|e| e == "msvc");
    let attributes = if msvc {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' \
             name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
             processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    } else {
        tauri_build::Attributes::new()
    };
    tauri_build::try_build(attributes).expect("tauri build");
}
