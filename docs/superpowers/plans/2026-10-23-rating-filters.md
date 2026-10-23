# Rating Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Honest candidate coverage and source-specific minimum ratings.
**Architecture:** Separate provider adapter and candidate screening stage before each subsequent model request. Final parsing independently validates rating and eligible IDs. Existing transport budgets bound all requests.
**Tech Stack:** ES5 CommonJS, Lampa native APIs, node:test, esbuild.
**Spec:** docs/superpowers/specs/2026-10-23-rating-filters-design.md

## Global Constraints
- imdb default; kp and tmdb selectable; null minimum disables.
- No unverified result or source fallback; no automatic paid AI retries.
- Existing HTTP/concurrency/time budgets; KP cap default10; cache no network errors.
- Native execution, isolated branch, no merge/push.

## Review Focus
- Changing filters after earlier screening must invalidate eligibility, retaining safe metadata/cache.
- Unknown metadata/ratings versus timeout must not inflate verified/passed counts.
- KP quota/auth failures stop requests; IMDb must never consume KP quota.
- Cancellation and late callbacks must not mutate newer runs.
- More/refine and TV navigation preserve filters and progress accessibility.

### Task 1: Source adapters and filter contract
Files: src/domain.js, src/catalog.js, src/ratings.js (new), src/limits.js, tests/ratings.test.cjs (new), tests/domain.test.cjs.
Interfaces: createRatings({request,catalog,Lampa,clock,maxKpRequests}).getMany(candidates,source,done) returns cancel; callback map key to {value,error}. Filters ratingSource/ratingMin; ratingSource defaults imdb.
- [x] Write and run failing tests for rating range/source locks, bulk IMDb exact ID, KP cap/auth/cache, TMDB independent scores and unknown ratings.
- [x] Implement adapters, rating validation and required catalog ID enrichment.
- [x] Run targeted tests and full suite; commit.

### Task 2: Screening and honest progress
Files: src/screening.js (new), src/controller.js, src/prompts.js, src/diagnostics.js, tests/screening.test.cjs (new), tests/controller.test.cjs.
Interfaces: createScreening(...).check(filters,excluded,done), snapshot(), eligible(); controller emits progress snapshots and includes final stats.
- [x] Write and run failing tests for every unique candidate, exclusion, metadata errors, ratings after cheap filters, budget exhaustion and revalidation.
- [x] Implement screening before model selection, final eligibility gate, live progress and sanitised diagnostic fields.
- [x] Run cancellation/timeout/controller/full tests; commit.

### Task 3: Native controls and integration
Files: src/ui.js, src/index.js, src/settings.js, src/styles.css, README.md, tests/ui.test.cjs, tests/integration.test.cjs, ai-picks.js, .gitignore.
Interfaces: screen.setProgress(stats), rating controls emit same domain form fields; index forwards progress; settings expose KP key and cap.
- [x] Write and run failing UI/integration tests for three sources, comma decimal, clear/reset, progress labels and More/refine.
- [x] Implement native controls, settings, documentation and build.
- [x] Run full suite, ES5, diff check, reproducible build and native browser fixture; commit.
- [x] Request fresh whole-branch review; fix important findings with regression tests; retain branch for separate publication approval.
