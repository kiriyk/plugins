"""Local administration. Deliberately not exposed over HTTP."""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from typing import Optional

from . import db, pairing, profiles


def _check(path: str) -> int:
    if not os.path.exists(path):
        print(f"База не найдена: {path}", file=sys.stderr)
        return 1
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        conn.execute("SELECT count(*) FROM profiles").fetchone()
        conn.close()
    except sqlite3.Error as error:
        print(f"База недоступна: {error}", file=sys.stderr)
        return 1
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="kadr-sync")
    parser.add_argument("--db", default=os.environ.get("KADR_DB", "kadr.sqlite3"))
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("create-profile", "rotate-key", "revoke-key"):
        commands.add_parser(name).add_argument("name")
    threshold = commands.add_parser("set-threshold")
    threshold.add_argument("name")
    threshold.add_argument("percent", type=int)
    commands.add_parser("list-profiles")
    commands.add_parser("check")
    commands.add_parser("backup").add_argument("target")
    pair = commands.add_parser("pair", help="привязать устройство по коду с экрана Sled")
    pair.add_argument("code")
    pair.add_argument("name")
    pair.add_argument("--create", action="store_true", help="создать профиль, если его нет")
    args = parser.parse_args(argv)

    if args.command == "check":
        return _check(args.db)
    db.init(args.db)
    conn = db.connect(args.db)
    try:
        if args.command == "create-profile":
            with db.write(conn):
                key = profiles.create_profile(conn, args.name, db.now_ms())
            print("Профиль создан. Ключ показывается один раз:")
            print(key)
        elif args.command == "rotate-key":
            with db.write(conn):
                key = profiles.rotate_key(conn, args.name)
            print("Новый ключ (старый больше не действует). Показывается один раз:")
            print(key)
        elif args.command == "revoke-key":
            with db.write(conn):
                profiles.revoke_key(conn, args.name)
            print("Ключ отозван. История сохранена.")
        elif args.command == "set-threshold":
            with db.write(conn):
                profiles.set_threshold(conn, args.name, args.percent)
            print(f"Порог просмотренности: {args.percent}%")
        elif args.command == "list-profiles":
            for name, active in profiles.list_profiles(conn):
                print(f"{name}\t{'ключ активен' if active else 'ключ отозван'}")
        elif args.command == "pair":
            with db.write(conn):
                name = pairing.approve(conn, args.code, args.name, db.now_ms(), create=args.create)
            print(f"Устройство привязано к профилю «{name}». Sled на телевизоре подключится сам в течение нескольких секунд.")
        elif args.command == "backup":
            target = sqlite3.connect(args.target)
            conn.backup(target)
            target.close()
            print(f"Резервная копия: {args.target}")
    except (profiles.ProfileError, pairing.PairingError) as error:
        print(str(error), file=sys.stderr)
        return 2
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
