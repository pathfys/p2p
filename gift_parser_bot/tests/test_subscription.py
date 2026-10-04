import asyncio

from aiogram.exceptions import TelegramBadRequest
from aiogram.methods import GetChatMember
from aiogram.types import ChatMemberLeft, ChatMemberMember, ChatMemberRestricted, User

from app.subscription import SubscriptionChecker

USER = User(id=5, is_bot=False, first_name="U")


class FakeBot:
    def __init__(self, member=None, error=None):
        self.member, self.error, self.calls = member, error, 0

    async def get_chat_member(self, chat_id, user_id):
        self.calls += 1
        assert chat_id == "@fiestagod"
        if self.error:
            raise self.error
        return self.member


def test_subscription_statuses_and_cache():
    async def main():
        checker = SubscriptionChecker("fiestagod", admin_ids=frozenset({1}))
        assert checker.channel == "@fiestagod" and checker.url == "https://t.me/fiestagod"

        left = FakeBot(ChatMemberLeft(user=USER))
        assert not await checker.is_subscribed(left, 5)
        assert await checker.is_subscribed(left, 1)  # админы проходят без проверки

        member = FakeBot(ChatMemberMember(user=USER))
        assert await checker.is_subscribed(member, 5)
        assert await checker.is_subscribed(member, 5) and member.calls == 1  # кеш
        assert await checker.is_subscribed(member, 5, use_cache=False) and member.calls == 2

        restricted = ChatMemberRestricted.model_construct(user=USER, is_member=False)
        assert not await checker.is_subscribed(FakeBot(restricted), 6)

        # бот не админ канала: проверка невозможна — не блокируем, но запоминаем ошибку для /admin
        broken = FakeBot(
            error=TelegramBadRequest(
                method=GetChatMember(chat_id="@fiestagod", user_id=7),
                message="Bad Request: member list is inaccessible",
            )
        )
        assert await checker.is_subscribed(broken, 7)
        assert "inaccessible" in checker.last_error

        assert await SubscriptionChecker(None).is_subscribed(left, 5)  # проверка выключена

    asyncio.run(main())
