"""Все тексты бота и форматирование выдачи (HTML parse_mode). Без эмодзи/стикеров."""

from __future__ import annotations

import re
from html import escape
from typing import Mapping

from .config import Settings

# Внутренний ключ режима -> подпись. Ключи в БД остаются light/medium/rich.
MODES: dict[str, str] = {
    "light": "Low",
    "medium": "Medium",
    "rich": "Rich",
    "all": "Все",
}

# поле -> (название кнопки, «любой/любая»)
FIELDS: dict[str, tuple[str, str]] = {
    "collection": ("По подарку", "любой"),
    "backdrop": ("По фону", "любой"),
    "model": ("По модели", "любая"),
    "symbol": ("По узору", "любой"),
    "tier": ("По уровню", "любой"),
    "min_gifts": ("По NFT", "любое"),
    "min_rarity": ("По редкости", "любая"),
}


def num(value: float | int | None) -> str:
    return f"{value or 0:,.0f}".replace(",", " ")


def mode_label(mode: str) -> str:
    return MODES.get(mode, MODES["all"])


def tier_hint(mode: str, s: Settings) -> str:
    return {
        "light": f"Low — подарки до {num(s.tier_medium_ton)} TON",
        "medium": f"Medium — от {num(s.tier_medium_ton)} до {num(s.tier_rich_ton)} TON",
        "rich": f"Rich — от {num(s.tier_rich_ton)} TON",
        "all": "Все владельцы, случайный порядок",
    }[mode]


def welcome() -> str:
    return (
        "<b>Привет, это лучший парсер по поиску подарков в телеграмме</b>\n\n"
        "Вместо часов поиска, найди лохмача за 15 минут 🦣"
    )


FEMALE_HEADER = "Девочки"


def quick_prompt(s: Settings) -> str:
    return (
        "<b>Быстрый поиск</b>\n\n"
        "Выберите уровень владельцев:\n\n"
        f"Фильтр Low - подарки до {num(s.tier_medium_ton)} TON\n"
        f"Фильтр Medium - подарки от {num(s.tier_medium_ton)} до {num(s.tier_rich_ton)} TON\n"
        f"Фильтр Rich - подарки от {num(s.tier_rich_ton)} TON\n\n"
        "Также можно прислать название подарка, ссылку t.me/nft или @username."
    )


NOTHING_FOUND = (
    "Пока ничего не найдено.\n\n"
    "Парсер прямо сейчас наполняет базу — подождите немного и повторите, "
    "или ослабьте фильтры. Прогресс виден в «Статистика»."
)
SEARCH_EXPIRED = "Этот поиск устарел, запустите его заново."
GIFT_NOT_FOUND = "Такого подарка нет: проверьте название и номер в ссылке."
PARSING = "Идёт поиск…"
RANDOM_HEADER = "Все подарки — случайные владельцы"


def owner_ref(row: Mapping) -> str:
    """Владелец одной строкой, без эмодзи."""
    if row["username"]:
        return f"@{escape(row['username'])}"
    if row["user_id"] and row["o_name"]:
        return f'<a href="tg://user?id={row["user_id"]}">{escape(row["o_name"])}</a>'
    if row["ton_address"]:
        addr = row["ton_address"]
        return f"<code>{escape(addr[:6])}…{escape(addr[-4:])}</code>"
    if row["owner_name"]:
        return escape(row["owner_name"])
    return "владелец скрыт"


def _field(row: Mapping, key: str, default: object = None) -> object:
    """Безопасно читает поле из sqlite3.Row или dict (у Row нет .get)."""
    try:
        value = row[key]
    except (KeyError, IndexError):
        return default
    return default if value is None else value


def _regular_label(row: Mapping) -> str:
    """Понятная подпись обычного подарка. В базе на один обычный подарок нет своего
    заголовка — коллекция хранится как «regular<звёзды>», отсюда и достаём число звёзд."""
    coll = str(_field(row, "title", "") or "")
    m = re.fullmatch(r"regular(\d+)", coll)
    return f"Обычный подарок, {m.group(1)} звёзд" if m else "Обычный подарок"


def _row_line(row: Mapping, index: int | None) -> str:
    """Формат улучшенного NFT: «@username / ссылка на NFT / N NFT / ~X TON».
    Обычный (неулучшенный) подарок: «@username / Обычный подарок, N звёзд» — страницы NFT у него нет."""
    prefix = f"{index}. " if index is not None else ""
    if not _field(row, "is_upgraded", 1):
        matched = _field(row, "matched", 0) or 0
        tail = f" ({matched} шт.)" if matched and matched > 1 else ""
        return f"{prefix}{owner_ref(row)} / {_regular_label(row)}{tail}"
    link = f'<a href="https://t.me/nft/{row["slug"]}">{escape(row["title"])} #{row["number"]}</a>'
    tail = ""
    if row["gifts_count"]:
        tail = f" / {row['gifts_count']} NFT / ~{num(row['value_ton'])} TON"
    return f"{prefix}{owner_ref(row)} / {link}{tail}"


def gift_card(row: Mapping, index: int | None = None) -> str:
    return _row_line(row, index)


def person_card(person: Mapping, index: int) -> str:
    return _row_line(person, index)


def results(header: str, mode: str, rows: list, total: int, page: int, pages: int) -> str:
    if not rows:
        return f"<b>{header}</b>\n\n{NOTHING_FOUND}"
    cards = "\n".join(gift_card(row, i) for i, row in enumerate(rows, start=1))
    return f"<b>{header}</b>\nНайдено: {num(total)} · стр. {page + 1}/{pages}\n\n{cards}"


def timing_line(timing: Mapping) -> str:
    line = f"Поиск: {timing['seconds']:.2f} с"
    if timing["checked"]:
        line += f" (проверено {timing['checked']})"
        if timing["replaced"]:
            line += f", заменено {timing['replaced']}"
    return line


def people_page(header: str, mode: str, people: list, page: int, per_page: int, timing: Mapping) -> str:
    if not people:
        return f"<b>{header}</b>\n\n{NOTHING_FOUND}"
    pages = max(1, -(-len(people) // per_page))
    chunk = people[page * per_page : (page + 1) * per_page]
    cards = "\n".join(person_card(p, i) for i, p in enumerate(chunk, start=page * per_page + 1))
    return f"<b>{header}</b>\nСтраница {page + 1}/{pages} · людей: {len(people)} · {timing_line(timing)}\n\n{cards}"


def subscribe_required(channel: str) -> str:
    return (
        "<b>Парсер доступен только подписчикам</b>\n\n"
        f"1. Подпишитесь на канал {escape(channel)}\n"
        "2. Нажмите «Проверить подписку»\n\n"
        "После проверки откроется весь функционал бота."
    )


SUBSCRIBE_ALERT = "Сначала подпишитесь на канал {channel}"
SUBSCRIBE_FAIL = "Подписка на {channel} не найдена. Подпишитесь и нажмите «Проверить подписку» ещё раз."
SUBSCRIBE_OK = "Подписка подтверждена"


TOGGLES: dict[str, str] = {"not_upgraded": "Обычные подарки", "female": "Девочки"}


def filters_summary(filters: Mapping[str, str]) -> str:
    parts = []
    for field, (_, _) in FIELDS.items():
        if filters.get(field):
            value = filters.get(f"{field}_title") or filters[field]
            parts.append(escape(value))
    for field, label in TOGGLES.items():
        if filters.get(field):
            parts.append(label.lower())
    return "Поиск: " + (" / ".join(parts) if parts else "все подарки")


def filters_panel(filters: Mapping[str, str]) -> str:
    lines = ["<b>Поиск по фильтрам</b>\n"]
    for field, (label, any_word) in FIELDS.items():
        value = filters.get(f"{field}_title") or filters.get(field)
        lines.append(f"{label}: <b>{escape(value) if value else any_word}</b>")
    for field, label in TOGGLES.items():
        lines.append(f"{label}: <b>{'да' if filters.get(field) else 'нет'}</b>")
    lines.append("\nЗадайте нужные фильтры и нажмите «Найти».")
    return "\n".join(lines)


def picker_title(field: str, page: int, pages: int) -> str:
    label, _ = FIELDS[field]
    return f"<b>Выберите: {label.lower()}</b>  (стр. {page + 1}/{pages})"


def parser_line(status, running: bool) -> str:
    if not running:
        return "Парсер: остановлен (/admin — запустить)"
    where = (
        f" · сейчас: {escape(status.collection)} {num(status.position)}/{num(status.issued)}"
        if status.collection
        else ""
    )
    return f"Парсер: работает · собрано {num(status.gifts)} за сессию{where}"


def stats_text(stats: Mapping[str, int], s: Settings, parser: str) -> str:
    return (
        "<b>Статистика базы</b>\n\n"
        f"Подарков: <b>{num(stats.get('gifts'))}</b>\n"
        f"Владельцев: <b>{num(stats.get('owners'))}</b> "
        f"(Low {num(stats.get('light'))} · Medium {num(stats.get('medium'))} · Rich {num(stats.get('rich'))})\n"
        f"Коллекций: <b>{num(stats.get('collections'))}</b>\n"
        f"Пользователей бота: <b>{num(stats.get('users'))}</b>\n\n"
        f"{parser}\n\n"
        f"<i>Уровни по оценке всех NFT владельца: Low до {num(s.tier_medium_ton)} TON · "
        f"Medium {num(s.tier_medium_ton)}–{num(s.tier_rich_ton)} TON · Rich от {num(s.tier_rich_ton)} TON</i>"
    )
