"""Secret generation and their one-way stored representation."""
from __future__ import annotations

import hashlib
import secrets


def new_profile_key() -> str:
    return "kadr_" + secrets.token_urlsafe(32)


def new_launch_token() -> str:
    return "kadrl_" + secrets.token_urlsafe(24)


def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()
