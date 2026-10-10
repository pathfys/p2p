"""Панель администратора: запуск/остановка парсера, скорость, floor-цены."""

from __future__ import annotations

import time
from html import escape

from aiogram import F, Router
from aiogram.filters import Command, CommandObject
from aiogram.types import CallbackQuery, Message

from .. import keyboards as kb
from ..crawler import Crawler
from ..db import Database
from ..ratelimit import SPEED_PRESETS
from ..subscription import SubscriptionChecker
from ..texts import num
from .common import safe_edit, spawn


def build_router(admin_ids: frozenset[int]) -> Router:
    router = Router(name="admin")
    router.message.filter(F.from_user.id.in_(admin_ids))
    router.callback_query.filter(F.from_user.id.in_(admin_ids))
    router.message.register(cmd_admin, Command("admin"))
    router.message.register(cmd_floor, Command("floor"))
    router.message.register(cmd_recrawl, Command("recrawl"))
    router.message.register(cmd_parse_user, Command("parse_user"))
    router.callback_query.register(cb_admin, kb.AdminCb.filter())
    return router


def subscription_line(checker: SubscriptionChecker | None) -> str:
    if checker is None or not checker.enabled:
        return "Обязательная подписка: выкл"
    if checker.last_error:
        return (
            f"Обязательная подписка: {escape(checker.channel)} — проверка не работает, сделайте бота "
            f"администратором канала (<code>{escape(checker.last_error[:200])}</code>)"
        )
    return f"Обязательная подписка: {escape(checker.channel)} — ок"


def fill_line(st, gifts_total: int) -> str:
    """Скорость наполнения базы: подарков/час за текущую сессию парсера + оценка до 100k."""
    if not st.started_at or st.gifts <= 0:
        return "Наполнение: —  (ждём первые подарки)"
    elapsed = max(1.0, time.time() - st.started_at)
    per_hour = st.gifts / elapsed * 3600
    line = f"Наполнение: ~{num(per_hour)} подарков/час"
    remaining = 100_000 - gifts_total
    if per_hour >= 1 and remaining > 0:
        line += f" · до 100k ≈ {num(remaining / per_hour)} ч"
    elif remaining <= 0:
        line += " · 100k достигнуто"
    return line


async def panel_text(crawler: Crawler, db: Database, checker: SubscriptionChecker | None = None) -> str:
    st = crawler.status
    stats = await db.stats()
    uptime = f"{(time.time() - st.started_at) / 60:.0f} мин" if st.started_at and crawler.running else "—"
    position = f"{st.collection} — {num(st.position)}/{num(st.issued)}" if st.collection else "—"
    lines = [
        "<b>Панель парсера</b>\n",
        f"Состояние: <b>{'работает' if crawler.running else 'остановлен'}</b> · {uptime}",
        f"Этап: {escape(st.phase)}",
        f"Коллекция: {escape(position)}",
        f"Страниц: {num(st.pages)} · подарков: {num(st.gifts)} · пусто: {num(st.missing)}",
        f"Троттлинг t.me: {num(st.throttled)} (это норма, не ошибка) · ошибок: {num(st.errors)}",
        f"Bot API юзеров: {num(st.users_checked)} · MTProto: {'вкл' if crawler.mtproto else 'выкл'} "
        f"· владельцев добрано: {num(st.owners_enriched)}",
        *(
            []
            if crawler.mtproto
            else [
                "<b>MTProto выключен — владельцы собираться НЕ будут.</b> Страницы t.me/nft "
                "отдают только имя без @username. Задайте API_ID/API_HASH и выполните вход "
                "(<code>python gift_parser_bot.py --login</code>)."
            ]
        ),
        subscription_line(checker),
        "",
        f"<b>Скорость: {crawler.preset}</b>",
        *(f"<code>{escape(limiter.describe())}</code>" for limiter in crawler.limiters.values()),
        fill_line(st, stats["gifts"]),
        "",
        f"База: NFT {num(stats['gifts'])} · обычных {num(stats.get('regular'))} · "
        f"владельцев {num(stats['owners'])} · коллекций {num(stats['collections'])} · юзеров {num(stats['users'])}",
        f"Из них людей (@username): {num(stats.get('owners_named'))} · кошельков {num(stats.get('owners_wallet'))} · "
        f"подарков со скрытым владельцем: {num(stats.get('hidden_gifts'))}",
    ]
    if st.last_error:
        lines.append(f"\nПоследняя ошибка: <code>{escape(st.last_error[:300])}</code>")
    lines.append(
        "\n<i>Команды: /floor &lt;slug&gt; &lt;TON|auto&gt; · /recrawl &lt;slug&gt; · /parse_user &lt;user_id&gt;</i>"
    )
    return "\n".join(lines)


async def cmd_admin(message: Message, crawler: Crawler, db: Database, checker: SubscriptionChecker) -> None:
    await message.answer(
        await panel_text(crawler, db, checker), reply_markup=kb.admin_panel(crawler.running, crawler.preset)
    )


async def cb_admin(
    call: CallbackQuery, callback_data: kb.AdminCb, crawler: Crawler, db: Database, checker: SubscriptionChecker
) -> None:
    action = callback_data.action
    note = ""
    if action == "start":
        note = "Парсер запущен" if crawler.start() else "Уже работает"
    elif action == "stop":
        note = "Парсер остановлен" if await crawler.stop() else "Уже остановлен"
    elif action == "speed" and callback_data.value in SPEED_PRESETS:
        crawler.set_speed(callback_data.value)
        note = f"Скорость: {callback_data.value}"
    elif action == "sync":
        note = "Синхронизация с Fragment запущена, пришлю результат"

        async def sync() -> None:
            try:
                added, updated = await crawler.sync_collections()
                await call.message.answer(f"Новых коллекций: {added}, обновлено floor: {updated}")
            except Exception as e:
                await call.message.answer(f"Fragment: <code>{escape(repr(e))}</code>")

        spawn(sync())
    await call.answer(note)
    await safe_edit(
        call.message, await panel_text(crawler, db, checker), kb.admin_panel(crawler.running, crawler.preset)
    )


async def cmd_floor(message: Message, command: CommandObject, db: Database) -> None:
    """/floor plushpepe 7000 — задать floor вручную; /floor plushpepe auto — вернуть автообновление."""
    args = (command.args or "").split()
    if len(args) != 2:
        await message.answer("Формат: <code>/floor plushpepe 7000</code> или <code>/floor plushpepe auto</code>")
        return
    slug, value = args[0].lower(), args[1].lower()
    if value == "auto":
        ok = await db.set_floor(slug, None, manual=True)
        if ok:
            await db.conn.execute("UPDATE collections SET floor_manual = 0 WHERE slug = ?", (slug,))
    else:
        try:
            ok = await db.set_floor(slug, float(value.replace(",", ".")), manual=True)
        except ValueError:
            await message.answer("Цена должна быть числом в TON")
            return
    if not ok:
        await message.answer(f"Коллекция <code>{escape(slug)}</code> не найдена")
        return
    await db.recompute_owners(None)
    await db.conn.commit()
    await message.answer(f"floor {escape(slug)} = {escape(value)}; уровни владельцев пересчитаны")


async def cmd_recrawl(message: Message, command: CommandObject, db: Database) -> None:
    slug = (command.args or "").strip().lower()
    if slug and await db.restart_collection(slug):
        await message.answer(f"{escape(slug)} будет пропарсена заново с №1")
    else:
        await message.answer("Формат: <code>/recrawl plushpepe</code> (коллекция должна быть в базе)")


async def cmd_parse_user(message: Message, command: CommandObject, crawler: Crawler) -> None:
    arg = (command.args or "").strip()
    if not arg.isdigit():
        await message.answer("Формат: <code>/parse_user 123456789</code>")
        return
    count = await crawler.parse_user(int(arg))
    await message.answer(f"Найдено NFT-подарков: {count}")
