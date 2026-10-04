from aiogram import Router

from . import admin, menu, people_view, search, subscription


def build_routers(admin_ids: frozenset[int]) -> list[Router]:
    # порядок важен: search ловит любой текст, поэтому он последний
    return [subscription.router, admin.build_router(admin_ids), menu.router, people_view.router, search.router]
