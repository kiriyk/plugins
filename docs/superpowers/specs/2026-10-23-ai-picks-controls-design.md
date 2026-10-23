# AI Picks controls and diagnostics
User scope: model search, extended app settings (user selected full proposed set), scrolling and explanation error, extractable diagnostics. Execution stays native in the existing worktree.
## Approaches
Keep native Lampa Scroll/Select/Input/Modal and add settings and a local journal (chosen from existing app architecture). A separate custom UI or backend duplicates app controls and contradicts the serverless requirement.
## Behavior
- Search models locally by name and ID, case insensitive, retain manual entry and tools capability filtering.
- Scroll fills available activity height using Scroll.minus; focus moves results/actions into viewport. Explanation and clarification modals receive jQuery-wrapped safe DOM content.
- App settings directly expose key/model/probe and advanced search settings, also accessible from screen settings. Changes affect subsequent searches and cancel in-flight work as before.
- Proposed bounds: model calls 3–12/default 5 including final answer; tool calls 4–48/default 12; HTTP catalog requests 10–120/default 40; model timeout 5–120/default 25 seconds; catalog timeout 3–60/default 10 seconds; overall timeout 30–600/default 90 seconds; results 1–10/default 10. Bounds are implementation choices; no retry or concurrency increase. Existing candidate/context/session caps remain.
- Diagnostics off by default; when enabled keep a local bounded journal (200 records, 120000 characters) and mirror sanitized records to the Lampa console. Record stage, hard filters, tool name/result, endpoint/host, allowlisted filter parameters, elapsed milliseconds, error/status, candidate exclusion reason, counters.
- Never record keys, auth, email, full URLs, prompts, model responses, free-text queries, reasons, or raw exceptions. Diagnostic serialization is schema allowlisted. Local journal survives reload. Clear/view/download/copy controls and native console entry. No automatic upload or added server.
## Verification
Node suite plus ES5/build reproducibility. Browser fixture must run actual fetched Lampa Scroll and Layer geometry at 1280x720 with a clipped activity, expanded filters, results and native button navigation; test modal .find contract. No claim of physical TV testing.
