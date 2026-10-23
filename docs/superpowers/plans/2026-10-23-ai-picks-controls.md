# AI Picks Controls Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for preserved native execution. Steps use checkbox syntax.
**Goal:** Make controls usable on TV and expose bounded search settings and useful diagnostics.
**Architecture:** Extend existing ES5 native Lampa components, add limits and local diagnostics modules; no backend or runtime dependencies.
**Tech Stack:** ES5 IIFE, Node tests/linkedom, esbuild, Chrome fixture.
**Spec:** docs/superpowers/specs/2026-10-23-ai-picks-controls-design.md

## Global Constraints
- Existing defaults remain 5 model/12 tools/40 HTTP/25s model/10s catalog/90s total/10 results.
- Bounds from spec are validated at storage read and at execution; concurrency 3, candidates 80, session 200, context 60000 unchanged.
- No secrets/raw query/prompt/response/full URL in journal or console; no automatic upload.
- Existing key mask, manual model ID, strict final filters and cancellation remain.
## Review Focus
- Activity reattachment/resizing and focus on lower controls (Task 1 browser geometry).
- Modal contract on legacy jQuery versions and hidden/destroyed card focus (Task 1 contract test).
- Corrupt settings and every limit actually reaching execution (Task 2 boundary/integration tests).
- Search no matches/back/key changes and manual entry (Task 2 settings tests).
- Proxy URLs with embedded credentials, malicious error text and storage failures (Task 3 diagnostics tests).

### Task 1: Native scroll and modal contracts
Files: src/ui.js, src/results.js, src/index.js, new src/dialog.js, tests/helpers.cjs, tests/results.test.cjs, tests/integration.test.cjs, browser fixture.
Interfaces: dialog.openText({Lampa,document,$,title,text,onBack}); jQuery factory from window.jQuery/window.$.
- [x] Add failing modal .find contract test and native Scroll/Layer browser geometry reproduction.
- [x] Run focused tests/browser: expect failure opening raw DOM modal and unbounded viewport/zero scroll.
- [x] Add Scroll.minus before render, shared dialog wrapper for explanations/clarifications, restore focus.
- [x] Run full npm test and browser: expect green and lower controls visible.
- [x] Commit fix.

### Task 2: Model search and configurable execution
Files: new src/limits.js, src/settings.js, budget.js, controller.js, catalog.js, routerai.js, prompts.js, index.js; tests settings/budget/controller/prompts/integration.
Interfaces: limits.definitions (key, storage, title, min, max, value, unit), normalizeLimits(values); settings.getConfig returns {key,model,limits,diagnostics}; controller.start accepts limits; budget accepts limits.
- [x] Add failing tests: case-insensitive name/ID model search, no network reload, manual fallback; validated settings default/corrupt values; custom step/tool/HTTP/deadline/timeouts and result count enforced through real orchestration.
- [x] Run focused tests; expect default-only behavior to fail.
- [x] Implement limits module, model search, direct SettingsApi buttons, settings menu and execution propagation with final answer reserve.
- [x] Run full npm test + check; expect green.
- [x] Commit feat.

### Task 3: Bounded safe diagnostics
Files: new src/diagnostics.js; src/settings.js, controller.js, transport integration, prompts.js, index.js; tests diagnostics/controller/integration.
Interfaces: createDiagnostics({Storage,clock,console,request}) returns begin/setEnabled/isEnabled/record/request/exportText/clear; begin(data) returns runId; request(spec,done,runId) wraps transport. record accepts known schemas only.

- [x] Add failing tests: real network success/timeout traces, resolved filters and rejection reasons, persistent cap/clear/disabled mode and hostile URL/error/fields cannot reveal credentials/email/query/prompt.
- [x] Run tests: missing diagnostics expected failure.
- [x] Add module, run/tool/filter/final instrumentation; settings view/download/copy/native console, safe DOM.
- [x] Run full npm test + check + realistic browser interactions; expect green.
- [x] Document settings and how to obtain logs, update acceptance, commit.

### Task 4: Final integration and review
- [ ] Clean dependency install, full suite, ES5, reproducible build, diff check, no credentials.
- [ ] One fresh review of complete branch; Important/Critical fixes RED→GREEN once.
- [ ] Record device/API limits honestly; preserve branch/worktree and report changes and test evidence.
