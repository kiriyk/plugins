/* AI Picks 0.1.0 | Lampa 3.3.8 | Configure RouterAI in Lampa settings. */
"use strict";
(function() {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = function(cb, mod) {
    return function __require() {
      try {
        return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
      } catch (e) {
        throw mod = 0, e;
      }
    };
  };

  // src/transport.js
  var require_transport = __commonJS({
    "src/transport.js": function(exports, module) {
      "use strict";
      var messages = {
        auth: "API отклонил ключ или доступ.",
        balance: "Недостаточно средств на балансе RouterAI.",
        rate_limit: "Слишком много запросов. Повторите позже.",
        server: "Сервис временно недоступен.",
        network: "Не удалось подключиться к API.",
        timeout: "Время ожидания запроса истекло.",
        unsupported: "В этой версии Lampa нет нужного сетевого API.",
        invalid_arguments: "Некорректные параметры запроса.",
        invalid_response: "API вернул некорректный ответ."
      };
      function appError(code, status) {
        return { code: code, status: typeof status === "number" ? status : null, message: messages[code] || "Не удалось выполнить запрос." };
      }
      function normalizeError(raw) {
        var status = raw && Number(raw.status) || 0;
        var code = status === 401 || status === 403 ? "auth" : status === 402 ? "balance" : status === 429 ? "rate_limit" : status >= 500 ? "server" : "network";
        return appError(code, status || null);
      }
      function createTransport(Lampa, clock) {
        return function request(spec, done) {
          var settled = false, timer = null, network = null;
          function clear() {
            if (timer !== null) clock.clearTimeout(timer);
            if (network && network.clear) {
              try {
                network.clear();
              } catch (ignore) {
              }
            }
          }
          function finish(error, value) {
            if (settled) return;
            settled = true;
            clear();
            done(error, value);
          }
          function cancel() {
            if (!settled) {
              settled = true;
              clear();
            }
          }
          try {
            var Constructor = Lampa.Reguest || Lampa.Request;
            if (!Constructor) {
              finish(appError("unsupported"));
              return cancel;
            }
            network = new Constructor();
            if (typeof network.native !== "function") {
              finish(appError("unsupported"));
              return cancel;
            }
            if (!(spec.timeoutMs > 0)) {
              finish(appError("timeout"));
              return cancel;
            }
            var headers = {}, name, post = false;
            for (name in spec.headers) if (Object.prototype.hasOwnProperty.call(spec.headers, name)) headers[name] = spec.headers[name];
            if (spec.method === "POST") {
              post = JSON.stringify(spec.json);
              headers["Content-Type"] = "application/json";
            }
            timer = clock.setTimeout(function() {
              finish(appError("timeout"));
            }, spec.timeoutMs);
            network.native(spec.url, function(body) {
              finish(null, body);
            }, function(raw) {
              finish(normalizeError(raw));
            }, post, { headers: headers, attempts: 0, cache: false, timeout: spec.timeoutMs });
          } catch (ignore) {
            finish(appError("network"));
          }
          return cancel;
        };
      }
      module.exports = { createTransport: createTransport, appError: appError, normalizeError: normalizeError };
    }
  });

  // src/routerai.js
  var require_routerai = __commonJS({
    "src/routerai.js": function(exports, module) {
      "use strict";
      var net = require_transport();
      var appError = net.appError;
      var BASE = "https://routerai.ru/api/v1";
      function noop() {
      }
      function createRouterAI(options) {
        function send(spec, done) {
          return options.request(spec, function(error, value) {
            done(error ? error.code ? appError(error.code, error.status) : net.normalizeError(error) : null, value);
          });
        }
        function chat(args, done) {
          if (!args || typeof args.key !== "string" || !args.key.trim() || typeof args.model !== "string" || !args.model.trim() || !Array.isArray(args.messages)) {
            done(appError("invalid_arguments"));
            return noop;
          }
          var json = { model: args.model.trim(), messages: args.messages, max_tokens: 2048, stream: false };
          if (args.tools && args.tools.length) json.tools = args.tools;
          if (args.toolChoice) json.tool_choice = args.toolChoice;
          return send({
            url: BASE + "/chat/completions",
            method: "POST",
            json: json,
            headers: { Authorization: "Bearer " + args.key.trim() },
            timeoutMs: Math.min(args.timeoutMs || 25e3, 25e3)
          }, function(error, body) {
            if (error) return done(error);
            var raw = body && Array.isArray(body.choices) && body.choices[0] && body.choices[0].message;
            if (!raw || raw.content !== null && raw.content !== void 0 && typeof raw.content !== "string") return done(appError("invalid_response"));
            var calls = raw.tool_calls || [], seen = /* @__PURE__ */ Object.create(null), valid = Array.isArray(calls);
            if (!valid) return done(appError("invalid_response"));
            var normalized = [];
            calls.forEach(function(call) {
              var f = call && call.function;
              if (!call || typeof call.id !== "string" || !call.id || seen[call.id] || !f || typeof f.name !== "string" || typeof f.arguments !== "string") {
                valid = false;
                return;
              }
              seen[call.id] = true;
              normalized.push({ id: call.id, name: f.name, arguments: f.arguments });
            });
            if (!valid || !normalized.length && typeof raw.content !== "string") return done(appError("invalid_response"));
            done(null, { role: "assistant", content: typeof raw.content === "string" ? raw.content : null, tool_calls: normalized });
          });
        }
        function listModels(key, done) {
          if (typeof key !== "string" || !key.trim()) {
            done(appError("invalid_arguments"));
            return noop;
          }
          return send({ url: BASE + "/models", method: "GET", headers: { Authorization: "Bearer " + key.trim() }, timeoutMs: 1e4 }, function(error, body) {
            if (error) return done(error);
            if (!body || !Array.isArray(body.data)) return done(appError("invalid_response"));
            var seen = /* @__PURE__ */ Object.create(null);
            done(null, body.data.filter(function(model) {
              if (!model || typeof model.id !== "string" || !model.id || seen[model.id]) return false;
              seen[model.id] = true;
              var modalities = model.architecture && model.architecture.output_modalities;
              return !Array.isArray(modalities) || modalities.indexOf("text") >= 0;
            }).map(function(model) {
              return {
                id: model.id,
                name: typeof model.name === "string" ? model.name : model.id,
                supportsTools: Array.isArray(model.supported_parameters) && model.supported_parameters.indexOf("tools") >= 0
              };
            }));
          });
        }
        function probe(args, done) {
          var tool = { type: "function", function: {
            name: "connection_check",
            description: "Проверка вызова инструмента. Верните ok=true.",
            parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }
          } };
          return chat({
            key: args.key,
            model: args.model,
            messages: [{ role: "user", content: "Вызови connection_check с ok=true." }],
            tools: [tool],
            toolChoice: { type: "function", function: { name: "connection_check" } },
            timeoutMs: 25e3
          }, function(error, message) {
            if (error) return done(error);
            var call = message.tool_calls.length === 1 && message.tool_calls[0], data;
            try {
              data = call && JSON.parse(call.arguments);
            } catch (ignore) {
            }
            if (!call || call.name !== "connection_check" || !data || data.ok !== true || Object.keys(data).length !== 1) {
              var incompatible = appError("incompatible_model");
              incompatible.message = "Модель не выполнила проверочный вызов инструмента. Выберите другую модель.";
              return done(incompatible);
            }
            done(null, { ok: true });
          });
        }
        return { chat: chat, listModels: listModels, probe: probe };
      }
      module.exports = { createRouterAI: createRouterAI };
    }
  });

  // src/domain.js
  var require_domain = __commonJS({
    "src/domain.js": function(exports, module) {
      "use strict";
      function clone(value) {
        return JSON.parse(JSON.stringify(value));
      }
      function own(object, key) {
        return Object.prototype.hasOwnProperty.call(object || {}, key);
      }
      function positive(value) {
        return typeof value === "number" && isFinite(value) && value > 0 && Math.floor(value) === value && value <= 9007199254740991;
      }
      function titleKey(type, id) {
        return (type === "movie" || type === "tv") && positive(Number(id)) && /^\d+$/.test(String(id)) ? "tmdb:" + type + ":" + id : null;
      }
      function parseKey(key) {
        var match = /^tmdb:(movie|tv):([1-9]\d*)$/.exec(String(key || ""));
        return match && positive(Number(match[2])) ? { type: match[1], id: Number(match[2]) } : null;
      }
      function emptyFilters() {
        return { media: "movie", genres: { movie: { include: [], exclude: [] }, tv: { include: [], exclude: [] } }, yearMin: null, yearMax: null, countries: [], maxRuntimeMinutes: null };
      }
      function emptyIntent() {
        return { filters: emptyFilters(), preferences: [], examples: [] };
      }
      function merge(base, patch) {
        var out = clone(base), key;
        for (key in patch) if (own(patch, key) && key !== "__proto__" && key !== "constructor" && key !== "prototype") {
          if (patch[key] && typeof patch[key] === "object" && !Array.isArray(patch[key])) out[key] = merge(out[key] || {}, patch[key]);
          else out[key] = clone(patch[key]);
        }
        return out;
      }
      function normalizeTitle(raw, type) {
        if (!raw || !titleKey(type, raw.id)) return null;
        var date = type === "tv" ? raw.first_air_date : raw.release_date;
        var runtime = type === "tv" ? raw.episode_run_time : [raw.runtime];
        var knownRuntime = Array.isArray(runtime) && runtime.length && runtime.every(positive);
        var genreIds = Array.isArray(raw.genres) ? raw.genres.map(function(g) {
          return g.id;
        }) : raw.genre_ids;
        if (!Array.isArray(genreIds) || !genreIds.every(positive)) genreIds = null;
        var countries = Array.isArray(raw.production_countries) ? raw.production_countries.map(function(c) {
          return c.iso_3166_1;
        }) : null;
        if (countries && !countries.every(function(code) {
          return /^[A-Z]{2}$/.test(code);
        })) countries = null;
        var card = clone(raw);
        card.source = "tmdb";
        card.media_type = type;
        return {
          key: titleKey(type, raw.id),
          id: Number(raw.id),
          type: type,
          title: String(raw.title || raw.name || raw.original_title || raw.original_name || ""),
          originalTitle: String(raw.original_title || raw.original_name || ""),
          year: /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? Number(date.slice(0, 4)) : null,
          genreIds: genreIds,
          countries: countries,
          runtimeMinutes: knownRuntime ? Math.max.apply(Math, runtime) : null,
          overview: String(raw.overview || ""),
          card: card
        };
      }
      function resolveIntent(current, patch, form, dictionaries) {
        var next = merge(current || emptyIntent(), patch || {}), issues = [], f = next.filters;
        form = form || {};
        function conflict(value, locked, path) {
          Object.keys(locked).forEach(function(key) {
            if (locked[key] && typeof locked[key] === "object" && !Array.isArray(locked[key])) conflict(value && value[key] || {}, locked[key], path + key + ".");
            else if (value && own(value, key) && JSON.stringify(value[key]) !== JSON.stringify(locked[key])) issues.push("Текст и фильтр «" + path + key + "» противоречат друг другу.");
          });
        }
        conflict(patch && patch.filters || {}, form, "");
        next.filters = f = merge(f, form);
        if (["movie", "tv", "all"].indexOf(f.media) < 0) issues.push("Выберите фильмы, сериалы или всё.");
        ["yearMin", "yearMax", "maxRuntimeMinutes"].forEach(function(k) {
          if (f[k] !== null && !positive(f[k])) issues.push("Некорректное числовое ограничение: " + k);
        });
        if (f.yearMin !== null && f.yearMax !== null && f.yearMin > f.yearMax) issues.push("Начальный год больше конечного.");
        ["movie", "tv"].forEach(function(type) {
          var g = f.genres && f.genres[type];
          if (!g || !Array.isArray(g.include) || !Array.isArray(g.exclude)) {
            issues.push("Некорректные жанры.");
            return;
          }
          var known = dictionaries && dictionaries.genres && dictionaries.genres[type];
          g.include.concat(g.exclude).forEach(function(id) {
            if (!positive(id) || known && !known.some(function(x) {
              return x.id === id;
            })) issues.push("Жанр не поддерживается для выбранного формата.");
          });
          if (g.include.some(function(id) {
            return g.exclude.indexOf(id) >= 0;
          })) issues.push("Жанр одновременно включён и исключён.");
        });
        if (f.media === "all" && f.genres && f.genres.movie && f.genres.tv) {
          var mg = f.genres.movie, tg = f.genres.tv;
          if (!!(mg.include.length + mg.exclude.length) !== !!(tg.include.length + tg.exclude.length)) issues.push("Уточните жанры отдельно для фильмов и сериалов или выберите один формат.");
        }
        if (!Array.isArray(f.countries)) issues.push("Некорректный список стран.");
        else f.countries.forEach(function(code) {
          if (!/^[A-Z]{2}$/.test(code) || dictionaries && dictionaries.countries && !dictionaries.countries.some(function(x) {
            return x.code === code;
          })) issues.push("Неизвестная страна производства.");
        });
        if (!Array.isArray(next.preferences) || !next.preferences.every(function(x) {
          return typeof x === "string";
        })) issues.push("Некорректные пожелания.");
        if (!Array.isArray(next.examples) || next.examples.length > 3 || !next.examples.every(parseKey)) issues.push("Выберите до трёх примеров из каталога.");
        return { status: issues.length ? "clarify" : "ready", intent: next, issues: issues };
      }
      function validateCandidate(c, f) {
        function bad(reason) {
          return { ok: false, reason: reason };
        }
        if (!c || !parseKey(c.key) || !f) return bad("invalid");
        if (f.media !== "all" && c.type !== f.media) return bad("type");
        var genres = f.genres[c.type];
        if (genres.include.length || genres.exclude.length) {
          if (!c.genreIds) return bad("unknown_genres");
          if (genres.include.length && !genres.include.some(function(id) {
            return c.genreIds.indexOf(id) >= 0;
          })) return bad("genres");
          if (genres.exclude.some(function(id) {
            return c.genreIds.indexOf(id) >= 0;
          })) return bad("excluded_genres");
        }
        if (f.yearMin !== null && (c.year === null || c.year < f.yearMin)) return bad("year");
        if (f.yearMax !== null && (c.year === null || c.year > f.yearMax)) return bad("year");
        if (f.countries.length && (!c.countries || !f.countries.some(function(code) {
          return c.countries.indexOf(code) >= 0;
        }))) return bad("country");
        if (f.maxRuntimeMinutes !== null && (!positive(c.runtimeMinutes) || c.runtimeMinutes > f.maxRuntimeMinutes)) return bad("runtime");
        return { ok: true, reason: null };
      }
      function createCandidateStore(limit) {
        var records = /* @__PURE__ */ Object.create(null), keys = [];
        return {
          add: function(c) {
            if (!c || !parseKey(c.key)) return false;
            var old = records[c.key];
            if (!old) {
              if (keys.length >= limit) return false;
              keys.push(c.key);
              records[c.key] = clone(c);
              return true;
            }
            Object.keys(c).forEach(function(key) {
              if (c[key] !== null && c[key] !== "") old[key] = key === "card" ? merge(old.card, c.card) : clone(c[key]);
            });
            return true;
          },
          get: function(key) {
            return own(records, key) ? records[key] : null;
          },
          all: function() {
            return keys.map(function(key) {
              return records[key];
            });
          }
        };
      }
      module.exports = {
        clone: clone,
        own: own,
        positive: positive,
        titleKey: titleKey,
        parseKey: parseKey,
        emptyFilters: emptyFilters,
        emptyIntent: emptyIntent,
        merge: merge,
        normalizeTitle: normalizeTitle,
        resolveIntent: resolveIntent,
        validateCandidate: validateCandidate,
        createCandidateStore: createCandidateStore
      };
    }
  });

  // src/catalog.js
  var require_catalog = __commonJS({
    "src/catalog.js": function(exports, module) {
      "use strict";
      var domain = require_domain();
      var appError = require_transport().appError;
      function noop() {
      }
      function createCatalog(options) {
        var request = options.request, L = options.Lampa, language = options.language || "ru-RU";
        function invalid(done) {
          done(appError("invalid_arguments"));
          return noop;
        }
        function get(path, params, done) {
          var query = { api_key: L.TMDB && L.TMDB.key ? L.TMDB.key() : "", language: language, include_adult: false };
          if (!L.TMDB || !L.TMDB.api || !L.TMDB.key) {
            done(appError("unsupported"));
            return noop;
          }
          Object.keys(params || {}).forEach(function(key) {
            if (params[key] !== null && params[key] !== void 0 && params[key] !== "") query[key] = params[key];
          });
          var suffix = Object.keys(query).map(function(key) {
            return encodeURIComponent(key) + "=" + encodeURIComponent(query[key]);
          }).join("&");
          return request({ url: L.TMDB.api(path + "?" + suffix), method: "GET", headers: { Accept: "application/json" }, timeoutMs: 1e4 }, done);
        }
        function page(args) {
          return args.page === void 0 ? 1 : args.page;
        }
        function validPage(args) {
          return domain.positive(page(args)) && page(args) <= 500;
        }
        function typed(type) {
          return type === "movie" || type === "tv";
        }
        function batch(jobs, done) {
          if (!jobs.length) {
            done(null, []);
            return noop;
          }
          var active = true, left = jobs.length, values = [], cancels = [];
          jobs.forEach(function(job, index) {
            cancels.push(job(function(error, value) {
              if (!active) return;
              values[index] = { error: error, value: value };
              if (!--left) {
                active = false;
                done(null, values);
              }
            }));
          });
          return function() {
            active = false;
            cancels.forEach(function(cancel) {
              if (cancel) cancel();
            });
          };
        }
        function list(path, params, type, done) {
          return get(path, params, function(error, body) {
            if (error) return done(error);
            if (!body || !Array.isArray(body.results)) return done(appError("invalid_response"));
            done(null, { items: body.results.map(function(raw) {
              return domain.normalizeTitle(raw, type);
            }).filter(Boolean), hasMore: Number(body.total_pages) > Number(body.page || 1) });
          });
        }
        function searchTitles(args, done) {
          if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 500 || !validPage(args) || !(typed(args.type) || args.type === "all") || args.year !== void 0 && args.year !== null && !domain.positive(args.year)) return invalid(done);
          var types = args.type === "all" ? ["movie", "tv"] : [args.type];
          return batch(types.map(function(type) {
            return function(next) {
              var params = { query: args.query, page: page(args) };
              if (args.year) params[type === "tv" ? "first_air_date_year" : "year"] = args.year;
              return list("search/" + type, params, type, next);
            };
          }), function(unused, rows) {
            var error = rows.filter(function(row) {
              return row.error;
            })[0];
            if (error) return done(error.error);
            var items = [], max = Math.max.apply(Math, rows.map(function(row) {
              return row.value.items.length;
            }));
            for (var i = 0; i < max; i++) rows.forEach(function(row) {
              if (row.value.items[i]) items.push(row.value.items[i]);
            });
            done(null, { items: items, hasMore: rows.some(function(row) {
              return row.value.hasMore;
            }) });
          });
        }
        function discoverTitles(args, done) {
          if (!typed(args.type) || !validPage(args) || !args.filters || !Array.isArray(args.keywordIds || []) || !(args.keywordIds || []).every(domain.positive)) return invalid(done);
          var f = args.filters, g = f.genres && f.genres[args.type];
          if (!g || !Array.isArray(g.include) || !Array.isArray(g.exclude)) return invalid(done);
          var params = {
            page: page(args),
            sort_by: "popularity.desc",
            with_genres: g.include.join("|"),
            without_genres: g.exclude.join("|"),
            with_origin_country: f.countries.join("|"),
            with_keywords: (args.keywordIds || []).join("|"),
            "with_runtime.lte": f.maxRuntimeMinutes
          };
          var prefix = args.type === "tv" ? "first_air_date" : "primary_release_date";
          if (f.yearMin) params[prefix + ".gte"] = f.yearMin + "-01-01";
          if (f.yearMax) params[prefix + ".lte"] = f.yearMax + "-12-31";
          return list("discover/" + args.type, params, args.type, done);
        }
        function resolveKeywords(args, done) {
          if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 200 || !validPage(args)) return invalid(done);
          return get("search/keyword", { query: args.query, page: page(args) }, function(error, body) {
            if (error) return done(error);
            if (!body || !Array.isArray(body.results)) return done(appError("invalid_response"));
            done(null, { items: body.results.filter(function(x) {
              return domain.positive(x.id) && typeof x.name === "string";
            }).map(function(x) {
              return { id: x.id, name: x.name };
            }) });
          });
        }
        function getRelated(args, done) {
          var parsed = domain.parseKey(args.key);
          if (!parsed || ["recommendations", "similar"].indexOf(args.relation) < 0 || !validPage(args)) return invalid(done);
          return list(parsed.type + "/" + parsed.id + "/" + args.relation, { page: page(args) }, parsed.type, done);
        }
        function getTitleDetails(args, done) {
          if (!Array.isArray(args.keys) || args.keys.length > 10 || !args.keys.every(domain.parseKey)) return invalid(done);
          return batch(args.keys.map(function(key) {
            return function(next) {
              var parsed = domain.parseKey(key);
              return get(parsed.type + "/" + parsed.id, {}, function(error, raw) {
                if (error) return next(error);
                var c = domain.normalizeTitle(raw, parsed.type);
                if (!c || c.key !== key) return next(appError("invalid_response"));
                next(null, c);
              });
            };
          }), function(unused, rows) {
            var result = [], errors = [];
            rows.forEach(function(row, i) {
              if (row.error) errors.push({ key: args.keys[i], code: row.error.code });
              else result.push(row.value);
            });
            if (!result.length && errors.length) return done(rows[0].error || appError("network"));
            result.errors = errors;
            done(null, result);
          });
        }
        function getDictionaries(done) {
          var paths = ["genre/movie/list", "genre/tv/list", "configuration/countries"];
          return batch(paths.map(function(path) {
            return function(next) {
              return get(path, {}, next);
            };
          }), function(unused, rows) {
            var failed = rows.filter(function(row) {
              return row.error;
            })[0];
            if (failed) return done(failed.error);
            if (!rows[0].value || !Array.isArray(rows[0].value.genres) || !rows[1].value || !Array.isArray(rows[1].value.genres) || !Array.isArray(rows[2].value)) return done(appError("invalid_response"));
            function genres(body) {
              return body.genres.filter(function(x) {
                return domain.positive(x.id) && typeof x.name === "string";
              }).map(function(x) {
                return { id: x.id, name: x.name };
              });
            }
            done(null, { genres: { movie: genres(rows[0].value), tv: genres(rows[1].value) }, countries: rows[2].value.filter(function(x) {
              return /^[A-Z]{2}$/.test(x.iso_3166_1);
            }).map(function(x) {
              return { code: x.iso_3166_1, name: x.native_name || x.english_name || x.iso_3166_1 };
            }) });
          });
        }
        return { getDictionaries: getDictionaries, searchTitles: searchTitles, resolveKeywords: resolveKeywords, discoverTitles: discoverTitles, getRelated: getRelated, getTitleDetails: getTitleDetails };
      }
      module.exports = { createCatalog: createCatalog };
    }
  });

  // src/settings.js
  var require_settings = __commonJS({
    "src/settings.js": function(exports, module) {
      "use strict";
      function escapeText(value) {
        return String(value).replace(/[&<>"']/g, function(c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
      }
      function registerSettings(options) {
        var L = options.Lampa, alive = true, revision = 0, cancels = [];
        function notify(message) {
          if (L.Noty) L.Noty.show(message);
        }
        function getConfig() {
          try {
            return { key: String(L.Storage.get("aip_api_key", "") || ""), model: String(L.Storage.get("aip_model", "") || "") };
          } catch (ignore) {
            return { key: "", model: "" };
          }
        }
        function save(name, value) {
          if (!alive) return;
          try {
            L.Storage.set(name, String(value).trim());
            revision++;
            cancels.forEach(function(cancel) {
              if (cancel) cancel();
            });
            cancels = [];
            if (options.onChange) options.onChange(getConfig());
          } catch (ignore) {
            notify("Не удалось сохранить настройки. Проверьте свободное место в хранилище Lampa.");
          }
        }
        function restore(name) {
          if (L.Controller) L.Controller.toggle(name || "content");
        }
        function input(title, name, password, origin) {
          var config = getConfig();
          L.Input.edit({ title: title, value: name === "aip_api_key" ? config.key : config.model, password: !!password, nosave: true, free: true }, function(value) {
            if (alive) {
              save(name, String(value || "").slice(0, password ? 4096 : 200));
              restore(origin);
            }
          });
        }
        function models(origin) {
          var config = getConfig(), generation = revision;
          if (!config.key.trim()) {
            notify("Сначала введите ключ RouterAI.");
            return;
          }
          function show(error, values) {
            if (!alive || generation !== revision) return;
            var items = (values || []).filter(function(model) {
              return model.supportsTools;
            }).map(function(model) {
              return { title: escapeText(model.name), subtitle: escapeText(model.id), value: model.id };
            });
            items.push({ title: "Ввести ID модели", value: "manual" });
            if (error) notify("Не удалось загрузить список моделей. Можно ввести ID вручную.");
            L.Select.show({ title: "Модель RouterAI", items: items, onSelect: function(item) {
              if (item.value === "manual") input("ID модели RouterAI", "aip_model", false, origin);
              else {
                save("aip_model", item.value);
                restore(origin);
              }
            }, onBack: function() {
              restore(origin);
            } });
          }
          cancels.push(options.routerai.listModels(config.key, show));
        }
        function probe() {
          var config = getConfig(), generation = revision;
          if (!config.key.trim() || !config.model.trim()) {
            notify("Введите ключ RouterAI и выберите модель.");
            return;
          }
          notify("Проверяем подключение. Выполняется запрос к ИИ.");
          cancels.push(options.routerai.probe(config, function(error) {
            if (!alive || generation !== revision) return;
            notify(error ? error.message || "Не удалось проверить подключение." : "Подключение работает. Модель поддерживает поиск через инструменты.");
          }));
        }
        function open() {
          if (!alive) return;
          var config = getConfig(), origin = L.Controller.enabled().name;
          L.Select.show({ title: "ИИ-подборки · RouterAI", items: [
            { title: "Ключ RouterAI", subtitle: config.key ? "Задан на этом устройстве" : "Не задан", value: "key" },
            { title: "Модель", subtitle: escapeText(config.model || "Выберите модель с инструментами"), value: "model" },
            { title: "Проверить подключение", subtitle: "Короткий платный запрос к выбранной модели", value: "probe" }
          ], onSelect: function(item) {
            if (item.value === "key") input("Ключ RouterAI", "aip_api_key", true, origin);
            else if (item.value === "model") models(origin);
            else probe();
          }, onBack: function() {
            restore(origin);
          } });
        }
        if (L.SettingsApi) {
          L.SettingsApi.addComponent({ component: "aip_settings", name: "ИИ-подборки", icon: "" });
          L.SettingsApi.addParam({
            component: "aip_settings",
            param: { name: "aip_setup", type: "button" },
            field: { name: "Настроить RouterAI", description: "Ключ, модель и проверка подключения" },
            onRender: function(item) {
              item.on("hover:enter", open);
            }
          });
        }
        return { getConfig: getConfig, open: open, destroy: function() {
          alive = false;
          revision++;
          cancels.forEach(function(cancel) {
            if (cancel) cancel();
          });
        } };
      }
      module.exports = { registerSettings: registerSettings, escapeText: escapeText };
    }
  });

  // src/ui.js
  var require_ui = __commonJS({
    "src/ui.js": function(exports, module) {
      "use strict";
      var d = require_domain();
      var escapeText = require_settings().escapeText;
      function createScreen(options) {
        var L = options.Lampa, doc = options.document || document, nav = options.navigator || L.Navigator;
        var root = doc.createElement("section"), scroll = new L.Scroll({ mask: true, over: true });
        var query = "", form = {}, examples = [], dictionaries = null, busy = false, alive = true, lastFocus = null, cancels = [], created = false;
        root.className = "aip-picks";
        root.setAttribute("aria-label", "ИИ-подборки");
        function elem(tag, cls, text) {
          var e = doc.createElement(tag);
          if (cls) e.className = cls;
          if (text) e.textContent = text;
          return e;
        }
        function focus() {
          if (!alive) return;
          L.Controller.toggle("aip_picks");
          L.Controller.collectionSet(root, false, true);
          L.Controller.collectionFocus(lastFocus, root, true);
        }
        function button(action, label, fn, cls) {
          var e = elem("button", "selector aip-control" + (cls ? " " + cls : ""), label);
          e.type = "button";
          e.setAttribute("data-action", action);
          e.addEventListener("hover:focus", function() {
            lastFocus = e;
            scroll.update(e, true);
          });
          e.addEventListener("hover:enter", function() {
            if (!alive || e.disabled) return;
            lastFocus = e;
            fn();
          });
          return e;
        }
        function notify(message) {
          if (L.Noty) L.Noty.show(message);
        }
        function edit(title, value, callback) {
          L.Input.edit({ title: title, value: String(value || ""), free: true, nosave: true }, function(text) {
            if (alive) {
              callback(String(text || "").trim());
              focus();
            }
          });
        }
        function select(title, items, callback, onCheck) {
          L.Select.show({
            title: title,
            items: items,
            nohide: !!onCheck,
            onSelect: function(item) {
              if (alive) {
                callback(item);
                update();
                focus();
              }
            },
            onCheck: onCheck ? function(item) {
              if (alive) {
                onCheck(item);
                update();
              }
            } : void 0,
            onBack: focus
          });
        }
        var heading = elem("div", "aip-heading");
        heading.appendChild(elem("h1", "aip-title", "Что посмотреть?"));
        heading.appendChild(elem("p", "aip-intro", "Опишите настроение, сюжет или фильм, на который хочется что-то похожее."));
        heading.appendChild(button("settings", "Настройки ИИ", function() {
          options.onSettings();
        }, "aip-settings"));
        root.appendChild(heading);
        var queryButton = button("query", "", function() {
          edit("Что хотите посмотреть?", query, function(value) {
            query = value.slice(0, 2e3);
            update();
          });
        }, "aip-query");
        root.appendChild(queryButton);
        var exampleSection = elem("div", "aip-examples"), exampleList = elem("div", "aip-example-list");
        exampleSection.appendChild(elem("h2", "aip-label", "Похожие на"));
        exampleSection.appendChild(exampleList);
        exampleSection.appendChild(button("example", "Добавить фильм или сериал", function() {
          if (examples.length >= 3) {
            notify("Можно выбрать до трёх примеров.");
            return;
          }
          edit("Найти фильм или сериал", "", function(value) {
            if (!value) return;
            cancels.push(options.catalog.searchTitles({ query: value, type: "all" }, function(error, result) {
              if (!alive) return;
              if (error) {
                notify(error.message);
                return;
              }
              if (!result.items.length) {
                notify("По этому названию ничего не найдено. Попробуйте другое.");
                return;
              }
              select("Выберите пример", result.items.slice(0, 20).map(function(c) {
                return { title: escapeText(c.title), subtitle: escapeText((c.year || "Год неизвестен") + " · " + (c.type === "tv" ? "Сериал" : "Фильм")), value: c.key, candidate: c };
              }), function(item) {
                if (examples.length < 3 && !examples.some(function(c) {
                  return c.key === item.value;
                })) examples.push(item.candidate);
              });
            }));
          });
        }, "aip-secondary"));
        root.appendChild(exampleSection);
        var filterToggle = button("filters", "Добавить условия", function() {
          filtersBox.hidden = !filtersBox.hidden;
          filterToggle.setAttribute("aria-expanded", String(!filtersBox.hidden));
          focus();
        }, "aip-secondary");
        filterToggle.setAttribute("aria-expanded", "false");
        root.appendChild(filterToggle);
        var filtersBox = elem("div", "aip-filters");
        filtersBox.hidden = true;
        var formatButton = button("format", "", function() {
          select("Формат", [{ title: "Фильмы", value: "movie" }, { title: "Сериалы", value: "tv" }, { title: "Фильмы и сериалы", value: "all" }], function(item) {
            form.media = item.value;
          });
        });
        filtersBox.appendChild(formatButton);
        function numberControl(action, label, key, year) {
          return button(action, label, function() {
            edit(label, form[key], function(value) {
              if (!value) delete form[key];
              else if (/^[1-9]\d*$/.test(value) && (!year || value.length === 4) && Number(value) <= (year ? 9999 : 1e4)) form[key] = Number(value);
              else notify(year ? "Введите год четырьмя цифрами или очистите поле." : "Введите длительность в минутах или очистите поле.");
              update();
            });
          });
        }
        var yearMin = numberControl("year-min", "Год от", "yearMin", true), yearMax = numberControl("year-max", "Год до", "yearMax", true);
        var runtime = numberControl("runtime", "Длительность до, минут", "maxRuntimeMinutes", false);
        filtersBox.appendChild(yearMin);
        filtersBox.appendChild(yearMax);
        filtersBox.appendChild(runtime);
        function requireDictionaries(callback) {
          if (dictionaries) callback();
          else {
            notify("Загружаем фильтры каталога…");
            cancels.push(options.catalog.getDictionaries(function(error, value) {
              if (!alive) return;
              if (error) notify(error.message);
              else {
                dictionaries = value;
                callback();
              }
            }));
          }
        }
        function genreControl(action, title, type, exclude) {
          return button(action, title, function() {
            requireDictionaries(function() {
              if (!form.genres) form.genres = d.emptyFilters().genres;
              var key = exclude ? "exclude" : "include", ids = form.genres[type][key];
              select(title, dictionaries.genres[type].map(function(g) {
                return { title: escapeText(g.name), value: g.id, checkbox: true, checked: ids.indexOf(g.id) >= 0 };
              }), function() {
              }, function(item) {
                var at = ids.indexOf(item.value);
                if (item.checked && at < 0) ids.push(item.value);
                else if (!item.checked && at >= 0) ids.splice(at, 1);
              });
            });
          });
        }
        filtersBox.appendChild(genreControl("movie-genres", "Жанры фильмов", "movie", false));
        filtersBox.appendChild(genreControl("movie-exclude", "Исключить жанры фильмов", "movie", true));
        filtersBox.appendChild(genreControl("tv-genres", "Жанры сериалов", "tv", false));
        filtersBox.appendChild(genreControl("tv-exclude", "Исключить жанры сериалов", "tv", true));
        filtersBox.appendChild(button("countries", "Страны производства", function() {
          requireDictionaries(function() {
            if (!form.countries) form.countries = [];
            select("Страны производства", dictionaries.countries.map(function(c) {
              return { title: escapeText(c.name), value: c.code, checkbox: true, checked: form.countries.indexOf(c.code) >= 0 };
            }), function() {
            }, function(item) {
              var at = form.countries.indexOf(item.value);
              if (item.checked && at < 0) form.countries.push(item.value);
              else if (!item.checked && at >= 0) form.countries.splice(at, 1);
            });
          });
        }));
        filtersBox.appendChild(button("reset", "Сбросить условия", function() {
          form = {};
          update();
        }));
        root.appendChild(filtersBox);
        var summary = elem("p", "aip-summary"), status = elem("p", "aip-status");
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        root.appendChild(summary);
        var actions = elem("div", "aip-actions"), submit = button("submit", "Подобрать", function() {
          if (busy) return;
          if (!query.trim() && !Object.keys(form).length && !examples.length) {
            notify("Опишите пожелание, добавьте условие или фильм-пример.");
            return;
          }
          var resolved = d.resolveIntent(d.emptyIntent(), { filters: form }, {}, dictionaries);
          if (resolved.status !== "ready") {
            notify(resolved.issues[0]);
            return;
          }
          options.onSubmit(getRequest("new"));
        }, "aip-primary");
        var cancel = button("cancel", "Отменить поиск", function() {
          options.onCancel();
          setStage("cancelled");
        });
        cancel.hidden = true;
        actions.appendChild(submit);
        actions.appendChild(cancel);
        root.appendChild(actions);
        root.appendChild(status);
        var resultHost = elem("div", "aip-result-host");
        root.appendChild(resultHost);
        function update() {
          queryButton.textContent = query || "Например: лёгкое кино на вечер, без романтики";
          queryButton.classList.toggle("aip-query--filled", !!query);
          formatButton.textContent = "Формат: " + { movie: "Фильмы", tv: "Сериалы", all: "Фильмы и сериалы" }[form.media || "movie"];
          yearMin.textContent = "Год от: " + (form.yearMin || "любой");
          yearMax.textContent = "Год до: " + (form.yearMax || "любой");
          runtime.textContent = (form.media === "tv" ? "Длительность серии" : form.media === "all" ? "Длительность фильма / серии" : "Длительность фильма") + ": " + (form.maxRuntimeMinutes ? "до " + form.maxRuntimeMinutes + " мин" : "любая");
          summary.textContent = Object.keys(form).length ? "Заданные условия обязательны. Распознанные пожелания появятся в подборке." : "Условия можно сочетать с текстом и примерами.";
          exampleList.textContent = "";
          examples.forEach(function(c) {
            exampleList.appendChild(button("remove-example", c.title + (c.year ? " · " + c.year : "") + " · Убрать", function() {
              examples = examples.filter(function(x) {
                return x.key !== c.key;
              });
              update();
              focus();
            }, "aip-example"));
          });
        }
        function getRequest(mode) {
          return { query: query, formFilters: d.clone(form), examples: d.clone(examples), mode: mode || "new" };
        }
        function setStage(value) {
          busy = ["parsing", "searching", "ranking"].indexOf(value) >= 0;
          submit.disabled = busy;
          submit.setAttribute("aria-disabled", String(busy));
          cancel.hidden = !busy;
          status.textContent = { parsing: "Разбираем запрос…", searching: "Ищем фильмы…", ranking: "Выбираем варианты…", cancelled: "Поиск отменён." }[value] || "";
          root.setAttribute("aria-busy", String(busy));
          if (busy) {
            lastFocus = cancel;
            focus();
          }
        }
        scroll.append(root);
        update();
        return {
          create: function() {
            if (!created) {
              created = true;
            }
            return scroll.render();
          },
          render: function() {
            return scroll.render();
          },
          element: function() {
            return root;
          },
          resultsHost: function() {
            return resultHost;
          },
          getRequest: getRequest,
          setStage: setStage,
          setMessage: function(text) {
            status.textContent = text;
          },
          applyIntent: function(intent) {
            form = d.clone(intent.filters);
            update();
          },
          start: function() {
            L.Controller.add("aip_picks", {
              toggle: function() {
                L.Controller.collectionSet(root, false, true);
                L.Controller.collectionFocus(lastFocus, root, true);
              },
              up: function() {
                if (nav) nav.move("up");
              },
              down: function() {
                if (nav) nav.move("down");
              },
              left: function() {
                if (nav) nav.move("left");
              },
              right: function() {
                if (nav) nav.move("right");
              },
              back: function() {
                options.onCancel();
                L.Activity.backward();
              }
            });
            focus();
          },
          stop: function() {
            options.onCancel();
          },
          destroy: function() {
            alive = false;
            options.onCancel();
            cancels.forEach(function(cancelRequest) {
              if (cancelRequest) cancelRequest();
            });
            scroll.destroy();
          }
        };
      }
      module.exports = { createScreen: createScreen };
    }
  });

  // src/index.js
  var require_index = __commonJS({
    "src/index.js": function(exports, module) {
      var createTransport = require_transport().createTransport;
      var createRouterAI = require_routerai().createRouterAI;
      var createCatalog = require_catalog().createCatalog;
      var registerSettings = require_settings().registerSettings;
      var createScreen = require_ui().createScreen;
      function registerPlugin(options) {
        var win = options.window, L = options.Lampa, doc = win.document;
        if (win.__aipPicksPlugin) return win.__aipPicksPlugin;
        if (!L || !L.Component || !L.Storage || !L.Controller || !L.Scroll) return null;
        var clock = { now: function() {
          return Date.now();
        }, setTimeout: function(fn, ms) {
          return win.setTimeout(fn, ms);
        }, clearTimeout: function(id) {
          win.clearTimeout(id);
        } };
        var request = createTransport(L, clock), routerai = createRouterAI({ request: request }), catalog = createCatalog({ request: request, Lampa: L });
        var settings = registerSettings({ Lampa: L, routerai: routerai, onChange: function() {
        } });
        function open() {
          L.Activity.push({ url: "", component: "aip_picks", title: "ИИ-подборки", source: "tmdb", page: 1 });
        }
        L.Component.add("aip_picks", function() {
          return createScreen({
            Lampa: L,
            document: doc,
            navigator: win.Navigator,
            catalog: catalog,
            onSubmit: function() {
            },
            onCancel: function() {
            },
            onSettings: settings.open
          });
        });
        var menu = doc.querySelector(".menu .menu__list");
        if (menu) {
          var item = doc.createElement("li");
          item.className = "menu__item selector aip-menu";
          item.setAttribute("role", "button");
          item.setAttribute("tabindex", "0");
          var text = doc.createElement("div");
          text.className = "menu__text";
          text.textContent = "ИИ-подборки";
          item.appendChild(text);
          item.addEventListener("hover:enter", open);
          menu.appendChild(item);
        }
        if (!doc.getElementById("aip-style")) {
          var style = doc.createElement("style");
          style.id = "aip-style";
          style.textContent = true ? ".aip-picks{padding:1.8em 2em 4em;color:inherit;font-family:inherit;max-width:76em}\n.aip-picks *{box-sizing:border-box}\n.aip-picks [hidden]{display:none!important}\n.aip-picks .aip-heading{position:relative;margin-bottom:1.7em;padding-right:12em}\n.aip-picks .aip-title{font-size:2.1em;line-height:1.18;font-weight:600;margin:0 0 .35em}\n.aip-picks .aip-intro{max-width:48em;line-height:1.5;opacity:.8;margin:0}\n.aip-picks .aip-control{font:inherit;color:inherit;text-align:left;cursor:pointer;line-height:1.4;border:0;border-radius:.6em;padding:.8em 1.1em;background:rgba(255,255,255,.08);min-height:2.8em;transition:background .15s ease-out,color .15s ease-out}\n.aip-picks .aip-control.focus,.aip-picks .aip-control:focus,.aip-picks .aip-control:hover{background:#fff;color:#151515;outline:2px solid #fff;outline-offset:2px}\n.aip-picks .aip-control:disabled{opacity:.45;cursor:default;outline:none}\n.aip-picks .aip-settings{position:absolute;right:0;top:0}\n.aip-picks .aip-query{width:100%;min-height:6em;padding:1.2em 1.4em;font-size:1.15em;line-height:1.5;white-space:normal;overflow-wrap:break-word;margin-bottom:1.6em}\n.aip-picks .aip-query:not(.aip-query--filled){color:#c4c4c4}\n.aip-picks .aip-query:not(.aip-query--filled).focus,.aip-picks .aip-query:not(.aip-query--filled):focus,.aip-picks .aip-query:not(.aip-query--filled):hover{color:#333}\n.aip-picks .aip-examples{margin-bottom:1.25em}\n.aip-picks .aip-label{font-size:1em;font-weight:600;margin:0 0 .65em}\n.aip-picks .aip-example-list{display:flex;flex-wrap:wrap}\n.aip-picks .aip-example{margin:0 .6em .6em 0}\n.aip-picks .aip-filters{display:flex;flex-wrap:wrap;margin-top:.8em}\n.aip-picks .aip-filters .aip-control{margin:0 .6em .6em 0}\n.aip-picks .aip-summary{font-size:.88em;line-height:1.5;opacity:.78;margin:1em 0 1.4em}\n.aip-picks .aip-actions{display:flex;flex-wrap:wrap}\n.aip-picks .aip-actions .aip-control{margin:0 .7em .7em 0}\n.aip-picks .aip-primary{background:#fff;color:#151515;font-weight:600;min-width:11em;text-align:center}\n.aip-picks .aip-status{min-height:1.5em;line-height:1.5;margin:.7em 0 0;max-width:65ch}\n.aip-picks .aip-result-host{margin-top:2em}\n@media(max-width:700px){.aip-picks{padding:1.2em 1em 3em}.aip-picks .aip-heading{padding-right:0}.aip-picks .aip-settings{position:static;margin-top:.8em}.aip-picks .aip-title{font-size:1.7em}.aip-picks .aip-query{font-size:1em}.aip-picks .aip-filters .aip-control{width:100%;margin-right:0}}\n@media(prefers-reduced-motion:reduce){.aip-picks .aip-control{transition:none}}\n" : "";
          doc.head.appendChild(style);
        }
        win.__aipPicksPlugin = { open: open, settings: settings };
        return win.__aipPicksPlugin;
      }
      function boot(win) {
        if (win.__aipPicksBoot) return;
        win.__aipPicksBoot = true;
        if (win.appready) registerPlugin({ window: win, Lampa: win.Lampa });
        else if (win.Lampa && win.Lampa.Listener) win.Lampa.Listener.follow("app", function(event) {
          if (event.type === "ready") registerPlugin({ window: win, Lampa: win.Lampa });
        });
      }
      if (typeof window !== "undefined") boot(window);
      module.exports = { registerPlugin: registerPlugin };
    }
  });
  require_index();
})();
