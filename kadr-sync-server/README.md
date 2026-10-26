# KADR Sync — сервер истории просмотров

Хранит историю просмотров KADR и плагина Lampa по профилям: позиции, статусы, предпочтения источника, конфликты между устройствами. Видео не проксирует и не хранит.

## Запуск

1. DNS-имя направить на сервер, открыть порты 80 и 443.
2. `cp .env.example .env` и указать `KADR_DOMAIN`.
3. `docker compose up -d --build`.

## Запуск на своём сервере по IP, без домена и сертификата

Для случая, когда домена нет, а порты 80 и 443 уже заняты (например, на сервере работает Caddy с сайтом). Сервис слушает отдельный порт, по умолчанию 8090, и доступен как `http://<IP сервера>:8090`. Работающий Caddy не затрагивается.

> **Без HTTPS ключи и токены просмотра идут по сети открытым текстом.** Их может увидеть любой, кто способен перехватить трафик между телевизором и сервером: провайдер, владелец публичного Wi-Fi. Для домашнего использования это допустимый компромисс на время. Ограничьте доступ к порту и при появлении домена переходите на HTTPS (см. конец раздела).

Все команды выполняются на сервере, подключившись по SSH: `ssh user@<IP сервера>`.

1. Проверить Docker:

   ```bash
   docker compose version
   ```

   Если команды нет — установить Docker официальным скриптом: `curl -fsSL https://get.docker.com | sh`. Затем выйти из SSH и зайти снова.

2. Скачать код и выбрать порт:

   ```bash
   git clone https://github.com/kiriyk/plugins.git ~/kadr
   cd ~/kadr/kadr-sync-server
   ss -ltn | grep -q ':8090 ' && echo "порт 8090 занят — выберите другой" || echo "порт 8090 свободен"
   echo "KADR_PORT=8090" > .env
   ```

   Файл `.env` запоминает порт: compose читает его сам.

3. Запустить:

   ```bash
   docker compose -f docker-compose.ip.yml up -d --build
   alias kadr='docker compose -f ~/kadr/kadr-sync-server/docker-compose.ip.yml'
   echo "alias kadr='docker compose -f ~/kadr/kadr-sync-server/docker-compose.ip.yml'" >> ~/.bashrc
   ```

   Дальше вместо длинной команды можно писать `kadr …`.

4. Открыть порт снаружи. Порты Docker обходят правила `ufw`, поэтому доступ ограничивайте в панели провайдера (облачный файрвол / security group): разрешите TCP 8090 только со своего домашнего IP, если он постоянный. Если файрвола у провайдера нет — порт будет открыт всем, и защитой остаются только ключи.

5. Проверить с домашнего компьютера: `curl -s -o /dev/null -w '%{http_code}\n' http://<IP сервера>:8090/v1/profile` должен вывести `401` (сервер работает и без ключа ничего не отдаёт).

6. Подключить телевизор: в Lampa **Настройки → Sled** → адрес `http://<IP сервера>:8090` → **Привязать по коду**. На сервере подтвердить код с экрана:

   ```bash
   kadr exec kadr-sync python -m kadr_sync.cli pair K7M-4QX "Дом" --create
   ```

   `--create` создаёт профиль при первой привязке; второе устройство привязывается к нему без `--create`.

7. Обновление (данные в томе сохраняются):

   ```bash
   cd ~/kadr && git pull && kadr up -d --build
   ```

8. Резервная копия:

   ```bash
   kadr exec kadr-sync python -m kadr_sync.cli backup /data/backup-$(date +%F).sqlite3
   kadr cp kadr-sync:/data/backup-$(date +%F).sqlite3 ~/
   ```

Журнал: `kadr logs -f kadr-sync` — ключи и токены в него не пишутся.

**Переход на HTTPS позже.** Когда появится домен (подойдёт и бесплатный, например от DuckDNS), направьте его на IP сервера и добавьте в уже работающий Caddyfile блок, затем перезагрузите Caddy:

```caddyfile
kadr.example.com {
	reverse_proxy 127.0.0.1:8090
}
```

В Sled поменяйте адрес на `https://kadr.example.com`; история и привязанные устройства сохранятся. После этого порт 8090 снаружи можно закрыть.

## Профили

Один ключ — один профиль. Одинаковый ключ на устройствах даёт общую историю.

```bash
docker compose exec kadr-sync python -m kadr_sync.cli create-profile "Кирилл"   # ключ показывается один раз
docker compose exec kadr-sync python -m kadr_sync.cli rotate-key "Кирилл"       # новый ключ, история сохраняется
docker compose exec kadr-sync python -m kadr_sync.cli revoke-key "Кирилл"       # ключ и выданные launch-токены перестают действовать
docker compose exec kadr-sync python -m kadr_sync.cli set-threshold "Кирилл" 90 # порог «просмотрено», %
docker compose exec kadr-sync python -m kadr_sync.cli list-profiles
```

Ключ можно не вводить вручную: в Sled нажмите **Привязать по коду** — на экране появится код вида `K7M-4QX` (действует 10 минут). На сервере выполните:

```bash
docker compose exec kadr-sync python -m kadr_sync.cli pair K7M-4QX "Кирилл"            # профиль уже есть
docker compose exec kadr-sync python -m kadr_sync.cli pair K7M-4QX "Гостиная" --create # создать профиль
```

Устройство получает собственный ключ этого профиля; ключ не выводится на экран и в консоль. `revoke-key` отзывает и ключи привязанных устройств, `rotate-key` меняет только основной ключ.

Если ключ всё же вводится вручную — в настройках Sled. Не размещайте ключи в URL, репозиториях и сообщениях.

## Резервное копирование

```bash
docker compose exec kadr-sync python -m kadr_sync.cli backup /data/backup-$(date +%F).sqlite3
docker compose cp kadr-sync:/data/backup-$(date +%F).sqlite3 ./
```

Копия создаётся средствами SQLite и согласована даже во время работы. Для восстановления также нужны `.env` и `Caddyfile`. Восстановление: `docker compose stop kadr-sync`, скопировать файл копии в том как `/data/kadr.sqlite3`, `docker compose start kadr-sync`.

## API v1

Все маршруты, кроме двух маршрутов привязки, требуют `Authorization: Bearer <ключ>`.

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
| `POST /v1/pair/start` | без ключа: выдать код привязки и секрет опроса (не больше 20 ожидающих кодов) |
| `POST /v1/pair/poll` | без ключа: по секрету опроса вернуть `pending` или, после `cli pair`, ключ устройства (один раз) |

Launch-токен (`kadrl_…`, 12 часов) разрешает только события `progress` и `next_requested` своего запуска.

## Разработка

```bash
uv sync
uv run pytest
```
