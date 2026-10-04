"""Одноразовая авторизация MTProto-аккаунта для парсера:  python -m app.login"""

import asyncio

from telethon import TelegramClient

from .config import load_settings


async def main() -> None:
    settings = load_settings()
    if not settings.mtproto_enabled:
        print("Укажите API_ID и API_HASH в .env (получить: https://my.telegram.org → API development tools).")
        return
    settings.mtproto_session.parent.mkdir(parents=True, exist_ok=True)
    client = TelegramClient(str(settings.mtproto_session), settings.api_id, settings.api_hash)
    await client.start()  # спросит телефон, код и пароль 2FA
    me = await client.get_me()
    print(f"Готово: сессия сохранена для {me.first_name} (@{me.username}).")
    await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
