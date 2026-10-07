"""Inline-клавиатуры и callback-данные."""

from __future__ import annotations

from aiogram.filters.callback_data import CallbackData
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup
from aiogram.utils.keyboard import InlineKeyboardBuilder

from .ratelimit import SPEED_PRESETS
from .texts import FIELDS

PICKER_PAGE_SIZE = 16


class MenuCb(CallbackData, prefix="m"):
    action: str  # main | quick | filters | random | stats


class ModeCb(CallbackData, prefix="md"):
    mode: str
    src: str = "menu"  # где перерисовать клавиатуру: menu | filters


class FilterCb(CallbackData, prefix="f"):
    action: str  # pick | set | search | reset
    field: str = "-"
    page: int = 0
    idx: int = -1


class PageCb(CallbackData, prefix="p"):
    page: int


class PeopleCb(CallbackData, prefix="pp"):
    action: str  # page | repeat
    page: int = 0


class SubCb(CallbackData, prefix="sub"):
    action: str  # check


class AdminCb(CallbackData, prefix="a"):
    action: str  # start | stop | speed | sync | refresh
    value: str = "-"


def _btn(text: str, cb: CallbackData) -> InlineKeyboardButton:
    return InlineKeyboardButton(text=text, callback_data=cb.pack())


def main_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [_btn("Быстрый поиск", MenuCb(action="quick"))],
            [_btn("Поиск по фильтрам", MenuCb(action="filters"))],
            [_btn("Все подарки", MenuCb(action="random"))],
            [_btn("Статистика", MenuCb(action="stats"))],
        ]
    )


def quick_modes() -> InlineKeyboardMarkup:
    """Экран «Быстрый поиск»: три уровня владельцев."""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [_btn("Low", ModeCb(mode="light", src="quick"))],
            [_btn("Medium", ModeCb(mode="medium", src="quick"))],
            [_btn("Rich", ModeCb(mode="rich", src="quick"))],
            [_btn("Меню", MenuCb(action="main"))],
        ]
    )


def back_to_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[[_btn("Меню", MenuCb(action="main"))]])


def filters_panel(filters: dict) -> InlineKeyboardMarkup:
    def field_btn(field: str) -> InlineKeyboardButton:
        label, any_word = FIELDS[field]
        value = filters.get(f"{field}_title") or filters.get(field) or any_word
        return _btn(f"{label}: {value}", FilterCb(action="pick", field=field))

    return InlineKeyboardMarkup(
        inline_keyboard=[
            [field_btn("collection")],
            [field_btn("backdrop")],
            [field_btn("model"), field_btn("symbol")],
            [_btn("Найти", FilterCb(action="search"))],
            [_btn("Сбросить", FilterCb(action="reset")), _btn("Меню", MenuCb(action="main"))],
        ]
    )


def picker(field: str, labels: list[str], page: int) -> tuple[InlineKeyboardMarkup, int]:
    pages = max(1, -(-len(labels) // PICKER_PAGE_SIZE))
    page = min(max(page, 0), pages - 1)
    builder = InlineKeyboardBuilder()
    start = page * PICKER_PAGE_SIZE
    for idx in range(start, min(start + PICKER_PAGE_SIZE, len(labels))):
        builder.button(text=labels[idx], callback_data=FilterCb(action="set", field=field, idx=idx))
    builder.adjust(2)
    if pages > 1:
        builder.row(
            _btn("<", FilterCb(action="pick", field=field, page=(page - 1) % pages)),
            _btn(f"{page + 1}/{pages}", FilterCb(action="pick", field=field, page=page)),
            _btn(">", FilterCb(action="pick", field=field, page=(page + 1) % pages)),
        )
    _, any_word = FIELDS[field]
    builder.row(
        _btn(any_word.capitalize(), FilterCb(action="set", field=field, idx=-1)),
        _btn("К фильтрам", MenuCb(action="filters")),
    )
    return builder.as_markup(), pages


def results(page: int, pages: int, back: str) -> InlineKeyboardMarkup:
    rows = []
    if pages > 1:
        rows.append(
            [
                _btn("<", PageCb(page=(page - 1) % pages)),
                _btn(f"{page + 1}/{pages}", PageCb(page=page)),
                _btn(">", PageCb(page=(page + 1) % pages)),
            ]
        )
    second = (
        _btn("К фильтрам", MenuCb(action="filters"))
        if back == "filters"
        else _btn("Новый поиск", MenuCb(action="quick"))
    )
    rows.append([second, _btn("Меню", MenuCb(action="main"))])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def people(page: int, pages: int, back: str) -> InlineKeyboardMarkup:
    """Стр. 1: «След. страница». Последняя стр.: «Назад» и ниже «Повторить» (новый парсинг)."""
    rows = []
    if page < pages - 1:
        if page > 0:
            rows.append([_btn("Назад", PeopleCb(action="page", page=page - 1))])
        rows.append([_btn("След. страница", PeopleCb(action="page", page=page + 1))])
    else:
        if page > 0:
            rows.append([_btn("Назад", PeopleCb(action="page", page=page - 1))])
        rows.append([_btn("Повторить", PeopleCb(action="repeat"))])
    if back == "filters":
        rows.append([_btn("К фильтрам", MenuCb(action="filters")), _btn("Меню", MenuCb(action="main"))])
    elif back == "quick":
        rows.append([_btn("Новый поиск", MenuCb(action="quick")), _btn("Меню", MenuCb(action="main"))])
    else:
        rows.append([_btn("Меню", MenuCb(action="main"))])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def subscribe(url: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="Подписаться", url=url)],
            [_btn("Проверить подписку", SubCb(action="check"))],
        ]
    )


def admin_panel(running: bool, preset: str) -> InlineKeyboardMarkup:
    toggle = (
        _btn("Остановить парсер", AdminCb(action="stop"))
        if running
        else _btn("Запустить парсер", AdminCb(action="start"))
    )
    speed_row = [_btn(f"[{p}]" if p == preset else p, AdminCb(action="speed", value=p)) for p in SPEED_PRESETS]
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [toggle],
            speed_row,
            [_btn("Коллекции и floor", AdminCb(action="sync")), _btn("Обновить", AdminCb(action="refresh"))],
        ]
    )
