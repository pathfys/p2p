"""Выдача людей: 10 на странице, «След. страница» / «Назад» / «Повторить»."""

from __future__ import annotations

import random
from dataclasses import asdict, replace

from aiogram import F, Router
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message

from .. import keyboards as kb
from .. import texts
from ..config import Settings
from ..db import SearchQuery
from ..people import PeopleParser
from .common import safe_edit

router = Router(name="people")

MAX_SHOWN = 2000  # сколько уже показанных людей помнить, чтобы «Повторить» давал новых


async def run_people(
    message: Message,
    state: FSMContext,
    people_parser: PeopleParser,
    settings: Settings,
    *,
    query: SearchQuery | None,
    header: str,
    mode: str,
    back: str,
    edit: bool,
    repeat: bool = False,
) -> None:
    """Парсит 20 человек и показывает первую страницу. query=None — «Все подарки» (случайные)."""
    data = await state.get_data()
    shown: list[int] = list(data.get("people_shown", [])) if repeat else []
    if not edit:
        message = await message.answer(f"<b>{header}</b>\n\n{texts.PARSING}")

    result = await people_parser.parse(query, set(shown))
    if repeat and not result.people and shown:  # всех подходящих уже показали — начинаем заново
        shown = []
        result = await people_parser.parse(query, set())

    shown += [p["owner_id"] for p in result.people]
    data = {
        "people": result.people,
        "people_query": asdict(query) if query else None,
        "people_header": header,
        "people_mode": mode,
        "people_back": back,
        "people_shown": shown[-MAX_SHOWN:],
        "people_timing": result.timing(),
    }
    await state.update_data(**data)
    await render_people(message, data, settings, page=0)


async def render_people(message: Message, data: dict, settings: Settings, page: int) -> None:
    per_page = settings.people_per_page
    pages = max(1, -(-len(data["people"]) // per_page))
    page = min(max(page, 0), pages - 1)
    text = texts.people_page(
        data["people_header"], data["people_mode"], data["people"], page, per_page, data["people_timing"]
    )
    await safe_edit(message, text, kb.people(page, pages, data["people_back"]))


@router.callback_query(kb.PeopleCb.filter(F.action == "page"))
async def cb_people_page(
    call: CallbackQuery, callback_data: kb.PeopleCb, state: FSMContext, settings: Settings
) -> None:
    data = await state.get_data()
    if "people" not in data:
        await call.answer(texts.SEARCH_EXPIRED, show_alert=True)
        return
    await render_people(call.message, data, settings, callback_data.page)
    await call.answer()


@router.callback_query(kb.PeopleCb.filter(F.action == "repeat"))
async def cb_people_repeat(
    call: CallbackQuery, state: FSMContext, people_parser: PeopleParser, settings: Settings
) -> None:
    """«Повторить» — новый парсинг по тому же запросу; уже показанные люди не повторяются."""
    data = await state.get_data()
    if "people_header" not in data:
        await call.answer(texts.SEARCH_EXPIRED, show_alert=True)
        return
    await call.answer(texts.PARSING)
    query = data.get("people_query")
    if query is not None:
        query = replace(SearchQuery(**query), seed=random.randint(1, 1_000_002))
    await run_people(
        call.message,
        state,
        people_parser,
        settings,
        query=query,
        header=data["people_header"],
        mode=data["people_mode"],
        back=data["people_back"],
        edit=True,
        repeat=True,
    )
