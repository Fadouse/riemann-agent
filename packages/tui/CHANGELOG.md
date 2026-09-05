# Changelog

## [Unreleased]

### Fixed

- Fixed mouse hover changing selection and recentering autocomplete and settings lists, causing clicks to target a different item.

## [0.85.0] - 2026-09-04

### Breaking Changes

- Removed coding-agent environment-variable defaults from pi-tui. Applications must configure the hardware cursor and clear-on-shrink behavior through the renderer constructor and `setClearOnShrink()`. `PI_DEBUG_REDRAW` is now `PI_TUI_DEBUG_REDRAW`; debug and crash log filenames now use the `pi-tui-` prefix. When no log directory is supplied, redraw logging is disabled and crash dumps are written to the OS temp directory. ([#8699](https://github.com/earendil-works/pi/pull/8699) by [@geraschenko](https://github.com/geraschenko))

### Added

- Added a `TuiAltScreen` `scrollToEndIndicator` option that renders a clickable jump-to-end label on a follow-end primary scroll view while it is scrolled away from the end ([#9080](https://github.com/earendil-works/pi/pull/9080) by [@rwachtler](https://github.com/rwachtler)).
- Added LaTeX rendering for relational algebra join symbols ([#9050](https://github.com/earendil-works/pi/pull/9050) by [@haoqixu](https://github.com/haoqixu)).

### Changed

- Changed the `Loader` animation and editor integration to support embedded working indicators ([#8799](https://github.com/earendil-works/pi/pull/8799) by [@cristinaponcela](https://github.com/cristinaponcela)).
- Reduced fullscreen transcript search latency on large transcripts by caching unchanged search results, indexing ASCII runs, and limiting highlight work to visible matches ([#8800](https://github.com/earendil-works/pi/pull/8800) by [@cristinaponcela](https://github.com/cristinaponcela)).

### Fixed

- Fixed drag selection continuing over an editor.
- Fixed terminal startup under restricted seccomp policies that reject the `SIGWINCH` self-signal ([#8898](https://github.com/earendil-works/pi/pull/8898) by [@bartlomiejkida](https://github.com/bartlomiejkida)).
- Fixed Zed terminal image capability detection ([#8828](https://github.com/earendil-works/pi/pull/8828) by [@Perlence](https://github.com/Perlence)).

### Fixed

- Made complete `[Image #N]` attachment markers atomic for cursor movement and deletion, matching existing paste-marker behavior.
- Fixed malformed Unicode and unsafe terminal controls causing width drift, cursor corruption, extra rows, and slow terminal-sequence scanning.
- Fixed inherited terminal working directories by reporting the active session cwd with OSC 7 across startup, session switches, and TUI resumes.

## [0.84.4] - 2026-08-28

### Added

- Added environment and programmatic overrides for OSC 8 hyperlinks, inline image protocols, and truecolor terminal capabilities ([#8665](https://github.com/earendil-works/pi/issues/8665)).
- Added a `TuiAltScreen` `copyOnSelect` option plus helpers to detect and copy the active fullscreen text selection programmatically ([#7720](https://github.com/earendil-works/pi/issues/7720)).

### Changed

- Changed fullscreen scrollbars to render muted thin tracks with contrasting proportional two-cell-minimum thumbs, preserve underlying backgrounds without inheriting foreground styles, reserve an unstyled column in `always` mode, reveal hidden `auto` tracks on pointer entry, expand the same-colored thumb on hover, and support track-click jumping in addition to thumb dragging.
- Changed fullscreen transcript search to use a bordered, placeholder-based input with a muted result count, right-aligned clickable key-and-arrow buttons with configurable hover styling, and open-shortcut toggling.

### Fixed

- Fixed main-screen rendering crashing when image-heavy output exceeded V8's string length limit ([#8028](https://github.com/earendil-works/pi/issues/8028)).
- Fixed autocomplete ordering for nested results ([#8669](https://github.com/earendil-works/pi/pull/8669)).
- Fixed fullscreen double-click word selection splitting paths and kebab-case tokens on `/` and `-` ([#7746](https://github.com/earendil-works/pi/issues/7746)).

## [0.84.3] - 2026-08-24

### Fixed

- Fixed duplicate fullscreen right-click paste in VS Code-based terminals on Windows ([#8186](https://github.com/earendil-works/pi/issues/8186)).
- Fixed padded text exceeding narrow terminal widths ([#8252](https://github.com/earendil-works/pi/issues/8252)).
- Fixed wrapped Markdown table links leaking color into borders and neighboring cells, including tables inside blockquotes ([#8335](https://github.com/earendil-works/pi/issues/8335)).

## [0.84.2] - 2026-08-14

### Added

- Added unbound single-line transcript scrolling actions, `tui.altScreen.lineUp` and `tui.altScreen.lineDown`, for fullscreen TUI keybindings ([#7903](https://github.com/earendil-works/pi/pull/7903) by [@midastruth](https://github.com/midastruth)).
- Added incremental primary-scroll-view search to the fullscreen TUI with configurable match styles, `Ctrl+Shift+F`, and next/previous navigation with `Enter`/`Ctrl+G` and `Shift+Enter`/`Ctrl+Shift+G`.

### Changed

- Reduced alternate-screen per-frame allocation churn roughly 9-18x by painting full-width layout rows as direct line references instead of recompositing every visible row through ANSI/grapheme segmentation on each frame.

### Fixed

- Fixed fullscreen mouse drag selection and OSC 8 link activation in terminals that report generic SGR mouse release button codes ([#7963](https://github.com/earendil-works/pi/issues/7963)).
- Fixed fullscreen transcript search snapping back to the current match during manual scrolling and fragmented SGR mouse input leaking into the search query.
- Fixed required LaTeX arguments starting on a new line being parsed as empty ([#7760](https://github.com/earendil-works/pi/issues/7760)).
- Fixed LaTeX control spaces split across line endings causing complete expressions to fall back to raw source.
- Fixed focused fullscreen overlays not receiving mouse wheel or viewport scroll keys such as PageUp and PageDown ([#7894](https://github.com/earendil-works/pi/issues/7894)).
- Fixed split `Alt+Enter` input over SSH being misread as Escape, added `PI_TUI_ESC_TIMEOUT` for high-latency terminals, and limited that timeout to lone Escape input ([#7899](https://github.com/earendil-works/pi/pull/7899) by [@powerfooI](https://github.com/powerfooI)).
- Fixed idle fullscreen sessions repainting and clearing text selection when the terminal loses focus ([#7892](https://github.com/earendil-works/pi/pull/7892) by [@terrorobe](https://github.com/terrorobe)).
- Fixed fullscreen selection copy falsely reporting success when OSC 52 is unsupported by allowing host clipboard integration and reporting verified failures ([#8110](https://github.com/earendil-works/pi/pull/8110) by [@Panoplos](https://github.com/Panoplos)).

## [0.84.1] - 2026-08-07

### Added

- Added unbound half-page transcript scrolling actions, `tui.altScreen.halfPageUp` and `tui.altScreen.halfPageDown`, for fullscreen TUI keybindings ([#7735](https://github.com/earendil-works/pi/issues/7735)).
- Added double-click word and whitespace selection, granularity-aware drag selection, and triple-click paragraph selection in the fullscreen TUI ([#7725](https://github.com/earendil-works/pi/issues/7725), [#7733](https://github.com/earendil-works/pi/pull/7733) by [@volsa](https://github.com/volsa)).
- Added an optional right-click paste handler to the alternate-screen TUI, currently enabled on Windows.

### Fixed

- Fixed LaTeX relation, multiplication, and named-operator spacing, and correctly composed matrices with stacked fractions, operator limits, and adjacent matrices.
- Reduced fullscreen mouse event volume under tmux, Zellij, and GNU Screen by using button-motion tracking instead of all-motion tracking.

## [0.84.0] - 2026-08-06

### Added

- Added terminal-friendly Unicode rendering for LaTeX expressions in Markdown, including inline and display math, fractions, scripts, common symbols, aligned equations, cases, and matrices.
- Added the shared `TuiMode` type and `mode` discriminants to the main-screen and alternate-screen TUI renderers.
- Added TUI lifecycle and render-state handoff APIs for replacing renderers without replaying main-screen content.
- Exported the bundled `Marked` parser and token types.
- Added width-aware source transforms to the `Markdown` component.
- Added interface-compatible main-screen and alternate-screen TUI renderers with application-owned scrolling ([#7304](https://github.com/earendil-works/pi/issues/7304)).
- Added alternate-screen `VStack`, `HStack`, and nested `ScrollView` layouts with constrained sizing, sticky regions, and pointer-targeted scrolling.
- Added edge auto-scrolling for alternate-screen drag selection across off-screen scroll-view content.
- Added proportional scrollbars with mouse dragging, Home/End document navigation, transient `auto` mode, and an `always` mode that reserves the rightmost column; scrollbar modes can be changed at runtime.
- Added page scrolling and OSC 133 semantic prompt navigation to the alternate-screen viewport.
- Added configurable previous/next prompt history actions for navigation independent of vertical cursor movement.
- Added stacked transient notifications to the alternate-screen renderer ([#7361](https://github.com/earendil-works/pi/pull/7361)).

### Changed

- Reduced the default alternate-screen mouse wheel step from three lines to one for finer scrolling.

### Fixed

- Fixed Windows Shift+Enter detection by extending the native Win32 helper to report modifier key state.
- Fixed the npm package omitting the source and build script needed to rebuild the Windows native addon.
- Fixed the npm package omitting the source and build script needed to rebuild the Darwin native addon.
- Fixed Windows console truecolor detection when Windows Terminal does not provide `WT_SESSION` to child shells.
- Fixed terminal width accounting for Indic conjunct grapheme clusters ([#6987](https://github.com/earendil-works/pi/pull/6987) by [@petrroll](https://github.com/petrroll)).
- Fixed phantom alternate-screen text selection from unmatched mouse events when changing terminal pane focus.
- Fixed spaces in searchable settings queries changing the selected value instead of filtering multi-word labels.
- Fixed alternate-screen Kitty images crossing vertical layout clip boundaries and overlapping sticky regions while scrolling.
- Fixed alternate-screen redraws retransmitting Kitty image data when placements move or recently offscreen images return, dropping adjacent row content when reusing placements, rendering fixed-basis scroll content twice per frame, and scanning clipped transcript rows while painting.
- Fixed fullscreen transcript navigation leaving no editor-accessible `Home`, `End`, `PageUp`, or `PageDown` variants by adding Ctrl-modified editor bindings ([#7574](https://github.com/earendil-works/pi/issues/7574)).
- Fixed keyboard input rendering latency on Windows by letting input preempt the throttled render timer.
- Fixed nested stack layouts ignoring child minimum sizes.
- Fixed batched terminal color-scheme reports being parsed as one malformed response ([#7550](https://github.com/earendil-works/pi/pull/7550)).
- Fixed terminal progress clearing to emit the complete OSC 9;4 sequence ([#7581](https://github.com/earendil-works/pi/pull/7581)).
- Fixed iTerm2 image payloads omitting the size metadata required by the xterm.js image addon ([#7612](https://github.com/earendil-works/pi/pull/7612)).
- Fixed width truncation leaving OSC 8 hyperlinks unterminated ([#7657](https://github.com/earendil-works/pi/pull/7657) by [@xXJSONDeruloXx](https://github.com/xXJSONDeruloXx)).

## [0.83.0] - 2026-07-29

### Fixed

- Fixed long image fallback paths overflowing narrow terminals, shortened home-directory paths, and made absolute paths clickable when terminal hyperlinks are available ([#7262](https://github.com/earendil-works/pi/pull/7262)).

## [0.82.1] - 2026-07-25

## [0.82.0] - 2026-07-24

### Fixed

- Fixed debug and crash logs to use the configured TUI log directory, including `PI_CODING_AGENT_DIR`, instead of always writing under `~/.pi/agent` ([#6958](https://github.com/earendil-works/pi/pull/6958) by [@davidbrai](https://github.com/davidbrai)).
- Fixed narrow terminals crashing when the editor's bottom scroll indicator exceeded the terminal width ([#7015](https://github.com/earendil-works/pi/pull/7015) by [@christianklotz](https://github.com/christianklotz)).

## [0.81.1] - 2026-07-21

## [0.81.0] - 2026-07-21

### Fixed

- Fixed terminal shutdown to clear the editor's inverted software cursor before restoring the hardware cursor, avoiding a duplicate cursor artifact ([#6790](https://github.com/earendil-works/pi/pull/6790) by [@dam9000](https://github.com/dam9000)).
- Fixed ANSI-aware text wrapping to recognize CRLF and CR line endings while preserving styles across lines ([#6764](https://github.com/earendil-works/pi/pull/6764) by [@xz-dev](https://github.com/xz-dev)).
- Fixed editor paste registry corruption when deleting paste markers: undo now restores the paste registry together with the text, and marker renumbering shifts registry entries in ascending id order, so submitted prompts no longer contain literal `[paste #N ...]` markers or the wrong paste's content ([#6844](https://github.com/earendil-works/pi/issues/6844)).

## [0.80.10] - 2026-07-16

## [0.80.9] - 2026-07-16

## [0.80.8] - 2026-07-16

### Fixed

- Fixed terminal output to normalize tab characters consistently ([#6697](https://github.com/earendil-works/pi-mono/pull/6697) by [@xz-dev](https://github.com/xz-dev)).

## [0.80.7] - 2026-07-14

### Fixed

- Fixed legacy terminal decoding for Alt+symbol key combinations such as `Alt+,` and `Alt+.` ([#6523](https://github.com/earendil-works/pi-mono/pull/6523) by [@ribelo](https://github.com/ribelo)).

## [0.80.6] - 2026-07-09

## [0.80.5] - 2026-07-09

## [0.80.4] - 2026-07-09

### Fixed

- Fixed editor paste marker accounting when paste markers are deleted or terminal state is cleared, preventing stale paste state after marker removal ([#6397](https://github.com/earendil-works/pi/pull/6397) by [@affanali2k3](https://github.com/affanali2k3)).

## [0.80.3] - 2026-06-30

### Added

- Added an opt-in Markdown renderer option to preserve source backslash escapes for transcript rendering ([#6105](https://github.com/earendil-works/pi/issues/6105)).

## [0.80.2] - 2026-06-23

## [0.80.1] - 2026-06-23

## [0.80.0] - 2026-06-23

### Changed

- Added `Ctrl+J` as a default newline keybinding alongside `Shift+Enter`.

## [0.79.10] - 2026-06-22

## [0.79.9] - 2026-06-20

### Fixed

- Fixed Markdown streaming code fence rendering so partial closing fences no longer make code blocks shrink or flicker while content streams ([#5846](https://github.com/earendil-works/pi/pull/5846) by [@xl0](https://github.com/xl0)).

## [0.79.8] - 2026-06-19

## [0.79.7] - 2026-06-18

### Added

- Added terminal color-scheme query and notification support for light/dark appearance detection (`TUI.queryTerminalColorScheme()`, `TUI.onTerminalColorSchemeChange()`, and `TUI.setTerminalColorSchemeNotifications()`) ([#5874](https://github.com/earendil-works/pi/pull/5874)).
- Added Warp terminal detection for Kitty graphics inline image support ([#5841](https://github.com/earendil-works/pi/pull/5841) by [@dodiego](https://github.com/dodiego)).
- Exported `sliceByColumn` for ANSI-aware horizont
[preview truncated; inspect artifact]