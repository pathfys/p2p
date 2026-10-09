"""Грубая эвристика пола по имени владельца (для поиска «Девочки»).

Пол в Telegram публично не отдаётся, поэтому определяем приблизительно по
отображаемому имени: известные женские/мужские имена + типичные женские окончания
(-а/-я/-ия/-на) с поправкой на распространённые мужские имена на -а/-я.
Это ориентир, а не точность 100%.
"""

from __future__ import annotations

import re

_FEMALE = {
    "анна",
    "мария",
    "маша",
    "катя",
    "екатерина",
    "ольга",
    "оля",
    "наталья",
    "наташа",
    "елена",
    "лена",
    "ирина",
    "ира",
    "света",
    "светлана",
    "юлия",
    "юля",
    "дарья",
    "даша",
    "алиса",
    "вика",
    "виктория",
    "настя",
    "анастасия",
    "полина",
    "софия",
    "соня",
    "ксения",
    "ксюша",
    "кристина",
    "валерия",
    "лера",
    "вероника",
    "алина",
    "диана",
    "карина",
    "милана",
    "арина",
    "эльвира",
    "лиза",
    "елизавета",
    "татьяна",
    "таня",
    "надежда",
    "надя",
    "галина",
    "людмила",
    "яна",
    "жанна",
    "инна",
    "лейла",
    "амина",
    "сабина",
    "камилла",
    "эвелина",
    "anna",
    "maria",
    "mary",
    "kate",
    "katie",
    "olga",
    "elena",
    "helen",
    "irina",
    "julia",
    "daria",
    "alice",
    "victoria",
    "nastya",
    "sofia",
    "sophie",
    "polina",
    "nika",
    "liza",
    "emma",
    "mia",
    "lily",
    "lilia",
    "nina",
    "vera",
    "eva",
    "diana",
    "karina",
    "milana",
    "angelina",
    "alina",
    "sabina",
    "kira",
    "margarita",
    "rita",
    "valeria",
    "kristina",
    "александра",
    "alexandra",
    "регина",
    "regina",
    "влада",
    "снежана",
    "марина",
    "marina",
    "олеся",
    "аня",
    "ника",
    "зоя",
    "ася",
    "уля",
    "рая",
    "тая",
    "роза",
    "majya",
    "anya",
    "olya",
    "katya",
    "sveta",
}
_MALE = {
    "никита",
    "илья",
    "данила",
    "лёша",
    "паша",
    "саша",
    "женя",
    "женёк",
    "кузьма",
    "фома",
    "лука",
    "гоша",
    "жора",
    "миша",
    "гриша",
    "витя",
    "коля",
    "вася",
    "петя",
    "дима",
    "вова",
    "вовка",
    "серёжа",
    "серёга",
    "боря",
    "толя",
    "гена",
    "лёва",
    "стёпа",
    "федя",
    "сёма",
    "костя",
    "слава",
    "валера",
    "андрюха",
    "nikita",
    "ilya",
    "danila",
    "luka",
    "kuzma",
    "sasha",
    "zhenya",
    "vitya",
    "kolya",
    "vasya",
    "petya",
    "dima",
    "vova",
    "borya",
    "tolya",
    "gena",
    "kostya",
    "seryoga",
}
_WORD = re.compile(r"[a-zа-яё]+", re.IGNORECASE)


def looks_female(name: str | None, username: str | None = None) -> bool:
    """True, если имя похоже на женское. Юзернейм используется как запасной вариант."""
    for source in (name, username):
        token = _first_token(source)
        if token is None:
            continue
        if token in _FEMALE:
            return True
        if token in _MALE:
            return False
        if _female_ending(token):
            return True
    return False


def _first_token(value: str | None) -> str | None:
    if not value:
        return None
    m = _WORD.search(value.lower())
    return m.group(0) if m else None


def _female_ending(token: str) -> bool:
    return len(token) >= 4 and token.endswith(("а", "я", "ия", "на", "ina", "ia", "iya", "ya"))
