"""Все тексты бота и форматирование карточек подарков (HTML parse_mode)."""

from __future__ import annotations

from html import escape
from typing import Mapping

from .config import Settings

MODES: dict[str, tuple[str, str]] = {
    "light": ("🌱", "Лёгкий"),
    "medium": ("⚖️", "Средний"),
    "rich": ("💎", "Rich"),
    "all": ("🎲", "Все подарки"),
}

FIELDS: dict[str, tuple[str, str, str]] = {
    # поле: (эмодзи, название, «любой/любая»)
    "collection": ("🎁", "Подарок", "любой"),
    "backdrop": ("🎨", "Фон", "любой"),
    "model": ("🧩", "Модель", "любая"),
    "symbol": ("🔣", "Узор", "любой"),
}


def num(value: float | int | None) -> str:
    return f"{value or 0:,.0f}".replace(",", " ")


def mode_label(mode: str) -> str:
    emoji, label = MODES.get(mode, MODES["all"])
    return f"{emoji} {label}"


def mode_hint(mode: str, s: Settings) -> str:
    return {
        "light": f"🌱 Лёгкий: владельцы с портфелем до {num(s.tier_medium_ton)} TON",
        "medium": f"⚖️ Средний: портфель от {num(s.tier_medium_ton)} до {num(s.tier_rich_ton)} TON",
        "rich": f"💎 Rich: портфель от {num(s.tier_rich_ton)} TON, самые богатые — первыми",
        "all": "🎲 Все подарки: любые владельцы, случайный порядок",
    }[mode]


def welcome(name: str | None, stats: Mapping[str, int], running: bool = True) -> str:
    parser = "🟢 работает, база растёт в реальном времени" if running else "🔴 остановлен (/admin → запустить)"
    return (
        f"👋 Привет, <b>{escape(name or 'друг')}</b>!\n\n"
        "🎁 <b>Gift Parser</b> — живой парсер коллекционных подарков Telegram (NFT).\n"
        "Я сам непрерывно обхожу публичные страницы <code>t.me/nft</code> и наполняю базу — "
        "искать можно сразу, данные подтягиваются на лету.\n\n"
        f"📦 Сейчас в базе: <b>{num(stats.get('gifts'))}</b> подарков · "
        f"<b>{num(stats.get('owners'))}</b> владельцев · <b>{num(stats.get('collections'))}</b> коллекций\n"
        f"⚙️ Парсер: {parser}\n\n"
        "🔍 <b>Быстрый поиск</b> — название подарка, ссылку <code>t.me/nft/…</code> или <code>@username</code>\n"
        "🎛 <b>Поиск по фильтрам</b> — подарок, фон, модель, узор + режим (🌱 Лёгкий / ⚖️ Средний / 💎 Rich)\n"
        "🎲 <b>Все подарки — поток</b> — случайные владельцы с разными подарками\n\n"
        "Выберите действие 👇"
    )


QUICK_PROMPT = (
    "🔍 <b>Быстрый поиск</b>\n\n"
    "Отправьте одним сообщением:\n"
    "• название подарка, модели, фона или узора — <code>Plush Pepe</code>, <code>Onyx Black</code>\n"
    "• несколько слов сразу — <code>Durov's Cap Black</code>\n"
    "• ссылку на подарок — <code>t.me/nft/PlushPepe-1</code>\n"
    "• владельца — <code>@username</code>\n\n"
    "<i>Нужен уровень владельцев (Лёгкий / Средний / Rich) — зайдите в «🎛 Поиск по фильтрам».</i>"
)

NOTHING_FOUND = (
    "😔 Пока ничего не найдено.\n\n"
    "Парсер прямо сейчас наполняет базу — подождите немного и повторите, "
    "или ослабьте фильтры. Прогресс виден в «📊 Статистика базы»."
)
SEARCH_EXPIRED = "Этот поиск устарел — запустите его заново."
GIFT_NOT_FOUND = "😔 Такого подарка нет: проверьте название и номер в ссылке."


def rarity(permille: int | None) -> str:
    return f" · {permille / 10:g}%" if permille else ""


def owner_line(row: Mapping) -> str:
    if row["username"]:
        who = f"@{escape(row['username'])}"
    elif row["user_id"] and row["o_name"]:
        who = f'<a href="tg://user?id={row["user_id"]}">{escape(row["o_name"])}</a>'
    elif row["ton_address"]:
        addr = row["ton_address"]
        who = f"<code>{escape(addr[:6])}…{escape(addr[-4:])}</code> (TON-кошелёк)"
    elif row["owner_name"]:
        who = f"{escape(row['owner_name'])} (без юзернейма)"
    else:
        return "👤 владелец скрыт"
    if row["tier"] and row["gifts_count"]:
        who += f" · {mode_label(row['tier'])} · {row['gifts_count']} NFT · ≈{num(row['value_ton'])} TON"
    return f"👤 {who}"


def gift_card(row: Mapping, index: int | None = None) -> str:
    prefix = f"{index}. " if index is not None else ""
    lines = [f'{prefix}🎁 <b><a href="https://t.me/nft/{row["slug"]}">{escape(row["title"])} #{row["number"]}</a></b>']
    for label, field in (("Модель", "model"), ("Фон", "backdrop"), ("Узор", "symbol")):
        if row[field]:
            lines.append(f"├ {label}: {escape(row[field])}{rarity(row[field + '_rarity'])}")
    lines.append(f"└ {owner_line(row)}")
    return "\n".join(lines)


def results(header: str, mode: str, rows: list, total: int, page: int, pages: int) -> str:
    if not rows:
        return f"🔍 <b>{header}</b>\n\n{NOTHING_FOUND}"
    cards = "\n\n".join(gift_card(row, i) for i, row in enumerate(rows, start=1))
    return (
        f"🔍 <b>{header}</b>\n"
        f"Режим: {mode_label(mode)} · найдено: <b>{num(total)}</b> · стр. {page + 1}/{pages}\n\n{cards}"
    )


PARSING = "⏳ Парсинг…"
RANDOM_HEADER = "🎲 Все подарки — случайные люди"


def person_card(person: Mapping, index: int) -> str:
    gift = f'🎁 <a href="https://t.me/nft/{person["slug"]}">{escape(person["title"])} #{person["number"]}</a>'
    for emoji, field in (("🎨", "backdrop"), ("🧩", "model")):
        if person[field]:
            gift += f" · {emoji} {escape(person[field])}"
    if person.get("matched", 1) > 1:
        gift += f" · ещё {person['matched'] - 1} подходящих"
    return f"{index}. {owner_line(person)}\n      {gift}"


def timing_line(timing: Mapping) -> str:
    line = f"⏱ Парсинг: <b>{timing['seconds']:.2f} с</b>"
    if timing["checked"]:
        line += f" — база {timing['db_seconds']:.2f} с, проверка t.me/nft {timing['live_seconds']:.2f} с"
        line += f" ({timing['checked']} стр.)"
        if timing["replaced"]:
            line += f", заменено устаревших: {timing['replaced']}"
    else:
        line += " (из базы, без живой проверки)"
    return line


def people_page(header: str, mode: str, people: list, page: int, per_page: int, timing: Mapping) -> str:
    if not people:
        return f"👥 <b>{header}</b>\n\n{NOTHING_FOUND}"
    pages = max(1, -(-len(people) // per_page))
    chunk = people[page * per_page : (page + 1) * per_page]
    cards = "\n\n".join(person_card(p, i) for i, p in enumerate(chunk, start=page * per_page + 1))
    return (
        f"👥 <b>{header}</b>\n"
        f"Режим: {mode_label(mode)} · стр. {page + 1}/{pages} · людей: <b>{len(people)}</b>\n"
        f"{timing_line(timing)}\n\n{cards}"
    )


def subscribe_required(channel: str) -> str:
    return (
        "🔒 <b>Парсер доступен только подписчикам</b>\n\n"
        f"1️⃣ Подпишитесь на канал {escape(channel)}\n"
        "2️⃣ Нажмите «✅ Проверить подписку»\n\n"
        "После проверки откроется весь функционал бота."
    )


SUBSCRIBE_ALERT = "🔒 Сначала подпишитесь на канал {channel}"
SUBSCRIBE_FAIL = "❌ Подписка на {channel} не найдена. Подпишитесь и нажмите «Проверить подписку» ещё раз."
SUBSCRIBE_OK = "✅ Подписка подтверждена!"


def filters_summary(filters: Mapping[str, str]) -> str:
    parts = []
    for field, (emoji, _, _) in FIELDS.items():
        if filters.get(field):
            value = filters.get(f"{field}_title") or filters[field]
            parts.append(f"{emoji} {escape(value)}")
    return "Поиск: " + (" · ".join(parts) if parts else "все подарки")


def filters_panel(filters: Mapping[str, str], mode: str, s: Settings) -> str:
    lines = ["🎛 <b>Поиск по фильтрам</b>\n"]
    for field, (emoji, label, any_word) in FIELDS.items():
        value = filters.get(f"{field}_title") or filters.get(field)
        lines.append(f"{emoji} {label}: <b>{escape(value) if value else any_word}</b>")
    lines.append(f"\nРежим: <b>{mode_label(mode)}</b>\n<i>{mode_hint(mode, s)}</i>")
    lines.append("\nЗадайте нужные фильтры и нажмите «🔎 Найти».")
    return "\n".join(lines)


def picker_title(field: str, page: int, pages: int) -> str:
    emoji, label, _ = FIELDS[field]
    return f"{emoji} <b>Выберите: {label.lower()}</b>  (стр. {page + 1}/{pages})"


def parser_line(status, running: bool) -> str:
    if not running:
        return "⚙️ Парсер: 🔴 остановлен (/admin → ▶️ запустить)"
    where = (
        f" · сейчас: {escape(status.collection)} {num(status.position)}/{num(status.issued)}"
        if status.collection
        else ""
    )
    return f"⚙️ Парсер: 🟢 работает · собрано {num(status.gifts)} за сессию{where}"


def stats_text(stats: Mapping[str, int], s: Settings, parser: str) -> str:
    return (
        "📊 <b>Статистика базы</b>\n\n"
        f"🎁 Подарков: <b>{num(stats.get('gifts'))}</b>\n"
        f"👥 Владельцев: <b>{num(stats.get('owners'))}</b>\n"
        f"    🌱 {num(stats.get('light'))} · ⚖️ {num(stats.get('medium'))} · 💎 {num(stats.get('rich'))}\n"
        f"🗂 Коллекций: <b>{num(stats.get('collections'))}</b>\n"
        f"🙋 Пользователей бота: <b>{num(stats.get('users'))}</b>\n\n"
        f"{parser}\n\n"
        f"<i>Режимы по оценке всех NFT владельца (floor с Fragment):\n"
        f"🌱 до {num(s.tier_medium_ton)} TON · ⚖️ {num(s.tier_medium_ton)}–{num(s.tier_rich_ton)} TON · "
        f"💎 от {num(s.tier_rich_ton)} TON</i>"
    )
