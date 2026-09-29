# Research: what axe-core and Playwright catch for WCAG 2.2 AA, and what stays manual

Question: [#111](https://github.com/sschorer/manhunt/issues/111) (map [#105](https://github.com/sschorer/manhunt/issues/105)). This page gives facts and options only. The choice of which tools to adopt belongs to the later grilling ticket ([#116](https://github.com/sschorer/manhunt/issues/116)).

Researched 2026-09-29. Versions at that date: `axe-core` 4.13.0, `@axe-core/playwright` 4.13.0 (pins `axe-core ~4.13.0`, peer `playwright-core >= 1.0.0`), `eslint-plugin-jsx-a11y` 6.10.2, `@guidepup/guidepup` 0.34.0, `@guidepup/virtual-screen-reader` 0.33.0, `@guidepup/playwright` 0.19.1, `@guidepup/setup` 0.29.1. Source numbers are in brackets like [S1] and listed under [Sources](#sources).

## Short answer

- **axe-core covers a narrow, well-defined slice of WCAG.** Each rule is tagged with the WCAG success criteria (SC) it checks [S1][S2]. Deque's own study says automated tests found 57.38 % of issues *by count* across about 300,000 audit issues [S5]. That figure measures volume, not criteria. Most SCs have no axe rule at all.
- **WCAG 2.2 adds one axe rule: `target-size` (SC 2.5.8). It is off by default** ("disabled by default, until WCAG 2.2 is more widely adopted") [S1]. Selecting the `wcag22aa` tag turns it on, because a tag match overrides `enabled: false` in axe's rule selection [S3].
- **None of the other new AA/A criteria in 2.2 have an axe rule**: 2.4.11 Focus Not Obscured, 2.5.7 Dragging Movements, 3.2.6 Consistent Help, 3.3.7 Redundant Entry, and 3.3.8 Accessible Authentication [S1][S6].
- **Playwright can check more than axe does**, through custom checks. Examples: walk the Tab order, check that focus is visible and not covered, render at a 320 px viewport, emulate `prefers-reduced-motion` and `forced-colors` [S8], and assert on the ARIA tree [S9]. It gives the mechanics. The pass/fail logic is ours to write.
- **Screen readers:** the Guidepup Virtual Screen Reader runs in jsdom or a browser and simulates spoken output, including live-region announcements [S10]. Guidepup proper drives real **VoiceOver on macOS and NVDA on Windows** on GitHub-hosted runners [S11][S12]. **No tool found automates iOS VoiceOver or Android TalkBack.** That testing stays manual on real devices.

## What each tool is

| Tool | Runs where | What it checks |
|---|---|---|
| `eslint-plugin-jsx-a11y` | ESLint on JSX source (static) | 39 rules on JSX syntax: `alt-text`, `aria-props`, `aria-role`, `label-has-associated-control`, `click-events-have-key-events`, `no-static-element-interactions`, `no-autofocus`, `tabindex-no-positive` and more. `flatConfigs.recommended` / `.strict` for flat config [S7]. It sees only JSX literals. It cannot see computed props, CSS, or rendered output. The peer range is `eslint ^3 … ^9`; the repo uses ESLint 9. |
| axe-core via `@axe-core/playwright` | Real Chromium page in the existing e2e run | Rendered DOM plus computed styles: names, roles, ARIA validity, contrast of text, lang, list/table structure, target size (opt-in) [S1][S4] |
| axe-core in Vitest/jsdom | Unit tests | Same rules, but jsdom has no layout, so contrast and target size cannot be computed there. Not researched further; Playwright is the better place. |
| Playwright built-ins | e2e | `toMatchAriaSnapshot` / `locator.ariaSnapshot()` (YAML of the accessibility tree) [S9]; `toHaveAccessibleName` / `toHaveRole`; `page.emulateMedia({ reducedMotion, forcedColors, colorScheme, contrast })` [S8]; `page.keyboard`; viewport sizing |
| Token contrast script | Node, no browser | WCAG contrast-ratio formula [S13] over the CSS custom properties in `client/src/index.css`. Example on today's tokens vs `--bg #06080c`: `--fg` 17.83:1, `--muted` 5.51:1, `--red` 5.83:1, `--teal` 12.29:1. Checks design intent, including pairs axe cannot resolve (text over the map, gradients). |
| Guidepup Virtual Screen Reader | Vitest (jsdom) or browser | Simulated screen-reader navigation and speech log, built from ARIA/HTML-AAM/accname specs. Has live-region handling (`alert`, `status`, `log`, `timer`, `aria-live`, `aria-atomic`, `aria-relevant`; `aria-busy` still TODO) [S10] |
| Guidepup + `@guidepup/playwright` | macOS runner (VoiceOver) or Windows runner (NVDA) | Real desktop screen readers driving the browser; `spokenPhraseLog()`, `capture()` since 0.33.0 [S11][S12] |

## WCAG 2.2 AA criteria relevant to Manhunt, by how they can be tested

Legend: **Auto** means a tool reports failures with no human judgement for the cases it covers. **Partial** means a tool catches some failures or supplies the mechanics, but a pass still needs a person. **Manual** means no tool found. axe rule IDs come from [S1]. SC texts come from [S6]. "PW custom" means a check we would write ourselves in Playwright.

Criteria that cannot apply to this app are left out: no video or audio (1.2.x), no tables, no iframes, no login (3.3.8 is about authentication, and the app has no accounts per ADR-0007).

| SC | Name (level) | Classification | Tools and notes |
|---|---|---|---|
| 1.1.1 | Non-text content (A) | Partial | axe `image-alt`, `svg-img-alt`, `role-img-alt`, `input-image-alt`, `aria-meter-name`, `aria-progressbar-name`; jsx-a11y `alt-text`. Whether the alt text is *adequate* is manual. The MapLibre canvas is not inspectable. Its text alternative (for example a textual readout of the nearest player) is a design question. |
| 1.3.1 | Info and relationships (A) | Partial | axe `list`, `listitem`, `aria-required-children/parent`, `definition-list`; experimental `p-as-heading`. Heading structure is `best-practice` only (`heading-order`, `page-has-heading-one`). An ARIA snapshot can pin the intended structure. |
| 1.3.2 | Meaningful sequence (A) | Manual | An ARIA snapshot of reading order helps once a person has approved it. |
| 1.3.3 | Sensory characteristics (A) | Manual | For example "the red dot" instructions. |
| 1.3.4 | Orientation (AA) | Partial | axe `css-orientation-lock` is **experimental** (off unless enabled). PW custom: render in portrait and landscape viewports. |
| 1.3.5 | Identify input purpose (AA) | Partial | axe `autocomplete-valid` and jsx-a11y `autocomplete-valid` check that a value is valid, not that it is the right one. The name field is the only candidate here. |
| 1.4.1 | Use of color (A) | Manual | axe `link-in-text-block` covers only links in text. The Hunter red / Hider teal distinction must also carry text or shape. Needs a person, or a grayscale screenshot review. |
| 1.4.3 | Contrast (minimum) (AA) | Auto (most) | axe `color-contrast`. It skips text over background images, obscured text, and gradients and pseudo-element backgrounds, and a 1:1 result goes to "needs review" [S14]. Text over the map, translucent HUD panels, and banners will often end up in `incomplete`. The token script covers design intent. |
| 1.4.4 | Resize text (AA) | Partial | axe `meta-viewport` (blocks `user-scalable=no` / `maximum-scale<2`). PW custom: 200 % zoom or font-size screenshots, then a person checks for clipping. |
| 1.4.5 | Images of text (AA) | Manual | |
| 1.4.10 | Reflow (AA) | Partial | PW custom: 320 × 256 CSS px viewport, assert no horizontal scroll (`scrollWidth <= clientWidth`). Maps are exempt as 2-D content, so the check covers the HUD and panels. |
| 1.4.11 | Non-text contrast (AA) | Manual (+ token script) | No axe rule. Borders, focus rings, the GPS dot, map pins and icon buttons need a 3:1 contrast ratio. The token script can check the tokens meant for these. |
| 1.4.12 | Text spacing (AA) | Partial | axe `avoid-inline-spacing` covers only `!important` inline styles. PW custom: inject the SC's spacing stylesheet and compare screenshots or check for overflow. |
| 1.4.13 | Content on hover or focus (AA) | Manual | Only applies if tooltips or popovers appear. |
| 2.1.1 | Keyboard (A) | Partial | axe `scrollable-region-focusable`, `nested-interactive`, `frame-focusable-content`; jsx-a11y `click-events-have-key-events`, `interactive-supports-focus`, `no-static-element-interactions`. PW custom: drive each flow with `page.keyboard` only. |
| 2.1.2 | No keyboard trap (A) | Partial | PW custom: press Tab N times and assert that focus leaves each region (the map canvas especially). |
| 2.1.4 | Character key shortcuts (A) | Manual | MapLibre's keyboard handler only acts while the map has focus, which falls under the SC's "active only on focus" exception. Confirm manually. |
| 2.2.1 | Timing adjustable (A) | Manual | The match clock and the Boundary grace period are candidates for the SC's real-time exception. That is a judgement call, not a test. |
| 2.2.2 | Pause, stop, hide (A) | Partial | axe `blink`, `marquee` (legacy elements only). Pulsing banners and animated pins need a person. PW `emulateMedia({ reducedMotion: 'reduce' })` + assertion is PW custom. |
| 2.3.1 | Three flashes (A) | Manual | Applies to flashing reveal or catch effects. |
| 2.4.1 | Bypass blocks (A) | Auto (weak) | axe `bypass` passes if any landmark or heading exists. |
| 2.4.2 | Page titled (A) | Partial | axe `document-title` checks only that a title exists. Whether the title changes per screen, and fits it, is PW custom or manual. |
| 2.4.3 | Focus order (A) | Partial | PW custom: record the Tab sequence and compare it with an expected list. Focus management after a screen change (Lobby → match → Game over) is PW custom plus manual. |
| 2.4.4 | Link purpose (A) | Partial | axe `link-name` (a name exists). |
| 2.4.6 | Headings and labels (AA) | Manual | axe `empty-heading` is best-practice only. |
| 2.4.7 | Focus visible (AA) | Partial | No axe rule. PW custom: after each Tab, compare a screenshot of the element with and without focus, or assert on computed `outline`/`box-shadow`. |
| 2.4.11 | Focus not obscured (min) (AA, new) | Partial | No axe rule. PW custom: after each Tab, `elementFromPoint` at the focused element's corners to see whether it is fully covered by a fixed banner, HUD or bottom sheet. The Understanding doc names sticky notifications and non-modal overlays as typical failures [S15]. Manhunt's banners and HUD match that. |
| 2.5.1 | Pointer gestures (A) | Manual | Pinch-zoom on the map needs single-pointer zoom buttons. A PW custom check can only confirm the buttons exist. |
| 2.5.2 | Pointer cancellation (A) | Manual | Applies to press-and-hold actions, if any are designed. |
| 2.5.3 | Label in name (A) | Partial | axe `label-content-name-mismatch` is **experimental** (off unless enabled). |
| 2.5.4 | Motion actuation (A) | Manual | Judgement call on whether GPS movement counts as "user motion" and whether it is essential. No tool can decide. |
| 2.5.7 | Dragging movements (AA, new) | Manual | The Understanding doc's own example is a draggable map with pan buttons [S16]. The Boundary drawing flow (the Host fences an area) and map panning both need a non-drag path. |
| 2.5.8 | Target size (min) (AA, new) | Auto (opt-in) | axe `target-size` (`wcag22aa` tag, off by default) measures the unobscured 24×24 CSS px size or 24 px spacing [S1][S17]. Map pins may use the SC's "Essential" exception, which names map pins [S18]. Expect to exclude or triage pins. |
| 3.1.1 | Language of page (A) | Auto | axe `html-has-lang`, `html-lang-valid`. |
| 3.1.2 | Language of parts (AA) | Partial | axe `valid-lang` checks only that a `lang` value is valid. |
| 3.2.1 / 3.2.2 | On focus / On input (A) | Manual | A context change on focus or input is a design review item. |
| 3.2.3 / 3.2.4 | Consistent navigation / identification (AA) | Manual | An ARIA snapshot across screens can pin names once approved. |
| 3.2.6 | Consistent help (A, new) | Manual | Only applies if a help mechanism is added. |
| 3.3.1 / 3.3.3 | Error identification / suggestion (A/AA) | Partial | PW custom: submit a bad Join code, assert `role=alert` text. Whether the wording is useful is manual. |
| 3.3.2 | Labels or instructions (A) | Partial | axe `label`, `form-field-multiple-labels`, `select-name`; jsx-a11y `label-has-associated-control`. |
| 3.3.7 | Redundant entry (A, new) | Manual | Rejoin after disconnect: is the name asked again? |
| 4.1.2 | Name, role, value (A) | Auto (most) | axe `button-name`, `aria-*` validity rules, `aria-toggle-field-name`, `aria-hidden-focus`, `nested-interactive`; jsx-a11y `aria-*`, `role-has-required-aria-props`. Whether names *make sense* is manual; ARIA snapshots can pin them. |
| 4.1.3 | Status messages (AA) | Partial | axe only checks that `role=status/alert` is valid ARIA. It does not check that a message is announced. Options: PW `getByRole('status')` text assertions (already used in `boundary.spec.ts`, `push.spec.ts`); the Virtual Screen Reader's live-region log in Vitest [S10]; real VoiceOver/NVDA via Guidepup [S11]. |

Count for this list: 3 SCs are mostly **Auto** (1.4.3, 3.1.1, 4.1.2), 2 are **Auto (weak or opt-in)** (2.4.1, 2.5.8), about 21 are **Partial**, and about 20 are **Manual**. Most of the Partial SCs depend on custom Playwright checks we would have to write.

## Running axe against dynamic game states in our harness

How the harness works today (`client/playwright.config.ts`, `client/e2e/harness.ts`): one Chromium project; `globalSetup` builds the PWA and Worker; each Playwright worker starts the built Worker in local workerd through wrangler's `createTestHarness()`. Specs reach game states by driving real browser contexts:

- **Lobby / match / Game over**: `hostGame`, `joinAsBo`, `readyHost`, `readyUp` in `client/e2e/players.ts`, with `geolocation` set per context.
- **Timed states**: `test.use({ workerVars: { PING_INTERVAL_S: '10' } })` (`ping.spec.ts`), `GAME_DURATION_S: '8'` (`timeup.spec.ts`), `DISCONNECT_GRACE_S` (`reconnect.spec.ts`) shorten the rule timers.
- **Banners**: the Boundary alerts (`boundary.spec.ts`, `role=alert`), the Ping reveal banner (`MatchHud.tsx`, `role=status`), and push hints (`push.spec.ts`). Each is reached by position and timer setup and is already asserted by role.

Facts that shape an axe step in these specs:

1. **axe only tests what is rendered and visible.** "Axe does not test hidden regions, such as inactive menus or modal windows… write tests that activate or render the regions visible and run the analysis again" [S3]. A banner that shows for a few seconds has to be scanned *while* it is on screen. So the scan call goes right after the existing `await expect(...getByRole('alert')).toContainText(...)` line. Because these assertions already wait for the state, no extra synchronisation is needed.
2. **One scan per state, inside the existing specs,** avoids new multi-context setup. It also avoids a second workerd startup, since the Worker is per Playwright worker and per `workerVars` set. A fixture in the style of the Playwright docs [S4] (`makeAxeBuilder` with shared tags and excludes) could be added to `harness.ts` next to `workerOrigin`.
3. **Scoping:** `AxeBuilder#include()` / `#exclude()` [S19]. Excluding an element skips *every* rule for it and its children [S4]. Excluding `[data-testid=game-map]` hides MapLibre's canvas, controls and markers from all rules. `disableRules` or a per-rule option would be narrower.
4. **State flakiness:** a scan reads the DOM at one moment. `game_state` frames keep arriving and re-render the HUD. Contrast and target-size results are stable only once animations settle. `emulateMedia({ reducedMotion: 'reduce' })` [S8] reduces motion if the CSS honours it (`ActiveGame.css` already has a `prefers-reduced-motion` block).
5. **Two players, two pages:** Hunter and Hider views differ (`hunter-hud` vs `hider-hud`). Each state that matters needs a scan per role's page.

### Keeping CI noise low

- **Tags:** `withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'])` runs exactly the WCAG A/AA rules [S4][S19]. It leaves out `best-practice` (landmarks, `heading-order`, `region`) and `experimental`. Adding `wcag22aa` turns on `target-size` [S1][S3]. Each experimental rule (`css-orientation-lock`, `label-content-name-mismatch`, `p-as-heading`) can be enabled by id via `options({ rules: { id: { enabled: true } } })` [S3].
- **Violations vs `incomplete`:** axe returns `violations` and `incomplete` ("needs review") separately [S3]. Failing CI only on `violations` and attaching `incomplete` as a report keeps red builds to definite failures. `testInfo.attach()` of the JSON results is the documented pattern [S4].
- **Baselines:** the Playwright docs recommend snapshotting a *fingerprint* (rule id + target selectors) rather than the full violations array, because HTML snippets change for unrelated reasons [S4]. Options include `disableRules` for known debt, or a checked-in fingerprint file per state.
- **Determinism:** axe is pinned through `@axe-core/playwright`'s `~4.13.0` dependency. New axe minor versions can add rules, so an upgrade can turn CI red without an app change.
- **Chromium only:** the project runs Desktop Chrome only. axe results do not depend much on the engine, but contrast and target size depend on layout. A mobile viewport project (for example `devices['Pixel 7']`, still Chromium) would be closer to real use.

## Screen-reader emulation in CI

| Option | What it gives | Limits |
|---|---|---|
| **ARIA snapshots** (`toMatchAriaSnapshot`) [S9] | A YAML accessibility tree (role, name, state) per screen, diffed in CI. Regex allowed for dynamic text. `--update-snapshots` to accept changes. Runs in today's Chromium e2e job. | It is a tree, not speech. It says nothing about announcement timing or live regions. |
| **Guidepup Virtual Screen Reader** [S10] | `virtual.start({ container })`, `next()`, `spokenPhraseLog()`, live-region announcements. Runs in Vitest + jsdom, which the client unit tests already use, or in the browser via an ESM build. | Its own model built from W3C specs, not a real screen reader. The README states: "should not replace but augment your screen reader testing, there is no substitute for testing with real screen readers and with real users." It fails 81 of its web-platform tests and skips 338. |
| **Guidepup + `@guidepup/playwright`** (VoiceOver / NVDA) [S11][S12][S20] | Real desktop screen readers. Guidepup's own CI runs VoiceOver on `macos-14/15/26` and NVDA on `windows-2022/2025` GitHub-hosted runners, with `npx @guidepup/setup setup --ci`. `screenReader.capture()` records speech around a Playwright action. | Desktop VoiceOver and NVDA only. **Not iOS VoiceOver, not Android TalkBack.** `@guidepup/setup` now lists Orca on Linux, but the `@guidepup/guidepup` library has only `macOS` and `windows` drivers. Would need a separate macOS/Windows job, and our workerd harness has not been tested on those runners. The repo is public, so standard GitHub-hosted runners (including macOS) cost nothing, but macOS jobs are slower. Real screen-reader runs are timing-sensitive (Guidepup records video on macOS for debugging). |
| **Mobile screen readers (VoiceOver iOS, TalkBack)** | None found in the sources reviewed. | Stays manual. Without a real device, the closest available checks are desktop VoiceOver (Safari/WebKit engine family) and the virtual reader. Neither shows iOS rotor or TalkBack gesture behaviour. |

## Implications for Manhunt

- The existing e2e specs already reach every screen that matters: Lobby, match (Hunter and Hider HUDs), Ping reveal, Boundary warning and elimination, Catch, Game over, push hints. Adding axe means adding a scan to each spec after its state assertion, not building new game setup. `@axe-core/playwright` is the only new dependency for that.
- The biggest untested risks are the parts that are new in 2.2 or specific to maps: **2.4.11** (banners and HUD covering focus), **2.5.7** (map panning, Boundary drawing), **2.5.8** (small map controls and pins), **1.4.11** (pins, GPS dot, focus rings), **1.4.1** (red/teal roles). Only 2.5.8 has an axe rule. The others need Playwright checks we write, or a manual pass.
- **4.1.3 status messages** matter most in a game that gives many notifications. Today's specs already assert the `role=alert` and `role=status` text. The open choice is whether also to assert *speech*: the virtual reader in Vitest (cheap, runs on Linux) versus Guidepup on a macOS/Windows job (real, costlier), or neither.
- `eslint-plugin-jsx-a11y` would slot into the existing `client/src/**/*.{ts,tsx}` block of `eslint.config.ts`, which already runs in CI's `npm run lint`. It catches issues earliest, but it can only see JSX literals.
- A token-contrast check can run in Vitest with no browser. It is the only automated check for colour pairs axe cannot resolve over the map.
- With no iOS or Android device, the manual pass has to rely on desktop VoiceOver or NVDA plus a mobile-viewport Chromium. That leaves a documented gap for touch screen-reader gestures.

## Sources

- [S1] axe-core rule descriptions (generated, develop branch, 4.13): <https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md>
- [S2] axe-core API docs, tag table: <https://github.com/dequelabs/axe-core/blob/develop/doc/API.md#axe-core-tags>
- [S3] axe-core API docs (hidden regions, `runOnly`, `incomplete`), and rule selection source `lib/core/utils/rule-should-run.js` plus `lib/rules/target-size.json`: <https://github.com/dequelabs/axe-core/blob/develop/doc/API.md>, <https://github.com/dequelabs/axe-core/blob/develop/lib/core/utils/rule-should-run.js>, <https://github.com/dequelabs/axe-core/blob/develop/lib/rules/target-size.json>
- [S4] Playwright, Accessibility testing: <https://playwright.dev/docs/accessibility-testing>
- [S5] Deque, Automated accessibility testing coverage report: <https://www.deque.com/automated-accessibility-testing-coverage/>
- [S6] W3C, What's new in WCAG 2.2: <https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/>; WCAG 2.2 Recommendation: <https://www.w3.org/TR/WCAG22/>
- [S7] eslint-plugin-jsx-a11y README: <https://github.com/jsx-eslint/eslint-plugin-jsx-a11y>
- [S8] Playwright `page.emulateMedia()`: <https://playwright.dev/docs/api/class-page#page-emulate-media>
- [S9] Playwright ARIA snapshots: <https://playwright.dev/docs/aria-snapshots>
- [S10] Guidepup Virtual Screen Reader README and `src/getLiveSpokenPhrase.ts`: <https://github.com/guidepup/virtual-screen-reader>
- [S11] Guidepup README: <https://github.com/guidepup/guidepup>; releases (0.33.0 `capture()`, 0.34.0 NVDA 2026.2): <https://github.com/guidepup/guidepup/releases>
- [S12] `@guidepup/playwright` README and CI workflows (`test-voiceover.yml`, `test-nvda.yml`): <https://github.com/guidepup/guidepup-playwright>
- [S13] WCAG 2.2 definitions of contrast ratio and relative luminance: <https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio>
- [S14] Deque University, `color-contrast` rule: <https://dequeuniversity.com/rules/axe/4.13/color-contrast>
- [S15] Understanding SC 2.4.11 Focus Not Obscured (Minimum): <https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html>
- [S16] Understanding SC 2.5.7 Dragging Movements: <https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html>
- [S17] Deque University, `target-size` rule: <https://dequeuniversity.com/rules/axe/4.13/target-size>
- [S18] Understanding SC 2.5.8 Target Size (Minimum): <https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html>
- [S19] `@axe-core/playwright` README (AxeBuilder API): <https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright>
- [S20] `@guidepup/setup` README (CI flag, supported OSes): <https://github.com/guidepup/setup>

[S1]: https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md
[S2]: https://github.com/dequelabs/axe-core/blob/develop/doc/API.md#axe-core-tags
[S3]: https://github.com/dequelabs/axe-core/blob/develop/doc/API.md
[S4]: https://playwright.dev/docs/accessibility-testing
[S5]: https://www.deque.com/automated-accessibility-testing-coverage/
[S6]: https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/
[S7]: https://github.com/jsx-eslint/eslint-plugin-jsx-a11y
[S8]: https://playwright.dev/docs/api/class-page#page-emulate-media
[S9]: https://playwright.dev/docs/aria-snapshots
[S10]: https://github.com/guidepup/virtual-screen-reader
[S11]: https://github.com/guidepup/guidepup
[S12]: https://github.com/guidepup/guidepup-playwright
[S13]: https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
[S14]: https://dequeuniversity.com/rules/axe/4.13/color-contrast
[S15]: https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html
[S16]: https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html
[S17]: https://dequeuniversity.com/rules/axe/4.13/target-size
[S18]: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
[S19]: https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright
[S20]: https://github.com/guidepup/setup
