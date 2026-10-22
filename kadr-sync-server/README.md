# KADR Sync — сервер истории просмотров

Хранит историю просмотров KADR и плагина Lampa по профилям: позиции, статусы, предпочтения источника, конфликты между устройствами. Видео не проксирует и не хранит.

## Запуск

1. DNS-имя направить на сервер, открыть порты 80 и 443.
2. `cp .env.example .env` и указать `KADR_DOMAIN`.
3. `docker compose up -d --build`.

## Профили

Один ключ — один профиль. Одинаковый ключ на устройствах даёт общую историю.

```bash
docker compose exec kadr-sync python -m kadr_sync.cli create-profile "Кирилл"   # ключ показывается один раз
docker compose exec kadr-sync python -m kadr_sync.cli rotate-key "Кирилл"       # новый ключ, история сохраняется
docker compose exec kadr-sync python -m kadr_sync.cli revoke-key "Кирилл"       # ключ и выданные launch-токены перестают действовать
docker compose exec kadr-sync python -m kadr_sync.cli set-threshold "Кирилл" 90 # порог «просмотрено», %
docker compose exec kadr-sync python -m kadr_sync.cli list-profiles
```

Ключ вводится в настройках плагина Lampa. Не размещайте ключи в URL, репозиториях и сообщениях.

## Резервное копирование

```bash
docker compose exec kadr-sync python -m kadr_sync.cli backup /data/backup-$(date +%F).sqlite3
docker compose cp kadr-sync:/data/backup-$(date +%F).sqlite3 ./
```

Копия создаётся средствами SQLite и согласована даже во время работы. Для восстановления также нужны `.env` и `Caddyfile`. Восстановление: `docker compose stop kadr-sync`, скопировать файл копии в том как `/data/kadr.sqlite3`, `docker compose start kadr-sync`.

## API v1

Все маршруты требуют `Authorization: Bearer <ключ>`.

| Маршрут | Назначение |
| --- | --- |
| `GET /v1/profile` | проверить ключ, получить имя и настройки |
| `GET /v1/history?filter=continue\|all&limit&offset` | история; `continue` — по одной записи на фильм/сериал |
| `GET /v1/changes?cursor=` | изменения после курсора, включая удаления и конфликты |
| `POST /v1/playbacks` | зарегистрировать запуск; возвращает launch-токен для KADR |
| `GET /v1/playbacks/{id}` | состояние запуска (`next_requested`) |
| `POST /v1/events` | пакет событий `progress`, `status`, `delete`, `prefs`, `next_requested` |
| `GET /v1/conflicts/{id}` | варианты конфликта |
| `POST /v1/conflicts/{id}/resolve` | выбрать вариант (`current` или `playback`) для известной версии |

Launch-токен (`kadrl_…`, 12 часов) разрешает только события `progress` и `next_requested` своего запуска.

## Разработка

```bash
uv sync
uv run pytest
```
