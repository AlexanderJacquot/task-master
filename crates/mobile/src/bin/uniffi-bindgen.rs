//! Generates the Swift bindings from the built library (`scripts/ios/generate-bindings.sh`).

fn main() {
    uniffi::uniffi_bindgen_main();
}
