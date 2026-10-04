from aiogram import Router

from . import admin, menu, search


def build_routers(admin_ids: frozenset[int]) -> list[Router]:
    # порядок важен: search ловит любой текст, поэтому он последний
    return [admin.build_router(admin_ids), menu.router, search.router]
