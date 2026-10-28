# KADR Sync — сервер истории просмотров

Хранит историю просмотров KADR и плагина Lampa по профилям: позиции, статусы, предпочтения источника, конфликты между устройствами. Видео не проксирует и не хранит.

## Запуск

1. DNS-имя направить на сервер, открыть порты 80 и 443.
2. `cp .env.example .env` и указать `KADR_DOMAIN`.
3. `docker compose up -d --build`.

## Запуск на своём сервере по IP, без домена

Домен не нужен: Let's Encrypt выдаёт сертификаты на IP-адрес (короткие, на 6 дней; Caddy продлевает их сам). Сервис слушает только `127.0.0.1:8090`, наружу его отдаёт Caddy по HTTPS под секретным путём, а на любой другой адрес соединение обрывается. Так сервис не видно ни по открытому порту, ни по имени в журналах сертификатов (Certificate Transparency), а ключи и токены идут по HTTPS.

Проверено на Ubuntu 26.04, Caddy 2.11 и телевизоре на Android 9.

Все команды выполняются на сервере по SSH: `ssh root@<IP>`.

1. Docker и Caddy (Caddy нужен 2.10 или новее; если он уже стоит с сайтом — пропустите его установку):

   ```bash
   curl -fsSL https://get.docker.com | sh
   apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
   curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
   apt-get update && apt-get install -y caddy
   caddy version
   ```

2. Сервис, только на локальном интерфейсе:

   ```bash
   git clone https://github.com/kiriyk/plugins.git ~/kadr
   cd ~/kadr/kadr-sync-server
   echo "KADR_PORT=127.0.0.1:8090" > .env
   docker compose -f docker-compose.ip.yml up -d --build
   echo "alias kadr='docker compose -f ~/kadr/kadr-sync-server/docker-compose.ip.yml'" >> ~/.bashrc && . ~/.bashrc
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8090/v1/profile   # 401
   ```

3. Секретный путь — случайная строка, которую знаете только вы:

   ```bash
   echo "s-$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 18)"
   ```

4. Caddy. В `/etc/caddy/Caddyfile` (если там уже есть сайт — добавьте блоки к нему; `default_sni` — в общий блок в начале файла):

   ```caddyfile
   {
   	default_sni 203.0.113.10
   }

   203.0.113.10 {
   	tls {
   		issuer acme {
   			profile shortlived
   		}
   	}
   	handle_path /s-СЕКРЕТНЫЙ-ПУТЬ/* {
   		header -Server
   		header X-Robots-Tag "noindex, nofollow"
   		reverse_proxy 127.0.0.1:8090
   	}
   	handle {
   		abort
   	}
   }
   ```

   `203.0.113.10` замените на IP сервера. **`default_sni` обязателен:** клиенты не передают имя сервера (SNI), когда подключаются по IP, и без этой строки Caddy обрывает все соединения. Затем:

   ```bash
   caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy
   journalctl -u caddy -n 30 -o cat | grep -i "certificate obtained"
   ```

   Порты 80 и 443 должны быть открыты: на них Let's Encrypt проверяет IP.

5. Проверить с домашнего компьютера:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://203.0.113.10/s-СЕКРЕТНЫЙ-ПУТЬ/v1/profile   # 401
   curl -s -o /dev/null -w '%{http_code}\n' https://203.0.113.10/                              # 000: соединение оборвано
   ```

6. Подключить телевизор: в Lampa **Настройки → Sled** → адрес `https://203.0.113.10/s-СЕКРЕТНЫЙ-ПУТЬ` → **Привязать по коду**. На сервере подтвердить код с экрана:

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

Журнал сервиса: `kadr logs -f kadr-sync` — ключи и токены в него не пишутся.

Чтобы не засветить адрес: не открывайте его в браузере (Яндекс.Браузер и Chrome отправляют посещённые адреса), не пересылайте в мессенджерах (они запрашивают ссылку для превью), не пишите путь в `robots.txt` и не коммитьте его.

**Если HTTPS не работает на старом телевизоре.** Android 7.0 и старше не доверяет корневому сертификату Let's Encrypt — Sled покажет «код 0» при проверке связи. Тогда временно добавьте вход по HTTP с тем же путём (ключи пойдут открытым текстом):

```caddyfile
http://203.0.113.10 {
	handle_path /s-СЕКРЕТНЫЙ-ПУТЬ/* {
		reverse_proxy 127.0.0.1:8090
	}
	handle {
		abort
	}
}
```

**С доменом.** Если домен есть, вместо IP укажите его в блоке сайта и уберите `tls { … }` и `default_sni`: Caddy выпустит обычный сертификат. Имя домена при этом попадёт в журналы Certificate Transparency.

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
| `GET /v1/changes?cursor=` | изменения после курсора, включая удаления, конфликты и оценки (`ratings`, удалённые с `deleted: true`) |
| `GET /v1/ratings?limit&offset` | свои оценки профиля с названием и постером, сначала новые |
| `POST /v1/playbacks` | зарегистрировать запуск; возвращает launch-токен для KADR |
| `GET /v1/playbacks/{id}` | состояние запуска (`next_requested`) |
| `POST /v1/events` | пакет событий `progress`, `status`, `delete`, `prefs`, `next_requested`, `rating`, `rating_delete` |
| `GET /v1/conflicts/{id}` | варианты конфликта |
| `POST /v1/conflicts/{id}/resolve` | выбрать вариант (`current` или `playback`) для известной версии |
| `POST /v1/pair/start` | без ключа: выдать код привязки и секрет опроса (не больше 20 ожидающих кодов) |
| `POST /v1/pair/poll` | без ключа: по секрету опроса вернуть `pending` или, после `cli pair`, ключ устройства (один раз) |

Launch-токен (`kadrl_…`, 12 часов) разрешает только события `progress` и `next_requested` своего запуска.

Оценка (`rating`: `content_id`, `score` 1–10, `comment` до 2000 символов, `meta`) ставится фильму или сериалу целиком. Из двух правок побеждает более поздняя по `client_ms`; более старая получает `stale`. `rating_delete` оставляет отметку об удалении, поэтому более старая оценка, пришедшая позже, тоже проигрывает.

## Разработка

```bash
uv sync
uv run pytest
```
