# Candidate checks and rating filters

Approved in conversation: count unique candidates, check all available candidates before final AI selection, show passed base filters separately from passed rating and selected cards. Exclude examples and previously shown titles from counters. Never claim complete checks if requests/time limits interrupted them.

Filters: source imdb (default), kp, tmdb; minimum 0–10 with decimals, null disables. Form locks and natural language intent use the same validated schema. Unknown/missing/error ratings cannot pass. Never substitute sources. Refinement and More preserve filters.

Approaches: post-filtering final picks saves requests but hides candidate coverage; checking all candidates before final selection provides the requested coverage and is selected. Native direct requests and existing Lampa TMDB configuration remain; no backend.

IMDb: Agregarr bulk public API, resolve exact IMDb IDs through TMDB; no KP quota usage. KP: existing cr_api_key from poster plugin, exact IDs then strict unambiguous title/year/type fallback, independent configurable per-search cap (default 10). TMDB: vote_average only when explicit tmdb source. Cache successful ratings 24h, absent ratings 12h, never network errors. Catalog/ratings share existing concurrency and HTTP/time budgets. Stop and display incomplete verification on limits; no unverified cards.

Preserve ES5, standard native controls and poster lifecycle fix. Show live/final counters, source labels and separate missing/error counts. Keep all work on feature branch; merge/publish separately. Ignore ratings node_modules without removing files.
