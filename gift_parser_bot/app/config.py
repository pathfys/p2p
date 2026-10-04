"""Настройки бота. Всё читается из переменных окружения / файла .env."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent


def _int_set(raw: str) -> frozenset[int]:
    return frozenset(int(x) for x in raw.replace(" ", "").split(",") if x)


def _bool(raw: str | None, default: bool = False) -> bool:
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on", "да"}


@dataclass(frozen=True)
class Settings:
    bot_token: str
    admin_ids: frozenset[int] = field(default_factory=frozenset)
    db_path: Path = BASE_DIR / "data" / "gifts.db"

    # Скорость парсера: slow | normal | fast | auto
    speed: str = "auto"
    # Запускать парсер сразу при старте бота
    autostart_parser: bool = False
    # Через сколько часов повторно обходить коллекцию / обновлять портфель владельца
    recrawl_hours: int = 24
    # Сколько номеров одной коллекции парсится за один «пакет» (контрольная точка в БД)
    chunk_size: int = 50
    # Парсить только коллекции с floor не ниже этого значения, TON (0 = все ~11.7 млн NFT)
    crawl_min_floor_ton: float = 0.0

    # Пороги режимов (суммарная оценка всех NFT владельца, в TON)
    tier_medium_ton: float = 30.0
    tier_rich_ton: float = 300.0
    # Оценка подарка, если floor-цена коллекции неизвестна
    default_gift_ton: float = 3.0

    # Подарки владельца при поиске по @username
    results_per_page: int = 5
    # Выдача людей: по 10 на странице, 2 страницы («След. страница» → «Назад» / «Повторить»)
    people_per_page: int = 10
    people_pages: int = 2
    # Перед выдачей проверять каждого человека живым запросом к t.me/nft (актуальный владелец)
    live_check: bool = True

    # Обязательная подписка (бот должен быть администратором канала); пусто — без проверки
    required_channel: str | None = "@fiestagod"

    # Опционально: MTProto-аккаунт (Telethon) для payments.getSavedStarGifts
    api_id: int | None = None
    api_hash: str | None = None
    mtproto_session: Path = BASE_DIR / "data" / "parser"

    @property
    def mtproto_enabled(self) -> bool:
        return bool(self.api_id and self.api_hash)


def load_settings() -> Settings:
    load_dotenv(BASE_DIR / ".env")
    token = os.getenv("BOT_TOKEN", "").strip()
    if not token:
        raise RuntimeError("BOT_TOKEN не задан. Скопируйте .env.example в .env и укажите токен от @BotFather.")

    api_id = os.getenv("API_ID", "").strip()
    db_path = os.getenv("DB_PATH", "").strip()
    session = os.getenv("MTPROTO_SESSION", "").strip()
    return Settings(
        bot_token=token,
        admin_ids=_int_set(os.getenv("ADMIN_IDS", "")),
        db_path=Path(db_path) if db_path else Settings.db_path,
        speed=os.getenv("PARSER_SPEED", "auto").strip().lower(),
        autostart_parser=_bool(os.getenv("PARSER_AUTOSTART"), False),
        recrawl_hours=int(os.getenv("RECRAWL_HOURS", "24")),
        chunk_size=int(os.getenv("CHUNK_SIZE", "50")),
        crawl_min_floor_ton=float(os.getenv("CRAWL_MIN_FLOOR_TON", "0")),
        tier_medium_ton=float(os.getenv("TIER_MEDIUM_TON", "30")),
        tier_rich_ton=float(os.getenv("TIER_RICH_TON", "300")),
        default_gift_ton=float(os.getenv("DEFAULT_GIFT_TON", "3")),
        results_per_page=int(os.getenv("RESULTS_PER_PAGE", "5")),
        people_per_page=int(os.getenv("PEOPLE_PER_PAGE", "10")),
        people_pages=int(os.getenv("PEOPLE_PAGES", "2")),
        live_check=_bool(os.getenv("LIVE_CHECK"), True),
        required_channel=os.getenv("REQUIRED_CHANNEL", "@fiestagod").strip() or None,
        api_id=int(api_id) if api_id else None,
        api_hash=os.getenv("API_HASH", "").strip() or None,
        mtproto_session=Path(session) if session else Settings.mtproto_session,
    )
