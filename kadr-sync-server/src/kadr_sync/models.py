"""Request bodies. Input is validated even when the key is valid."""
from __future__ import annotations

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

ID = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{8,64}$")]
CONTENT_ID = Annotated[str, Field(pattern=r"^[a-z]{2,8}:(movie|tv):[A-Za-z0-9_.-]{1,64}$")]
EPISODE_ID = Annotated[str, Field(pattern=r"^s\d{1,3}e\d{1,4}$")]
ITEM_KEY = Annotated[str, Field(pattern=r"^[a-z]{2,8}:(movie|tv):[A-Za-z0-9_.-]{1,64}(/s\d{1,3}e\d{1,4})?$")]
MS = Annotated[int, Field(ge=0, le=10**13)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Meta(Strict):
    title: str = Field(min_length=1, max_length=300)
    original_title: Optional[str] = Field(None, max_length=300)
    poster: Optional[str] = Field(None, max_length=500)
    year: Optional[int] = Field(None, ge=1880, le=2100)


class Source(Strict):
    adapter: str = Field(pattern=r"^[a-z0-9_]{1,32}$")
    balanser: Optional[str] = Field(None, max_length=64)
    voice: Optional[str] = Field(None, max_length=120)
    quality: Optional[str] = Field(None, max_length=32)
    ids: dict[str, str] = Field(default_factory=dict)

    @field_validator("ids")
    @classmethod
    def small_ids(cls, value: dict[str, str]) -> dict[str, str]:
        if len(value) > 10 or any(len(k) > 32 or len(v) > 200 for k, v in value.items()):
            raise ValueError("ids: не более 10 коротких значений")
        return value


class Content(Strict):
    content_id: CONTENT_ID
    episode_id: Optional[EPISODE_ID] = None
    season: Optional[int] = Field(None, ge=0, le=1000)
    episode: Optional[int] = Field(None, ge=0, le=10000)
    meta: Meta


class PlaybackIn(Strict):
    playback_id: ID
    device_id: ID
    mode: Literal["resume", "start"]
    start_position_ms: MS
    base_revision: int = Field(ge=0)
    content: Content
    source: Source
    has_next: bool = False


class EventBase(Strict):
    event_id: ID
    device_id: ID
    client_ms: MS


class ProgressEvent(EventBase):
    type: Literal["progress"]
    playback_id: ID
    sequence: Optional[int] = Field(None, ge=1)
    position_ms: MS
    duration_ms: Optional[int] = Field(None, ge=1, le=10**10)
    started: bool


class StatusEvent(EventBase):
    type: Literal["status"]
    item_key: ITEM_KEY
    status: Literal["watched", "unwatched"]


class DeleteEvent(EventBase):
    type: Literal["delete"]
    item_key: ITEM_KEY


class PrefsEvent(EventBase):
    type: Literal["prefs"]
    content_id: CONTENT_ID
    prefs: Source


class NextEvent(EventBase):
    type: Literal["next_requested"]
    playback_id: ID


Event = Annotated[
    Union[ProgressEvent, StatusEvent, DeleteEvent, PrefsEvent, NextEvent],
    Field(discriminator="type"),
]


class EventsIn(Strict):
    events: list[Event] = Field(min_length=1, max_length=100)


class ResolveIn(Strict):
    version: int = Field(ge=1)
    choice: Literal["current", "playback"]


class PairPollIn(Strict):
    poll_token: str = Field(min_length=20, max_length=100)
