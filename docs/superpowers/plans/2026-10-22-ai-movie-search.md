# AI Movie Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Создать самостоятельный плагин «ИИ-подборки» для Lampa с прямым доступом к RouterAI, поиском через инструменты и настоящими карточками TMDB.

**Architecture:** ИИ вызывает только разрешённые функции плагина; плагин выполняет каталожные запросы, проверяет ограничения и возвращает модели данные. Контроллер ограничивает цикл поиска, а интерфейс Lampa показывает результаты и поддерживает уточнение. Общий backend, история и сторонние CORS-прокси отсутствуют.

**Tech Stack:** Node.js 20+ для разработки; JavaScript ES5/CommonJS в runtime-модулях, callbacks; node:test, LinkeDOM, Acorn; esbuild для одного IIFE-файла. В runtime используются Lampa 3.3.8, её jQuery, TMDB и Reguest.

**Spec:** `docs/superpowers/specs/2026-10-22-ai-movie-search-design.md` — одобрена пользователем 2026-10-22.

## Global Constraints

- Работать в `/Users/k.kuverin/.codex/worktrees/016f/LampaPlugins`, ветка `feat/ai-movie-search`; существующий плагин рейтингов не изменять.
- Основные среды — приложение Lampa на Android TV и Lampa в браузере. Tizen/webOS — дополнительная цель после проверки основных сред.
- Первый ИИ-провайдер — RouterAI. Базовый адрес `https://routerai.ru/api/v1` встроен в плагин.
- Runtime не требует Node.js или npm. Цель выходного JavaScript — ES5 с совместимыми API, без обязательных современных браузерных примитивов.
- До трёх фильмов или сериалов-примеров, выбранных из поиска каталога.
- Результат — до 10 карточек за один запуск. Лимит сессии — 200 уникальных показанных карточек.
- До 5 обращений к ИИ: максимум 4 раунда с инструментами и одно завершающее обращение без инструментов. Финальное обращение входит в общий предел.
- До 12 вызовов инструментов, до 4 в одном раунде. Неизвестные и некорректные вызовы тоже расходуют лимит.
- До 80 уникальных кандидатов, до 40 HTTP-запросов к каталогу, включая детали и словари. Не больше 3 запросов к каталогу одновременно.
- Один ответ инструмента содержит до 20 карточек; запрос деталей — до 10 известных ID. Описания сокращаются до 500 символов на карточку.
- Не больше 60 000 символов нормализованных данных каталога в одном запросе к модели.
- Не больше 90 секунд на запуск, до 25 секунд на отдельное обращение к RouterAI и до 10 секунд на запрос каталога. Индивидуальные таймауты ограничиваются остатком общего времени.
- Максимум ответа модели — 2048 токенов за обращение.
- Поля формы обязательны; конфликт текста и формы требует уточнения. Неизвестное значение не подтверждает обязательное условие. Фильтры автоматически не ослаблять.
- Платный POST автоматически повторно не отправлять. Модель незаметно не заменять.
- Только один запуск активен; поздние ответы отменённых запусков не меняют UI. Ключ хранить локально, не включать в промпт, собственные журналы, экспорт или Git.
- История, оценки пользователя и исключение просмотренного появятся позднее через отдельный плагин истории. В первой версии их не запрашиваем и не имитируем.

## Review Focus

1. Одинаковый числовой ID movie и tv, локализованное и оригинальное название: тип не теряется при поиске, исключениях и открытии карточки. Тесты задач 2, 3, 8.
2. Разные словари жанров movie/tv, пустые метаданные, страна против языка: неподтверждаемое ограничение не считается выполненным. Тесты задач 2, 3, 5.
3. Уточнение или смена модели одновременно с поздним ответом, включая открытый выбор примера: старый запуск не публикует результат и не списывает результат в новую сессию. Тесты задач 6, 8.
4. Параллельные инструменты, вложенные запросы деталей и повторённые tool_call ID: лимиты считают реальную работу, ответ не выполняет платную операцию повторно. Тесты задач 1, 5, 6.
5. HTML и инструкции в описании фильма, длинный кириллический текст, сбой записи Storage: интерфейс остаётся управляемым, данные не исполняются, ключ не утекает в ошибку. Тесты задач 4, 5, 7, 8.

---

## Контекст репозитория и подтверждённые контракты

В репозитории есть только `lampa-catalog-ratings/`: IIFE, node:test, LinkeDOM и Acorn. Новая функциональность размещается рядом, а не в этом плагине.

Исследованы исходники `yumata/lampa-source`, commit `71733ed81f4b13ac1ed1b3328cbbaa7e01afdbd2`, Manifest 3.3.8:

- `src/app.js` экспортирует `Lampa.TMDB`, `Reguest`, `Component`, `Activity`, `Controller`, `Maker`, `Scroll` и `Router`.
- `Lampa.TMDB.api(relativePath)` учитывает настроенный в Lampa доступ/прокси TMDB; `Lampa.TMDB.key()` предоставляет ключ. Не копировать значение ключа из исходников.
- `new Lampa.Reguest().native(url, ok, fail, post, params)` выбирает Android-транспорт на Android, в браузере — обычный запрос. JSON передаётся сериализованной строкой, `Content-Type` и авторизация — через `params.headers`. Явно задавать `attempts: 0`, `cache: false`, `timeout`.
- `Reguest.clear()` убирает callbacks, но не обещает физический abort HTTP-запроса. Отмена должна также инвалидировать запуск и игнорировать поздние ответы.
- `Lampa.Api.sources.tmdb.get()` может запускать скрытые запросы проверки релизов и использует общий network. Его не использовать как транспорт подбора: отдельные Reguest-экземпляры и собственная очередь сохраняют счётчик 40 и изоляцию отмены.
- `Lampa.Component.add(name, constructor)`, `Activity.push(...)`, контроллеры и `.selector`/`hover:enter` используются для собственного экрана. Меню добавляется после appready.
- Страница карточки: `Activity.push({component:'full', id, method:'movie'|'tv', card, source:'tmdb', url:'', page:1})`. Тип передаётся явно: Router full выводит тип из original_name, что ненадёжно при неполных данных.

Ссылки: [Lampa app](https://github.com/yumata/lampa-source/blob/71733ed81f4b13ac1ed1b3328cbbaa7e01afdbd2/src/app.js), [Reguest](https://github.com/yumata/lampa-source/blob/71733ed81f4b13ac1ed1b3328cbbaa7e01afdbd2/src/utils/reguest.js), [TMDB](https://github.com/yumata/lampa-source/blob/71733ed81f4b13ac1ed1b3328cbbaa7e01afdbd2/src/core/tmdb/tmdb.js), [TMDB source](https://github.com/yumata/lampa-source/blob/71733ed81f4b13ac1ed1b3328cbbaa7e01afdbd2/src/core/api/sources/tmdb.js), [навигация](https://github.com/yumata/lampa-source/blob/71733ed81f4b13ac1ed1b3328cbbaa7e01afdbd2/docs/ru/07-navigation.md), [RouterAI tools](https://routerai.ru/docs/guides/overview/parameters), [esbuild](https://esbuild.github.io/api/#target).

## Структура файлов

Все перечисленные файлы создаются внутри `lampa-ai-picks/`, если не указан другой путь:

| Файл | Ответственность |
| --- | --- |
| `package.json`, `package-lock.json`, `.gitignore` | Локальные инструменты, команды и исключение node_modules |
| `src/transport.js` | Изолированный JSON-транспорт, таймаут, нормализованные ошибки |
| `src/domain.js` | Карточки, условия, проверка, ограниченное хранилище кандидатов |
| `src/session.js` | Намерение и исключения текущей сессии |
| `src/catalog.js` | Разрешённые TMDB-запросы и нормализация данных |
| `src/routerai.js` | Список моделей, chat и probe RouterAI |
| `src/tools.js`, `src/prompts.js` | Контракты инструментов, выполнение, контекст и финальный ответ |
| `src/budget.js`, `src/controller.js` | Счётчики, очередь, жизненный цикл и оркестрация |
| `src/settings.js`, `src/ui.js`, `src/results.js`, `src/index.js` | Настройки, конструктор, результаты и регистрация |
| `src/styles.css` | CSS только под корневым классом плагина |
| `scripts/build.cjs`, `scripts/check.cjs` | Сборка IIFE с CSS внутри JS, проверка ES5 |
| `tests/helpers.cjs`, `tests/fixtures.cjs` | Детерминированные часы, транспорт, Lampa и данные |
| `tests/{transport,domain,session,catalog,routerai,tools,prompts,budget,controller,settings,ui,results,integration,bundle}.test.cjs` | Проверки по обязанностям |
| `docs/compatibility.md`, `docs/acceptance.md`, `README.md` | Контракты платформ, фактические результаты проверок, установка |
| `ai-picks.js` | Собранный устанавливаемый файл, включаемый в Git |

## Общие интерфейсы

Это JSDoc-контракты ES5-модулей CommonJS, а не предложение добавить TypeScript или runtime-зависимости.

- `Cancel = function() -> void`; идемпотентен. Все асинхронные методы возвращают Cancel и используют `done(error, value)` не более одного раза.
- `Clock = {now(), setTimeout(fn, ms), clearTimeout(id)}`; внедряется во все таймауты.
- `AppError = {code: string, status: number|null, message: string}`; сообщения контролируемые, без сырого ответа или ключа.
- `Request = function({url, method:'GET'|'POST', json?:Object, headers:Object, timeoutMs:number}, done) -> Cancel`.
- `TitleKey = 'tmdb:movie:<positive integer>' | 'tmdb:tv:<positive integer>'`.
- `Filters = {media:'movie'|'tv'|'all', genres:{movie:{include:number[],exclude:number[]},tv:{include:number[],exclude:number[]}}, yearMin:number|null, yearMax:number|null, countries:string[], maxRuntimeMinutes:number|null}`. Жанры — реальные ID соответствующего типа, страны — ISO-коды производства. Для множественного выбора включённых жанров используется OR, исключённых — запрет любого, стран — OR.
- `Intent = {filters:Filters, preferences:string[], examples:TitleKey[]}`. Явная форма передаётся отдельно как `formFilters`; unspecified-поля формы не блокируют условия из текста.
- `Candidate = {key:TitleKey,id:number,type:'movie'|'tv',title:string,originalTitle:string,year:number|null,genreIds:number[]|null,countries:string[]|null,runtimeMinutes:number|null,overview:string,card:Object}`. Для tv runtime — максимум известных длительностей серии; неизвестные значения — null. Для runtime-фильтра нулевое значение считается неизвестным.
- `Clarification = {kind:'example'|'filters',query:string|null,options:Candidate[],issues:string[]}`; ответ пользователя — `{kind:'example',key:TitleKey}` или `{kind:'filters',formFilters:Filters}`. Выбранный пример обязан принадлежать options текущего запроса.
- `Pick = {key:TitleKey, reason:string}`; `Result = {items:Array<{candidate:Candidate,reason:string}>, partial:boolean, notice:string|null}`.
- Стадии контроллера: `idle`, `parsing`, `searching`, `ranking`, `clarification`, `done`, `error`, `cancelled`.
- Тестовый `createHarness()` из `tests/helpers.cjs` возвращает `clock`, `advance(ms)`, `Lampa`, `request:Request`, `requests`, `nativeRequests`, `reply(i,body)`, `reject(i,error)`, `nativeReply(i,body)`, `nativeReject(i,error)`, `logs`. `requests` фиксирует RequestSpec, `nativeRequests` — `{url,post,params}` и внутренние callbacks. Ни один тест по умолчанию не обращается в сеть.
- `tests/fixtures.cjs` экспортирует `filters(overrides)`, `intent(overrides)`, `movie(overrides)`, `tv(overrides)` с полными валидными значениями; movie и tv по умолчанию имеют ID 1 и разные ключи. Шаблоны ответов RouterAI находятся там же.

## Порядок выполнения и проверки

Выполнять последовательно: интерфейсы задач зависят друг от друга. Перед каждой задачей читать её и общий контракт. Для production-кода: тест → подтверждённый RED по ожидаемой причине → реализация → GREEN → один коммит. Код тестовых helpers допустимо написать вместе с первым тестом. Не считать опечатку или отсутствие установленного test runner доказательством RED.

Команды задач выполняются из `lampa-ai-picks/`, кроме явно указанных. npm-зависимости фиксируются `--save-exact` и package-lock при первой установке; не брать версии наугад. Исходники runtime писать сразу на ES5: esbuild не является полным транспайлером современного JavaScript в ES5.

### Task 1: Изолированный транспорт и проверяемый контракт платформы

**Files:** Create `package.json`, `package-lock.json`, `.gitignore`, `src/transport.js`, `tests/helpers.cjs`, `tests/transport.test.cjs`, `docs/compatibility.md`.

**Interfaces:** Produces `createTransport(Lampa, clock) -> Request` из `src/transport.js` и `createHarness()` из helpers; consumes Lampa.Reguest.native/clear. В compatibility зафиксировать исследованный commit и таблицу Browser/Android/Tizen/webOS со статусом `NOT RUN` для реальных проверок.

- [x] **Step 1: Написать тесты транспорта и fake Lampa/clock.** `test('sends one JSON POST and suppresses late reply after cancel')` проверяет сериализованное тело, заголовки и единственность вызова. Добавить тесты timeout, двойного callback, ошибки без status и отсутствия native. Основные assertions:

```js
assert.equal(h.nativeRequests.length, 1);
assert.equal(h.nativeRequests[0].params.attempts, 0);
assert.equal(h.nativeRequests[0].params.cache, false);
assert.equal(h.nativeRequests[0].params.headers['Content-Type'], 'application/json');
cancel(); h.nativeReply(0, {ok: true});
assert.equal(replies.length, 0);
```

- [x] **Step 2: Подтвердить RED.** Создать package с `test: node --test tests/*.test.cjs`; выполнить `node --test tests/transport.test.cjs`. Ожидается FAIL из-за отсутствующего `src/transport.js`, а не из-за helper.
- [x] **Step 3: Реализовать createTransport.** Выделять Reguest на запрос, JSON.stringify один раз, GET без post_data, timeout через clock. Нормализовать ошибки, не логировать тело/заголовки. clear и token запуска подавляют поздние callbacks; физический abort не обещается. Сохранить в compatibility точный локальный порядок ранней проверки native и browser JSON POST с минимальным forced tool-вызовом RouterAI. Ввести ключ и модель локально в консоли/интерфейсе самой Lampa, не в чате и не в диагностическом выводе. Выполнить пробу в доступных основных средах до остальных runtime-компонентов; при отсутствии ключа/устройства оставить NOT RUN, продолжить офлайн-задачи и повторить пробу перед приёмкой. Сырой curl не заменяет эту проверку.
- [x] **Step 4: GREEN.** `node --test tests/transport.test.cjs`: все тесты PASS, после advance не остаются timers, один сбой POST не вызывает повторной отправки.
- [x] **Step 5: Коммит.** Добавить только файлы задачи; `git commit -m "feat: add isolated Lampa JSON transport"`.

### Task 2: Нормализация, обязательные условия и сессия

**Files:** Create `src/domain.js`, `src/session.js`, `tests/fixtures.cjs`, `tests/domain.test.cjs`, `tests/session.test.cjs`.

**Interfaces:** Produces `normalizeTitle(raw,type)->Candidate`, `resolveIntent(current,patch,formFilters,dictionaries)->{status:'ready'|'clarify',intent,issues}`, `validateCandidate(candidate,filters)->{ok,reason}`, `createCandidateStore(limit)->{add(candidate),get(key),all()}`, `createSession()->{reset(intent),getIntent(),getShown(),size(),commit(items)}`. `commit(items)` возвращает принятые items с учётом остатка 200 и не забывает старые ID.

- [x] **Step 1: Написать тесты domain/session.** Тест `rejects unknown runtime and preserves movie-tv identity` использует fixtures:

```js
assert.notEqual(movie().key, tv().key);
assert.equal(validateCandidate(movie({runtimeMinutes: null}), filters({maxRuntimeMinutes: 120})).ok, false);
assert.equal(validateCandidate(movie({runtimeMinutes: 120}), filters({maxRuntimeMinutes: 120})).ok, true);
assert.equal(validateCandidate(movie({runtimeMinutes: 121}), filters({maxRuntimeMinutes: 120})).ok, false);
```

Проверить конфликт текста/формы, minYear > maxYear, пустые метаданные против известных пустых массивов, страну производства против original_language, несовместимые жанры movie/tv, merge только явно изменённых полей. Store сохраняет 80 уникальных ключей, детали дополняют существующую запись без потери известных значений. Сессия с 195 показанными принимает только 5 новых из 10; с 200 не принимает новых и не удаляет старые.
- [x] **Step 2: RED.** `node --test tests/domain.test.cjs tests/session.test.cjs`: отсутствуют domain/session exports.
- [x] **Step 3: Реализовать объявленные функции.** Пределы и null-семантика — из спецификации. resolveIntent возвращает clarification вместо угадывания при конфликте или непредставимом в словаре ограничении. При формате «Всё» запрет жанра, не представленного для одного типа, нельзя молча считать проверенным для этого типа: требуется уточнение формата/условия. Сессия хранит только намерение и показанные ключи, без истории просмотров и ключа API.
- [x] **Step 4: GREEN.** `node --test tests/domain.test.cjs tests/session.test.cjs`: PASS, граничные 80/200 и явные конфликты проверены.
- [x] **Step 5: Коммит.** `git commit -m "feat: add validated search intent and selection session"`.

### Task 3: Каталог TMDB через доступ Lampa

**Files:** Create `src/catalog.js`, `tests/catalog.test.cjs`; extend helpers/fixtures каталожными ответами.

**Interfaces:** `createCatalog({request:Request,Lampa,language}) -> {getDictionaries(done),searchTitles({query,year,type,page},done),resolveKeywords({query,page},done),discoverTitles({type,filters,keywordIds,page},done),getRelated({key,relation:'recommendations'|'similar',page},done),getTitleDetails({keys},done)}`. Листы возвращают `{items:Candidate[],hasMore:boolean}`; словари `{genres:{movie:Array<{id,name}>,tv:Array<{id,name}>},countries:Array<{code,name}>}`; keywords — `{items:Array<{id,name}>}`; details — Candidate[]. Каждый внутренний HTTP проходит только через внедрённый request.

- [x] **Step 1: Написать тесты запросов и ответов.** Тест `preserves configured TMDB route and rejects malformed title types`:

```js
assert.match(h.requests[0].url, /^https:\/\/configured-tmdb\.example\//);
assert.match(h.requests[0].url, /search\/movie/);
assert.ok(h.requests[0].url.includes(encodeURIComponent('Остров проклятых')));
assert.equal(result.items[0].key, 'tmdb:movie:1');
assert.equal(result.items[0].card.source, 'tmdb');
```

Добавить тесты без original_name у tv, multitype поиска и смешанных ID, фильтров discover, реальных словарей, неизвестных/нулевых runtime, tv episode_run_time=[40,60] → 60, production_countries вместо языка, частичных details. Проверить: ошибка сети не становится пустым успешным ответом; произвольный URL/тип/path в метод не проходит; каждый details-запрос виден в h.requests.
- [x] **Step 2: RED.** `node --test tests/catalog.test.cjs`: отсутствует createCatalog.
- [x] **Step 3: Реализовать адаптер.** Строить allowlist путей `search/movie`, `search/tv`, `search/keyword`, `discover/movie`, `discover/tv`, `{type}/{id}/{relation}`, `{type}/{id}`, `genre/{type}/list`, `configuration/countries`. URL — через Lampa.TMDB.api и key(), язык — Storage tmdb_lang, query — encodeURIComponent. Оба типа запрашиваются отдельно, page ограничивается положительным целым. include_adult=false. Обогащение runtime/countries — явными details-запросами, не скрытым full/get Lampa. Нельзя вводить новый фиксированный минимум рейтинга или числа голосов: пользователь его не задавал.
- [x] **Step 4: GREEN.** `node --test tests/catalog.test.cjs`: PASS. Пока проверка реальной Lampa не выполнена, compatibility сохраняет NOT RUN, а не PASS.
- [x] **Step 5: Коммит.** `git commit -m "feat: add TMDB candidate search adapter"`.

### Task 4: RouterAI и реальная проверка tool calling

**Files:** Create `src/routerai.js`, `tests/routerai.test.cjs`; extend fixtures.

**Interfaces:** `createRouterAI({request:Request})->{listModels(key,done),chat({key,model,messages,tools,toolChoice,timeoutMs},done),probe({key,model},done)}`. listModels возвращает `{id,name,supportsTools}[]` только текстовых моделей. chat возвращает нормализованное сообщение `{role:'assistant',content:string|null,tool_calls:Array<{id,name,arguments:string}>}`. probe принимает только ожидаемый вызов `connection_check` с аргументом `{ok:true}`.

- [x] **Step 1: Написать тесты формата и ошибок.** Тест `probe requires actual tool call and never retries a paid POST`:

```js
assert.equal(h.requests[0].url, 'https://routerai.ru/api/v1/chat/completions');
assert.equal(h.requests[0].json.max_tokens, 2048);
assert.equal(h.requests[0].json.stream, false);
assert.equal(h.requests[0].headers.Authorization, 'Bearer test-key');
h.reject(0, {status: 429});
assert.equal(h.requests.length, 1);
assert.equal(resultError.code, 'rate_limit');
```

Отдельно проверить probe: обычный текст вместо tool call — несовместимость, ожидаемый вызов — успех; каталог моделей с/без tools; пустой choices, invalid arguments JSON, HTTP 401/402/403/429/5xx, timeout; ключ отсутствует в logs и контролируемом тексте ошибки.
- [x] **Step 2: RED.** `node --test tests/routerai.test.cjs`: отсутствует createRouterAI.
- [x] **Step 3: Реализовать adapter.** GET `/models`, POST `/chat/completions`, Bearer. Строить параметры OpenAI tools/function, не включать response_format json_schema, пока выбранный endpoint его не подтверждает; финальный JSON всё равно валидируется локально. Для probe использовать один минимальный запрос с forced connection_check и тем же пределом ответа, без второго платного запроса. Не делать автоматической подмены модели и повторного POST.
- [x] **Step 4: GREEN.** `node --test tests/routerai.test.cjs`: PASS. Реальный ключ здесь не нужен и в тесты не добавляется.
- [x] **Step 5: Коммит.** `git commit -m "feat: add RouterAI chat and tool capability probe"`.

### Task 5: Контракты инструментов, намерение и ограниченный контекст

**Files:** Create `src/tools.js`, `src/prompts.js`, `tests/tools.test.cjs`, `tests/prompts.test.cjs`.

**Interfaces:** `createTools({catalog,store,formFilters,dictionaries,intent,onClarification})->{definitions(),execute(call,done),getIntent()}`; call из Task 4. `buildMessages({query,intent,formFilters,examples,shown,candidates,trace})->Message[]`; trace — завершённые assistant tool_calls и ответы tool с tool_call_id. `parseFinal(content,store,filters,shown)->Result` принимает JSON `{picks:[{key,reason}]}` и возвращает не больше 10 валидных рекомендаций.

- [x] **Step 1: Написать тесты инструментов и контекста.** `does not execute invented ids and limits details to ten known ids`:

```js
assert.equal(unknownIdError.code, 'unknown_title');
assert.equal(tooManyDetailsError.code, 'invalid_arguments');
assert.equal(catalogCalls.length, 0);
assert.equal(parseFinal(JSON.stringify({picks:[{key:'tmdb:movie:999',reason:'x'}]}), store, filters(), []).items.length, 0);
```

Проверить все шесть инструментов, invalid JSON/unknown name, повтор call.id без повторного запроса, keyword ID без resolveKeywords, поиск до set_search_intent, ambiguous example, ограничение 20 items, overview 501 → 500 символов. В prompts проверить отсутствие ключа, сохранение пар tool_call/result при сокращении, ≤60 000 символов каталожных данных, кириллицу, описания с инструкциями как данные. В final проверить дубли, tv/movie, runtime, HTML, пустой список, отсутствие reason и ограничение двух коротких предложений.
- [x] **Step 2: RED.** `node --test tests/tools.test.cjs tests/prompts.test.cjs`: отсутствуют exports.
- [x] **Step 3: Реализовать инструменты и prompt.** Аргументы строго соответствуют Task 3; set_search_intent принимает patch Intent. search_titles дополнительно имеет purpose:'candidate'|'example'; неоднозначность example вызывает onClarification с найденными карточками. До подтверждённого намерения каталожные вызовы отклоняются. details и related принимают только известные store/examples ключи; keywords — только полученные ранее ID. Лимитировать результат до передачи модели. Сокращать trace только целыми закрытыми парами, оставляя системные условия и текущие кандидаты; незакрытые вызовы не терять. parseFinal повторно проверяет обязательные условия и shown, сохраняет порядок модели, отвергает некорректный JSON целиком и отбрасывает отдельные неизвестные ID. Причину отображать текстом; слишком длинную ограничить 300 символами без добавления новых фактов.
- [x] **Step 4: GREEN.** `node --test tests/tools.test.cjs tests/prompts.test.cjs`: PASS; никаких HTTP для отклонённых аргументов.
- [x] **Step 5: Коммит.** `git commit -m "feat: add bounded movie search tools and grounded prompts"`.

### Task 6: Цикл поиска, бюджет и отмена

**Files:** Create `src/budget.js`, `src/controller.js`, `tests/budget.test.cjs`, `tests/controller.test.cjs`.

**Interfaces:** `createBudget({clock,request:Request})->{catalogRequest:Request,remainingMs(),consumeModel(),consumeTool(),snapshot(),cancel()}`; remainingMs возвращает number ≥0, consumeModel/consumeTool — boolean разрешения, snapshot — `{modelCalls,toolCalls,catalogRequests,activeCatalog}`. Количество кандидатов проверяется контроллером через store; сетевые и tool-счётчики увеличиваются до отправки/валидации. `createController({Lampa,request,routerai,session,clock,onEvent})->{start({query,formFilters,examples,key,model,mode:'new'|'more'|'refine'}),resolveClarification(choice),cancel(),getState()}`. start и resolveClarification возвращают новый числовой runId (или null при отказе запуска), cancel — void; getState возвращает `{runId,stage}`. onEvent принимает `{type:'stage'|'clarification'|'result'|'error',runId,data}`; key остаётся только в закрытом состоянии запуска.

- [x] **Step 1: Написать state-machine тесты с fake clock.** `reserves the fifth model call for finalization and never exceeds catalog budget`:

```js
assert.ok(h.modelCalls.length <= 5);
assert.equal(h.modelCalls.at(-1).toolChoice, 'none');
assert.ok(h.toolExecutions <= 12);
assert.ok(h.catalogRequests.length <= 40);
assert.ok(h.maxCatalogConcurrency <= 3);
assert.ok(h.candidateCount <= 80);
```

Добавить границы: 4 инструмента за раунд, invalid/unknown calls расходуют лимит, обработка лишних calls без выполнения, повторённый call.id возвращает прежний ответ без сети, таймауты 90 000/25 000/10 000 с учётом остатка. Проверить финал раньше пятого, исправление финального JSON внутри общего лимита, каталог с частичным сбоем, пустой пул без бессмысленного final, HTTP 402/429, отмену queued и in-flight, смену модели и поздний ответ. Вся готовая подборка коммитится в session один раз; ошибка или отмена не добавляют shown.
- [x] **Step 2: RED.** `node --test tests/budget.test.cjs tests/controller.test.cjs`: отсутствуют budget/controller.
- [x] **Step 3: Реализовать очередь и контроллер.** Создавать per-run catalog с request=budget.catalogRequest и tools из Task 5. Первый модельный вызов требует set_search_intent; далее разрешены инструменты до предела четырёх раундов, затем toolChoice=none. Дать tool-ответ каждому call.id, включая отклонённые, прежде чем продолжать диалог. Не выполнять >12 calls и >4/раунд; переполнение возвращает контролируемую ошибку. Финал после раннего завершения проверяется тем же parseFinal. При clarification приостановить/завершить активный бюджет; ответ пользователя начинает новый бюджет с сохранённым запросом и выбранным примером, без повторной публикации старого runId. Уточнение сохраняет неизменённые поля; more включает все shown. При timeout без готового финала не показывать сырые кандидаты как ИИ-выбор.
- [x] **Step 4: GREEN.** `node --test tests/budget.test.cjs tests/controller.test.cjs`: PASS; отдельная проверка с fake clock на 90 001 мс не запускает новой сети. `npm test`: PASS всех написанных задач.
- [x] **Step 5: Коммит.** `git commit -m "feat: orchestrate bounded AI catalog search"`.

### Task 7: Настройки RouterAI, регистрация и конструктор Lampa

**Files:** Create `src/settings.js`, `src/ui.js`, `src/index.js`, `src/styles.css`, `scripts/build.cjs`, `scripts/check.cjs`, `tests/settings.test.cjs`, `tests/ui.test.cjs`, `tests/bundle.test.cjs`; modify package/lock и helpers для DOM. Create `ai-picks.js` сборкой.

**Interfaces:** `registerSettings({Lampa,routerai,onChange})->{getConfig(),open(),destroy()}`, config `{key,model}`; Storage keys `aip_api_key`, `aip_model`. `createScreen({Lampa,catalog,onSubmit,onCancel,onSettings})->LampaComponent`; onSubmit получает `{query,formFilters,examples,mode}`. `registerPlugin({Lampa,window,$})` регистрирует один `aip_picks` компонент и один пункт меню. На этом этапе результаты заменяются тестовым onSubmit, реальная связь — Task 8.

- [x] **Step 1: Установить dev-инструменты и написать тесты.** `npm install --save-dev --save-exact esbuild acorn@8.15.0 linkedom@0.18.14`; это локальные инструменты, не runtime-зависимости. Создать DOM-harness без сети. `test('registers once and accepts filters-only requests with keyboard focus')`:

```js
assert.equal(menuItems.length, 1);
assert.equal(componentRegistrations.length, 1);
assert.equal(submissions.length, 1);
assert.equal(submissions[0].query, '');
assert.equal(submissions[0].formFilters.maxRuntimeMinutes, 120);
```

Дополнительно: пустой запрос блокируется, пример без текста запускается, четвёртый пример не добавляется, раскрытие фильтров и Back возвращают фокус, сериал подписывает длительность серии. Settings: список tools-моделей и ручной ID, скрытый ввод ключа, запись Storage может бросить исключение — значение не объявляется сохранённым и экран остаётся доступным. probe не запускается при каждом открытии настроек. Повторный appready не дублирует меню и listeners.
- [x] **Step 2: RED.** `node --test tests/settings.test.cjs tests/ui.test.cjs tests/bundle.test.cjs`: FAIL для отсутствующих компонентов/артефакта, не для зависимостей.
- [x] **Step 3: Реализовать настройки и экран.** Нативная визуальная система Lampa, .selector и hover:enter; Text/Select/Modal для ввода. Использовать методы create/start/stop/destroy/render, закрытие отменяет подбор, навигация временно к карточке сохраняет сессию. Сначала API key/model, затем конструктор. Статусы: «Разбираем запрос», «Ищем фильмы», «Выбираем варианты». CSS ограничить `.aip-picks`. build.cjs собирает ES5/CommonJS index в IIFE `ai-picks.js`, CSS встраивается строкой; target=es5, platform=browser, bundle=true. check.cjs проверяет Acorn ecmaVersion:5 и `node --check`, bundle.test загружает файл в VM без require/module/Promise/fetch/Map/Set/AbortController. Добавить scripts build/check и pretest build. Не использовать esbuild для понижения ES2015 classes/const/let: runtime-исходники уже ES5.
- [x] **Step 4: GREEN.** `npm run build`, `npm run check`, `node --test tests/settings.test.cjs tests/ui.test.cjs tests/bundle.test.cjs`: PASS; bundle не требует npm на устройстве. Проверить фокус вручную в локальном DOM-preview; поведение настоящей Lampa подтверждается отдельно.
- [x] **Step 5: Коммит.** `git commit -m "feat: add Lampa AI picks settings and request constructor"`.

### Task 8: Карточки, объяснения и уточнения в работающем потоке

**Files:** Create `src/results.js`, `tests/results.test.cjs`, `tests/integration.test.cjs`; modify `src/index.js`, `src/ui.js`, `src/styles.css`, helpers и пересобрать `ai-picks.js`.

**Interfaces:** `createResults({Lampa,onMore,onRefine,onOpen})->{render(result,intent),element(),destroy()}`; onOpen получает Candidate. index связывает settings, session, catalog, RouterAI и controller. На фокусе карточки отдельная доступная клавиатурой/пультом кнопка «Почему предложен» открывает Modal. Для карточек использовать штатный контракт Lampa 3.3.8: `Lampa.Maker.make('Card', clonedCard)`, `instance.use({onEnter, onFocus})`, `instance.create()`, `instance.render()` (jQuery) или `render(true)` (DOM), после добавления вызвать visible(), при удалении destroy(). Эти методы подтверждены `src/interaction/maker.js`, `src/interaction/card/base.js` и `src/core/module/callback.js` на указанном commit; зафиксировать именно их в helper. В обработчике onEnter использовать Candidate из замыкания и явный type.

- [x] **Step 1: Написать тесты полного потока на fake API.** `test('refinement preserves year and late previous run never changes results')`:

```js
assert.equal(currentIntent.filters.yearMin, 2000);
assert.deepEqual(renderedKeys, expectedNewKeys);
assert.equal(shownKeys.includes(cancelledRunKey), false);
assert.equal(openParams.component, 'full');
assert.equal(openParams.method, 'tv');
assert.equal(openParams.source, 'tmdb');
```

Проверить текст-only, фильтры-only и пример-only; показать до 10 результатов, modal explanation без hover, HTML в reason остаётся текстом. More исключает movie/tv по составному ключу, старые карточки сохраняются до успеха уточнения. Back/stop/destroy, открытие карточки и возвращение, повторный appready, ошибки 401/402/429, clarification выбора примера и конфликт условий, достижение 200 shown. Сбой API не очищает старую подборку и ввод.
- [x] **Step 2: RED.** `node --test tests/results.test.cjs tests/integration.test.cjs`: отсутствует renderer/связь onEvent с экраном.
- [x] **Step 3: Реализовать результаты и wiring.** Использовать настоящие catalog card и явный type при Activity.push(full). Сохранять текущий фокус перед модалом и восстанавливать после закрытия. Объяснение — plain text, максимум два коротких предложения/300 символов. onMore/onRefine запускают controller с новым runId и соответствующим mode; settings onChange отменяет старый запуск. Формулировки состояния не показывают tool JSON, токены и внутренние ID. При 0 — предложение изменить условия, при частичном результате — понятное сообщение. Не добавлять UI для истории.
- [x] **Step 4: GREEN.** `npm test`, `npm run check`: PASS; bundle и DOM-integration проверяют связанный поток и реальные структурные контракты Lampa, без внешней сети.
- [x] **Step 5: Коммит.** `git commit -m "feat: show grounded AI picks and refine selections"`.

### Task 9: Приёмка, инструкция установки и готовность артефакта

**Files:** Create `README.md`, `docs/acceptance.md`; update `docs/compatibility.md`, package scripts при необходимости и финальный `ai-picks.js`. Изменения кода только по обнаруженным дефектам с отдельным regression RED/GREEN.

**Interfaces:** Один устанавливаемый `lampa-ai-picks/ai-picks.js`; README описывает локальный ключ, выбор tools-модели, тест подключения, формат длительности серии, ограничения подбора и обычную установку по URL JS. Публикация/деплой отдельной командой сюда не входят.

- [x] **Step 1: Зафиксировать checklist приёмки.** Пять сценариев из spec §9 плюс тест реального tool-вызова и discovery через настроенный TMDB. Для каждого записать среду, Manifest, app/browser version, модель, результат PASS/FAIL/NOT RUN и причину. Никогда не записывать ключ. Нет устройства или ключа — NOT RUN, а не предполагаемый PASS.
- [x] **Step 2: Выполнить чистую локальную проверку.** Из `lampa-ai-picks/`: `npm ci`, `npm test`, `npm run check`. Из корня: `git diff --check`. PASS — все автоматические тесты, Acorn ES5 и синтаксис; ai-picks.js воспроизводится той же сборкой без diff. Из `lampa-catalog-ratings/` один раз `npm ci`, `npm test`, `npm run check` как итоговая проверка сосуществования; при провале установить, является ли он исходной проблемой или регрессией, а не менять чужой плагин автоматически.
- [ ] **Step 3: Проверить настоящую Lampa в браузере.** NOT RUN: рабочего ключа и целевой Lampa в среде нет. Ключ пользователь вводит локально в настройки; выполнить probe и все приёмочные сценарии с клавиатурой, открытием карточки и отменой. Сетевую доступность оценивать с origin самой Lampa; успешный curl не доказывает browser CORS. Не подменять эту проверку fake API/локальным DOM-preview.
- [ ] **Step 4: Проверить Android TV с пультом.** NOT RUN: устройство не подключено. Те же сценарии и native JSON/tool вызов, навигация Back и восстановление фокуса. Tizen/webOS — отдельные необязательные строки. Если Android недоступен исполнителю, подготовить воспроизводимые шаги для пользователя и явно оставить аппаратную проверку NOT RUN; техническую реализацию можно завершить, подтверждённую готовность Android заявлять нельзя.
- [x] **Step 5: Сохранить результаты и выполнить финальную проверку.** `npm test`, `npm run check`, `git diff --check` после исправлений; проверить отсутствие случайного ключа и runtime-зависимостей. `git commit -m "docs: document AI picks setup and acceptance results"`. Итоговый отчёт различает готовый JS, автоматические проверки и реальные платформы. Не публиковать сайт, не пушить и не сливать ветку в рамках этого плана.

## Проверка покрытия спецификации

| Требование | Задачи |
| --- | --- |
| Согласованный сценарий, отсутствие backend/истории | 1, 7, 8, 9 |
| Прямой RouterAI, key/model/probe/errors | 1, 4, 6, 7, 9 |
| Фильтры, формат, до 3 примеров, неоднозначность | 2, 3, 5, 7, 8 |
| Поиск, keywords/discovery/related/details, grounded final | 3, 5, 6 |
| Строгие условия, неизвестные поля, tv duration/countries | 2, 3, 5 |
| Все численные бюджеты, отмена, поздние ответы | 1, 2, 5, 6 |
| Карточки, объяснения, more/refine, session 200 | 2, 6, 8 |
| ES5 single JS, сосуществование, инструкции | 7, 9 |
| Тесты, реальные Android/browser, дополнительные TV | 1–9, финальная приёмка 9 |

## Передача на исполнение

План подготовлен для самостоятельного исполнения основным агентом по `superpowers:executing-plans`; это рекомендуемый вариант, поскольку транспорт, типы, tools и controller тесно связаны. Альтернатива — отдельный исполнитель и проверяющий для каждой задачи через `superpowers:subagent-driven-development`, если пользователь выберет этот метод. До выбора метода sub-agents не запускать.

Пользователь должен прочитать этот план и выбрать способ исполнения. Одобрение спецификации разрешило написание плана, но не заменяет проверку ещё не существовавшего плана. После проверки выполнить задачи в существующем worktree, не создавать другой. Реальный API key не запрашивать в чате: он вводится локально при приёмке.
