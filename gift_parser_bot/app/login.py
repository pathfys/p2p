"""Одноразовая авторизация MTProto-аккаунтов для парсера:  python gift_parser_bot.py --login

Телефоны нигде не хранятся: номер каждого аккаунта вводится здесь, в консоли, а на
диск кладётся только файл сессии (data/<имя>.session). Уже авторизованные пропускаются,
поэтому команду можно безопасно повторять, чтобы добавить новый аккаунт.
"""

import asyncio

from telethon import TelegramClient

from .config import load_settings


async def main() -> None:
    settings = load_settings()
    if not settings.mtproto_enabled:
        print("Укажите API_ID и API_HASH в .env (получить: https://my.telegram.org -> API development tools).")
        return

    paths = settings.session_paths
    print(f"Сессий к настройке: {len(paths)} ({', '.join(p.name for p in paths)})\n")
    for index, path in enumerate(paths, start=1):
        path.parent.mkdir(parents=True, exist_ok=True)
        client = TelegramClient(str(path), settings.api_id, settings.api_hash)
        await client.connect()
        try:
            if await client.is_user_authorized():
                me = await client.get_me()
                print(f"[{index}/{len(paths)}] {path.name}: уже авторизована (@{me.username or me.first_name})")
                continue
            print(f"[{index}/{len(paths)}] {path.name}: введите номер телефона этого аккаунта")
            await client.start()  # спросит телефон, код из Telegram и пароль 2FA
            me = await client.get_me()
            print(f"    готово: {me.first_name} (@{me.username})")
        finally:
            await client.disconnect()

    print("\nВсе сессии настроены. Запуск парсера: python gift_parser_bot.py")


if __name__ == "__main__":
    asyncio.run(main())
