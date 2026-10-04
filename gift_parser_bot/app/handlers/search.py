"""Быстрый поиск, поиск по фильтрам (подарок, фон, модель, узор) и пагинация.

Результат поиска — люди: 10 на странице, 2 страницы (см. people_view.py).
Поиск по @username по-прежнему показывает подарки этого владельца постранично.
"""

from __future__ import annotations

import logging
import random
from dataclasses import asdict
from html import escape

from aiogram import F, Router
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, Message

from .. import keyboards as kb
from .. import texts
from ..config import Settings
from ..crawler import Crawler
from ..db import TIERS, Database, SearchQuery
from ..parsers.models import normalize_slug
from ..people import PeopleParser
from .common import safe_edit
from .people_view import run_people

router = Router(name="search")
router.message.filter(F.chat.type == "private")  # в группах не отвечаем на каждое сообщение
log = logging.getLogger(__name__)


class Search(StatesGroup):
    quick = State()


def tier_of(mode: str) -> str | None:
    return mode if mode in TIERS else None


async def show_results(
    message: Message,
    state: FSMContext,
    db: Database,
    settings: Settings,
    query: SearchQuery,
    header: str,
    mode: str,
    *,
    page: int = 0,
    back: str = "quick",
    edit: bool = True,
) -> None:
    per_page = settings.results_per_page
    rows, total = await db.search(query, limit=per_page, offset=page * per_page)
    pages = max(1, -(-total // per_page))
    await state.update_data(last_query=asdict(query), last_header=header, last_mode=mode, last_back=back)
    text = texts.results(header, mode, rows, total, page, pages)
    markup = kb.results(page, pages, back)
    if edit:
        await safe_edit(message, text, markup)
    else:
        await message.answer(text, reply_markup=markup)


# ------------------------------------------------------------- быстрый поиск
@router.callback_query(kb.MenuCb.filter(F.action == "quick"))
async def cb_quick(call: CallbackQuery, state: FSMContext) -> None:
    await state.set_state(Search.quick)
    await safe_edit(call.message, texts.QUICK_PROMPT, kb.back_to_menu())
    await call.answer()


@router.message(F.text & ~F.text.startswith("/"))
async def on_text(
    message: Message,
    state: FSMContext,
    db: Database,
    crawler: Crawler,
    people_parser: PeopleParser,
    settings: Settings,
) -> None:
    """Любой текст = быстрый поиск (не нужно каждый раз нажимать кнопку)."""
    await state.set_state(None)
    raw = message.text.strip()[:100]
    mode = await db.get_mode(message.from_user.id)

    if slug := normalize_slug(raw):  # ссылка t.me/nft/... или Slug-123 — живой запрос
        try:
            await crawler.fetch_gift(slug)
        except Exception as e:
            log.warning("live fetch %s: %s", slug, e)
        row = await db.gift(slug)
        text = texts.gift_card(row) if row else texts.GIFT_NOT_FOUND
        await message.answer(text, reply_markup=kb.results(0, 1, "quick"))
        return

    if raw.startswith("@") and len(raw) > 1:
        username = raw[1:].split()[0]
        if crawler.mtproto:  # живой запрос полного портфеля
            try:
                await crawler.lookup_username(username)
            except Exception as e:
                log.warning("mtproto lookup @%s: %s", username, e)
        query = SearchQuery(owner=username, seed=random.randint(1, 1_000_002))
        header = f"Подарки владельца @{escape(username)}"
        await show_results(message, state, db, settings, query, header, "all", edit=False)
        return

    query = SearchQuery(text=raw, tier=tier_of(mode), seed=random.randint(1, 1_000_002))
    await run_people(
        message,
        state,
        people_parser,
        settings,
        query=query,
        header=f"«{escape(raw)}»",
        mode=mode,
        back="quick",
        edit=False,
    )


@router.callback_query(kb.PageCb.filter())
async def cb_page(
    call: CallbackQuery, callback_data: kb.PageCb, state: FSMContext, db: Database, settings: Settings
) -> None:
    data = await state.get_data()
    if "last_query" not in data:
        await call.answer(texts.SEARCH_EXPIRED, show_alert=True)
        return
    await show_results(
        call.message,
        state,
        db,
        settings,
        SearchQuery(**data["last_query"]),
        data["last_header"],
        data["last_mode"],
        page=callback_data.page,
        back=data.get("last_back", "quick"),
    )
    await call.answer()


# ----------------------------------------------------------- поиск по фильтрам
async def _render_panel(call: CallbackQuery, state: FSMContext, db: Database, settings: Settings) -> None:
    filters = (await state.get_data()).get("filters", {})
    mode = await db.get_mode(call.from_user.id)
    await safe_edit(call.message, texts.filters_panel(filters, mode, settings), kb.filters_panel(filters, mode))


@router.callback_query(kb.MenuCb.filter(F.action == "filters"))
async def cb_filters(call: CallbackQuery, state: FSMContext, db: Database, settings: Settings) -> None:
    await state.set_state(None)
    await _render_panel(call, state, db, settings)
    await call.answer()


@router.callback_query(kb.FilterCb.filter(F.action == "pick"))
async def cb_pick(call: CallbackQuery, callback_data: kb.FilterCb, state: FSMContext, db: Database) -> None:
    field = callback_data.field
    if field not in texts.FIELDS:
        await call.answer()
        return
    filters = (await state.get_data()).get("filters", {})
    if field == "collection":
        options = [(c["slug"], c["title"] or c["slug"]) for c in await db.collections()]
    else:
        if field in ("model", "symbol") and not filters.get("collection"):
            await call.answer("Сначала выберите подарок: модели и узоры у каждой коллекции свои.", show_alert=True)
            return
        options = [(v, v) for v in await db.distinct_values(field, filters.get("collection"))]
    if not options:
        await call.answer("В базе пока нет вариантов — дождитесь работы парсера.", show_alert=True)
        return

    await state.update_data(opts_field=field, opts=[o[0] for o in options], opts_titles=[o[1] for o in options])
    markup, pages = kb.picker(field, [o[1] for o in options], callback_data.page)
    page = min(max(callback_data.page, 0), pages - 1)
    await safe_edit(call.message, texts.picker_title(field, page, pages), markup)
    await call.answer()


@router.callback_query(kb.FilterCb.filter(F.action == "set"))
async def cb_set(
    call: CallbackQuery, callback_data: kb.FilterCb, state: FSMContext, db: Database, settings: Settings
) -> None:
    data = await state.get_data()
    filters = dict(data.get("filters", {}))
    field, idx = callback_data.field, callback_data.idx
    if idx < 0:
        filters.pop(field, None)
        filters.pop(f"{field}_title", None)
    else:
        opts, titles = data.get("opts") or [], data.get("opts_titles") or []
        if data.get("opts_field") != field or idx >= len(opts):
            await call.answer(texts.SEARCH_EXPIRED, show_alert=True)
            return
        filters[field] = opts[idx]
        if titles[idx] != opts[idx]:
            filters[f"{field}_title"] = titles[idx]
    if field == "collection":  # модели и узоры зависят от коллекции
        for dependent in ("model", "symbol"):
            filters.pop(dependent, None)
            filters.pop(f"{dependent}_title", None)
    await state.update_data(filters=filters)
    await _render_panel(call, state, db, settings)
    await call.answer()


@router.callback_query(kb.FilterCb.filter(F.action == "reset"))
async def cb_reset(call: CallbackQuery, state: FSMContext, db: Database, settings: Settings) -> None:
    await state.update_data(filters={})
    await _render_panel(call, state, db, settings)
    await call.answer("Фильтры сброшены")


@router.callback_query(kb.FilterCb.filter(F.action == "search"))
async def cb_search(
    call: CallbackQuery, state: FSMContext, db: Database, people_parser: PeopleParser, settings: Settings
) -> None:
    filters = (await state.get_data()).get("filters", {})
    mode = await db.get_mode(call.from_user.id)
    query = SearchQuery(
        collection=filters.get("collection"),
        backdrop=filters.get("backdrop"),
        model=filters.get("model"),
        symbol=filters.get("symbol"),
        tier=tier_of(mode),
        seed=random.randint(1, 1_000_002),
    )
    await call.answer(texts.PARSING)
    await run_people(
        call.message,
        state,
        people_parser,
        settings,
        query=query,
        header=texts.filters_summary(filters),
        mode=mode,
        back="filters",
        edit=True,
    )
