"""Ограничение скорости запросов с авто-подбором (AIMD).

Telegram публикует лимиты только на отправку сообщений (~30 msg/s на бота,
1 msg/s в один чат, 20 msg/min в группу). Для методов чтения (getUserGifts,
payments.getSavedStarGifts, страницы t.me/nft) лимиты не опубликованы —
сервер просто отвечает 429 / FLOOD_WAIT_X. Поэтому в режиме «auto» скорость
подбирается сама: плавно растёт, пока ответы успешные, и падает вдвое на
каждом 429, выдерживая паузу retry_after.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

# запросов в секунду для каждого источника: (slow, normal, fast)
SPEED_TABLE: dict[str, tuple[float, float, float]] = {
    "nft_page": (2.0, 5.0, 12.0),  # публичные страницы t.me/nft/<slug>
    "fragment": (0.5, 1.0, 2.0),  # fragment.com: список коллекций и floor
    "botapi": (5.0, 15.0, 25.0),  # Bot API getUserGifts
    "mtproto": (0.5, 1.0, 3.0),  # userbot: payments.getSavedStarGifts
}
SPEED_PRESETS = ("slow", "normal", "fast", "auto")
# во сколько потоков качать страницы при каждом пресете
CONCURRENCY = {"slow": 2, "normal": 4, "fast": 8, "auto": 6}


@dataclass
class LimiterStats:
    requests: int = 0
    throttled: int = 0


class RateLimiter:
    def __init__(self, name: str, preset: str = "auto"):
        self.name = name
        self._lock = asyncio.Lock()
        self._next_at = 0.0
        self._paused_until = 0.0
        self._streak = 0
        self.stats = LimiterStats()
        self.set_preset(preset)

    def set_preset(self, preset: str) -> None:
        if preset not in SPEED_PRESETS:
            raise ValueError(f"неизвестный пресет скорости: {preset}")
        slow, normal, fast = SPEED_TABLE[self.name]
        self.preset = preset
        self.adaptive = preset == "auto"
        if self.adaptive:
            self.min_rps, self.max_rps = slow / 2, fast * 1.5
            self.rps = normal
        else:
            self.rps = {"slow": slow, "normal": normal, "fast": fast}[preset]
            self.min_rps = self.max_rps = self.rps

    async def acquire(self) -> None:
        """Ждёт своей очереди: равномерно rps запросов в секунду + пауза после 429."""
        async with self._lock:
            now = time.monotonic()
            start = max(now, self._next_at, self._paused_until)
            self._next_at = start + 1.0 / self.rps
            self.stats.requests += 1
        if start > now:
            await asyncio.sleep(start - now)

    def on_success(self) -> None:
        if not self.adaptive:
            return
        self._streak += 1
        if self._streak >= 25:  # аддитивный рост: +10% от «normal» каждые 25 успешных ответов
            self._streak = 0
            self.rps = min(self.max_rps, self.rps + SPEED_TABLE[self.name][1] * 0.1)

    def on_throttle(self, retry_after: float | None) -> None:
        self.stats.throttled += 1
        self._streak = 0
        pause = retry_after if retry_after and retry_after > 0 else 5.0
        self._paused_until = max(self._paused_until, time.monotonic() + pause)
        if self.adaptive:  # мультипликативное снижение
            self.rps = max(self.min_rps, self.rps / 2)

    def describe(self) -> str:
        mode = "auto" if self.adaptive else self.preset
        return f"{self.name}: {self.rps:.1f} req/s ({mode}), 429: {self.stats.throttled}"
