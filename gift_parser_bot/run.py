"""Точка входа:  python run.py"""

import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import BotCommand

from app.config import load_settings
from app.crawler import Crawler
from app.db import Database
from app.handlers import build_routers


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = load_settings()

    db = Database(
        settings.db_path,
        medium_ton=settings.tier_medium_ton,
        rich_ton=settings.tier_rich_ton,
        default_gift_ton=settings.default_gift_ton,
    )
    await db.connect()

    bot = Bot(
        settings.bot_token,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML, link_preview_is_disabled=True),
    )
    crawler = Crawler(db, settings, bot)
    await crawler.setup()

    dp = Dispatcher(storage=MemoryStorage(), db=db, crawler=crawler, settings=settings)
    dp.include_routers(*build_routers(settings.admin_ids))

    await bot.set_my_commands([BotCommand(command="start", description="Главное меню")])
    if settings.autostart_parser:
        crawler.start()
    try:
        await dp.start_polling(bot)
    finally:
        await crawler.shutdown()
        await db.close()
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
