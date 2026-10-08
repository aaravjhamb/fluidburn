import { invoke } from "@tauri-apps/api/core";

/**
 * Show the native window. tauri.conf.json creates it hidden so the user never
 * sees the blank white webview while the page boots; the app calls this once
 * the first real screen has been painted. It goes through a one-line Rust
 * command rather than `@tauri-apps/api/window`, whose Window class would add
 * roughly 16 KB to the startup chunk for two method calls. Outside Tauri
 * (plain `vite dev` in a browser) the invoke rejects and this does nothing.
 */
export async function revealWindow(): Promise<void> {
  try {
    await invoke<void>("reveal_window");
  } catch {
    // Not running inside Tauri.
  }
}
