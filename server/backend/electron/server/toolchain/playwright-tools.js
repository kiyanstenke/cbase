// The tool names of the Playwright MCP as cbase starts it (toolchain/playwright.js: version PLAYWRIGHT_MCP_VERSION 0.0.84,
// `capabilities` PLAYWRIGHT_CAPABILITIES = network, storage, testing, vision) — a leaf without imports.
//
// Why: the prefix of a Codex run names the MCP tools (providers/connectors/codex-prefix.js), because Codex only sees them at
// runtime via `ALL_TOOLS`, while the system prompt uses bare names like browser_tabs and browser_take_screenshot. Asking live
// would mean an npx start plus process per run (seconds) — but the list depends only on version and capabilities, both pinned
// in this tree. So it is fixed here, and the guard server/backend/test/playwright-capabilities.test.js compares it with
// `tools/list` of the REAL MCP in exactly this configuration: a version or capability bump is red until the list follows.
// Order = that of `tools/list`.
export const PLAYWRIGHT_TOOLS = Object.freeze([
  "browser_close", "browser_resize", "browser_console_messages",
  "browser_cookie_list", "browser_cookie_get", "browser_cookie_set", "browser_cookie_delete", "browser_cookie_clear",
  "browser_handle_dialog", "browser_emulate_media", "browser_evaluate", "browser_file_upload", "browser_drop", "browser_find",
  "browser_fill_form", "browser_press_key", "browser_type",
  "browser_mouse_move_xy", "browser_mouse_click_xy", "browser_mouse_drag_xy", "browser_mouse_down", "browser_mouse_up", "browser_mouse_wheel",
  "browser_navigate", "browser_navigate_back",
  "browser_network_requests", "browser_network_request", "browser_network_state_set", "browser_route", "browser_route_list", "browser_unroute",
  "browser_run_code_unsafe", "browser_take_screenshot", "browser_snapshot", "browser_click", "browser_drag", "browser_hover",
  "browser_select_option", "browser_generate_locator", "browser_storage_state", "browser_set_storage_state", "browser_tabs",
  "browser_verify_element_visible", "browser_verify_text_visible", "browser_verify_list_visible", "browser_verify_value", "browser_wait_for",
  "browser_localstorage_list", "browser_localstorage_get", "browser_localstorage_set", "browser_localstorage_delete", "browser_localstorage_clear",
  "browser_sessionstorage_list", "browser_sessionstorage_get", "browser_sessionstorage_set", "browser_sessionstorage_delete", "browser_sessionstorage_clear",
]);
