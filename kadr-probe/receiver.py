#!/usr/bin/env python3
"""Receives KADR Probe logs from Lampa on the local network and saves them as JSON files.

Usage: python3 receiver.py [--port 8765] [--dir probe-logs]
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import socket
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BYTES = 1024 * 1024
PATH = "/kadr-probe"


def is_local(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local


def safe_label(label: object) -> str:
    text = re.sub(r"[^A-Za-z0-9А-Яа-яЁё]+", "-", str(label or "")).strip("-")
    return text[:40] or "log"


def make_server(host: str, port: int, folder: str) -> ThreadingHTTPServer:
    os.makedirs(folder, exist_ok=True)

    class Handler(BaseHTTPRequestHandler):
        def _reply(self, code: int, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:
            self._reply(200, {})

        def do_POST(self) -> None:
            if not is_local(self.client_address[0]):
                return self._reply(403, {"error": "local network only"})
            if self.path != PATH:
                return self._reply(404, {"error": "not found"})
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BYTES:
                return self._reply(413, {"error": "too large"})
            try:
                data = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(data, dict):
                    raise ValueError("object expected")
            except (ValueError, UnicodeDecodeError):
                return self._reply(400, {"error": "bad json"})
            base = time.strftime("%Y%m%d-%H%M%S") + "-" + safe_label(data.get("label"))
            name, counter = base + ".json", 1
            while os.path.exists(os.path.join(folder, name)):
                name, counter = f"{base}-{counter}.json", counter + 1
            with open(os.path.join(folder, name), "w", encoding="utf-8") as handle:
                json.dump(data, handle, ensure_ascii=False, indent=2)
            print(f"saved {name}: {len(data.get('records') or [])} records", flush=True)
            self._reply(200, {"ok": True, "file": name})

        def log_message(self, format: str, *args) -> None:  # keep the console readable
            pass

    return ThreadingHTTPServer((host, port), Handler)


def local_addresses() -> list[str]:
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("192.0.2.1", 9))  # no packet is sent; picks the LAN interface
        address = probe.getsockname()[0]
        probe.close()
        return [address]
    except OSError:
        return []


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--dir", default="probe-logs")
    args = parser.parse_args()
    server = make_server("0.0.0.0", args.port, args.dir)
    for address in local_addresses():
        print(f"В KADR Probe укажите адрес компьютера: {address}:{args.port}")
    print(f"Журналы сохраняются в {os.path.abspath(args.dir)}. Остановка: Ctrl+C", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
