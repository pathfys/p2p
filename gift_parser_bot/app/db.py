"""SQLite-хранилище: пользователи бота, коллекции, владельцы и их подарки."""

from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import aiosqlite

from .gender import looks_female
from .parsers.models import Owner, ParsedGift, Portfolio

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Пользователи бота + аккаунты, найденные парсером (отправители подарков)
CREATE TABLE IF NOT EXISTS users (
    user_id          INTEGER PRIMARY KEY,
    username         TEXT,
    first_name       TEXT,
    is_bot_user      INTEGER NOT NULL DEFAULT 0,
    mode             TEXT    NOT NULL DEFAULT 'all',
    created_at       INTEGER NOT NULL,
    last_seen        INTEGER,
    gifts_checked_at INTEGER
);

CREATE TABLE IF NOT EXISTS collections (
    slug             TEXT PRIMARY KEY,          -- 'plushpepe'
    title            TEXT,                      -- 'Plush Pepe'
    issued           INTEGER,
    total            INTEGER,
    floor_ton        REAL,
    floor_manual     INTEGER NOT NULL DEFAULT 0,
    floor_updated_at INTEGER,
    next_number      INTEGER NOT NULL DEFAULT 1, -- курсор парсера (контрольная точка)
    crawled_at       INTEGER,
    enabled          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS owners (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER UNIQUE,
    username         TEXT UNIQUE COLLATE NOCASE,
    ton_address      TEXT UNIQUE,
    name             TEXT,
    gifts_count      INTEGER NOT NULL DEFAULT 0,
    value_ton        REAL    NOT NULL DEFAULT 0,
    tier             TEXT    NOT NULL DEFAULT 'light',
    gifts_checked_at INTEGER,
    updated_at       INTEGER
);

CREATE TABLE IF NOT EXISTS gifts (
    slug             TEXT PRIMARY KEY,          -- 'plushpepe-1'
    collection       TEXT NOT NULL,
    number           INTEGER NOT NULL,
    model            TEXT,
    model_rarity     INTEGER,
    backdrop         TEXT,
    backdrop_rarity  INTEGER,
    symbol           TEXT,
    symbol_rarity    INTEGER,
    owner_id         INTEGER REFERENCES owners(id) ON DELETE SET NULL,
    owner_name       TEXT,
    source           TEXT,
    updated_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_gifts_collection ON gifts(collection, number);
CREATE INDEX IF NOT EXISTS idx_gifts_backdrop   ON gifts(backdrop COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_gifts_model      ON gifts(collection, model COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_gifts_symbol     ON gifts(symbol COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_gifts_owner      ON gifts(owner_id);
CREATE INDEX IF NOT EXISTS idx_owners_tier      ON owners(tier, value_ton);
"""

GIFT_SELECT = """
SELECT g.rowid AS gift_rowid, g.owner_id, g.slug, g.number, COALESCE(c.title, g.collection) AS title,
       g.model, g.model_rarity, g.backdrop, g.backdrop_rarity, g.symbol, g.symbol_rarity,
       g.owner_name, o.username, o.name AS o_name, o.ton_address, o.user_id,
       o.tier, o.gifts_count, o.value_ton
FROM gifts g
LEFT JOIN owners o ON o.id = g.owner_id
LEFT JOIN collections c ON c.slug = g.collection
"""

FILTER_FIELDS = ("collection", "backdrop", "model", "symbol")
TIERS = ("light", "medium", "rich")
# «Человек» в выдаче — Telegram-аккаунт (TON-кошельки и скрытые владельцы не считаются)
PERSON = "(o.username IS NOT NULL OR o.user_id IS NOT NULL)"


@dataclass
class SearchQuery:
    text: str | None = None  # свободный текст (быстрый поиск)
    collection: str | None = None
    backdrop: str | None = None
    model: str | None = None
    symbol: str | None = None
    owner: str | None = None  # @username владельца
    tier: str | None = None  # light | medium | rich | None (= все)
    min_gifts: int | None = None  # владелец имеет не меньше N подарков (фильтр «По NFT»)
    min_rarity: int | None = None  # редкость модели не хуже N‰ (фильтр «По редкости»)
    female: bool = False  # только владельцы с женским именем (поиск «Девочки»)
    seed: int = 1  # для стабильного «случайного» порядка между страницами


def now() -> int:
    return int(time.time())


class Database:
    def __init__(self, path: Path, *, medium_ton: float, rich_ton: float, default_gift_ton: float):
        self.path = path
        self.medium_ton = medium_ton
        self.rich_ton = rich_ton
        self.default_gift_ton = default_gift_ton
        self._conn: aiosqlite.Connection | None = None
        self._stats_cache: tuple[float, dict[str, int]] | None = None
        # save_gifts делает SELECT -> INSERT владельца; без блокировки параллельные корутины
        # (фоновый парсер + живые проверки) могут вставить одного владельца дважды
        self._write_lock = asyncio.Lock()

    @property
    def conn(self) -> aiosqlite.Connection:
        assert self._conn is not None, "Database.connect() не вызван"
        return self._conn

    async def connect(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = await aiosqlite.connect(self.path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.executescript(SCHEMA)
        await self._conn.commit()

    async def close(self) -> None:
        if self._conn:
            await self._conn.close()
            self._conn = None

    # ------------------------------------------------------------------ users
    async def touch_user(self, user_id: int, username: str | None, first_name: str | None) -> bool:
        """Регистрирует пользователя бота. True — если он новый."""
        cur = await self.conn.execute("SELECT 1 FROM users WHERE user_id = ? AND is_bot_user = 1", (user_id,))
        is_new = await cur.fetchone() is None
        await self.conn.execute(
            """INSERT INTO users (user_id, username, first_name, is_bot_user, created_at, last_seen)
               VALUES (?, ?, ?, 1, ?, ?)
               ON CONFLICT(user_id) DO UPDATE SET username = excluded.username,
                   first_name = excluded.first_name, is_bot_user = 1, last_seen = excluded.last_seen""",
            (user_id, username, first_name, now(), now()),
        )
        await self.conn.commit()
        return is_new

    async def get_mode(self, user_id: int) -> str:
        cur = await self.conn.execute("SELECT mode FROM users WHERE user_id = ?", (user_id,))
        row = await cur.fetchone()
        return row["mode"] if row else "all"

    async def set_mode(self, user_id: int, mode: str) -> None:
        await self.conn.execute(
            """INSERT INTO users (user_id, is_bot_user, mode, created_at, last_seen) VALUES (?, 1, ?, ?, ?)
               ON CONFLICT(user_id) DO UPDATE SET mode = excluded.mode, is_bot_user = 1""",
            (user_id, mode, now(), now()),
        )
        await self.conn.commit()

    async def add_seen_users(self, users: Iterable[Owner]) -> None:
        rows = [(u.user_id, u.username, u.name, now()) for u in users if u.user_id]
        if not rows:
            return
        await self.conn.executemany(
            """INSERT INTO users (user_id, username, first_name, created_at) VALUES (?, ?, ?, ?)
               ON CONFLICT(user_id) DO UPDATE SET username = COALESCE(excluded.username, users.username)""",
            rows,
        )
        await self.conn.commit()

    async def users_to_check(self, limit: int, stale_before: int) -> list[aiosqlite.Row]:
        cur = await self.conn.execute(
            """SELECT user_id, username, first_name FROM users
               WHERE gifts_checked_at IS NULL OR gifts_checked_at < ?
               ORDER BY is_bot_user DESC, gifts_checked_at IS NOT NULL, gifts_checked_at
               LIMIT ?""",
            (stale_before, limit),
        )
        return list(await cur.fetchall())

    async def mark_user_checked(self, user_id: int) -> None:
        await self.conn.execute("UPDATE users SET gifts_checked_at = ? WHERE user_id = ?", (now(), user_id))
        await self.conn.commit()

    # ------------------------------------------------------------ collections
    async def upsert_collections(self, items: Iterable[tuple[str, str]]) -> int:
        before = await self._scalar("SELECT COUNT(*) FROM collections")
        await self.conn.executemany(
            "INSERT INTO collections (slug, title) VALUES (?, ?) ON CONFLICT(slug) DO NOTHING",
            list(items),
        )
        await self.conn.commit()
        return await self._scalar("SELECT COUNT(*) FROM collections") - before

    async def set_floor(self, slug: str, floor_ton: float | None, *, manual: bool = False) -> bool:
        """Обновляет floor. Автоматическое обновление не перетирает ручное значение админа."""
        cond = "" if manual else " AND floor_manual = 0"
        cur = await self.conn.execute(
            f"UPDATE collections SET floor_ton = ?, floor_manual = ?, floor_updated_at = ? WHERE slug = ?{cond}",
            (floor_ton, int(manual), now(), slug),
        )
        await self.conn.commit()
        return cur.rowcount > 0

    async def collections(self) -> list[aiosqlite.Row]:
        cur = await self.conn.execute("SELECT * FROM collections ORDER BY COALESCE(title, slug) COLLATE NOCASE")
        return list(await cur.fetchall())

    async def collections_to_crawl(self, recrawl_before: int, min_floor_ton: float = 0) -> list[aiosqlite.Row]:
        """Сначала дорогие коллекции: там владельцы для режима rich."""
        await self.conn.execute(
            """UPDATE collections SET next_number = 1, crawled_at = NULL
               WHERE crawled_at IS NOT NULL AND crawled_at < ?""",
            (recrawl_before,),
        )
        await self.conn.commit()
        cur = await self.conn.execute(
            """SELECT * FROM collections
               WHERE enabled = 1 AND crawled_at IS NULL AND (floor_ton IS NULL OR floor_ton >= ?)
               ORDER BY floor_ton IS NULL, floor_ton DESC, slug""",
            (min_floor_ton,),
        )
        return list(await cur.fetchall())

    async def set_cursor(self, slug: str, next_number: int, *, finished: bool = False) -> None:
        await self.conn.execute(
            "UPDATE collections SET next_number = ?, crawled_at = ? WHERE slug = ?",
            (next_number, now() if finished else None, slug),
        )
        await self.conn.commit()

    async def restart_collection(self, slug: str) -> bool:
        cur = await self.conn.execute(
            "UPDATE collections SET next_number = 1, crawled_at = NULL, enabled = 1 WHERE slug = ?", (slug,)
        )
        await self.conn.commit()
        return cur.rowcount > 0

    # ------------------------------------------------------------------ gifts
    async def _owner_id(self, owner: Owner | None) -> int | None:
        if owner is None or not owner.identifiable:
            return None
        ids: list[int] = []
        for column, value in (
            ("user_id", owner.user_id),
            ("username", owner.username),
            ("ton_address", owner.ton_address),
        ):
            if value is None:
                continue
            cur = await self.conn.execute(f"SELECT id FROM owners WHERE {column} = ?", (value,))
            if (row := await cur.fetchone()) and row["id"] not in ids:
                ids.append(row["id"])

        if not ids:
            cur = await self.conn.execute(
                "INSERT INTO owners (user_id, username, ton_address, name, updated_at) VALUES (?, ?, ?, ?, ?)",
                (owner.user_id, owner.username, owner.ton_address, owner.name, now()),
            )
            return cur.lastrowid

        keep, *duplicates = sorted(ids)
        for dup in duplicates:  # один и тот же человек найден разными источниками — склеиваем
            await self.conn.execute("UPDATE gifts SET owner_id = ? WHERE owner_id = ?", (keep, dup))
            await self.conn.execute("DELETE FROM owners WHERE id = ?", (dup,))
        await self.conn.execute(
            """UPDATE owners SET user_id = COALESCE(?, user_id), username = COALESCE(?, username),
                   ton_address = COALESCE(?, ton_address), name = COALESCE(?, name), updated_at = ?
               WHERE id = ?""",
            (owner.user_id, owner.username, owner.ton_address, owner.name, now(), keep),
        )
        return keep

    async def save_gifts(self, gifts: Iterable[ParsedGift]) -> set[int]:
        """Сохраняет подарки и владельцев; пересчитывает режимы затронутых владельцев."""
        async with self._write_lock:
            return await self._save_gifts(gifts)

    async def _save_gifts(self, gifts: Iterable[ParsedGift]) -> set[int]:
        touched: set[int] = set()
        meta: dict[str, ParsedGift] = {}
        for gift in gifts:
            cur = await self.conn.execute(
                "SELECT g.owner_id, o.name FROM gifts g LEFT JOIN owners o ON o.id = g.owner_id WHERE g.slug = ?",
                (gift.slug,),
            )
            old = await cur.fetchone()
            owner_id = await self._owner_id(gift.owner)
            if old and old["owner_id"]:
                touched.add(old["owner_id"])
                # на странице только имя, а владелец уже известен (по Bot API) — не теряем его
                if owner_id is None and gift.owner_name and gift.owner_name == old["name"]:
                    owner_id = old["owner_id"]
            if owner_id:
                touched.add(owner_id)
            await self.conn.execute(
                """INSERT INTO gifts (slug, collection, number, model, model_rarity, backdrop, backdrop_rarity,
                                      symbol, symbol_rarity, owner_id, owner_name, source, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(slug) DO UPDATE SET
                       model = excluded.model, model_rarity = excluded.model_rarity,
                       backdrop = excluded.backdrop, backdrop_rarity = excluded.backdrop_rarity,
                       symbol = excluded.symbol, symbol_rarity = excluded.symbol_rarity,
                       owner_id = excluded.owner_id, owner_name = excluded.owner_name,
                       source = excluded.source, updated_at = excluded.updated_at""",
                (
                    gift.slug,
                    gift.collection,
                    gift.number,
                    gift.model,
                    gift.model_rarity,
                    gift.backdrop,
                    gift.backdrop_rarity,
                    gift.symbol,
                    gift.symbol_rarity,
                    owner_id,
                    None if owner_id else gift.owner_name,
                    gift.source,
                    now(),
                ),
            )
            if gift.collection not in meta or (gift.issued or 0) > (meta[gift.collection].issued or 0):
                meta[gift.collection] = gift

        for slug, gift in meta.items():
            await self.conn.execute(
                """INSERT INTO collections (slug, title, issued, total) VALUES (?, ?, ?, ?)
                   ON CONFLICT(slug) DO UPDATE SET title = excluded.title,
                       issued = MAX(COALESCE(collections.issued, 0), COALESCE(excluded.issued, 0)),
                       total = COALESCE(excluded.total, collections.total)""",
                (slug, gift.title, gift.issued, gift.total),
            )
        await self.recompute_owners(touched)
        await self.conn.commit()
        return touched

    async def save_portfolio(self, portfolio: Portfolio) -> int:
        """Полный список NFT одного аккаунта (Bot API / MTProto)."""
        async with self._write_lock:
            for gift in portfolio.gifts:
                gift.owner = portfolio.owner
            await self._save_gifts(portfolio.gifts)
            owner_id = await self._owner_id(portfolio.owner)
            if owner_id and portfolio.complete:
                # подарки, которых больше нет в портфеле, отвязываем от владельца
                slugs = [g.slug for g in portfolio.gifts]
                marks = ",".join("?" * len(slugs)) or "''"
                await self.conn.execute(
                    f"UPDATE gifts SET owner_id = NULL WHERE owner_id = ? AND slug NOT IN ({marks})",
                    (owner_id, *slugs),
                )
                await self.conn.execute("UPDATE owners SET gifts_checked_at = ? WHERE id = ?", (now(), owner_id))
                await self.recompute_owners({owner_id})
            await self.conn.commit()
            return len(portfolio.gifts)

    async def recompute_owners(self, ids: set[int] | None = None) -> None:
        """Количество NFT, оценка портфеля в TON и режим (light / medium / rich)."""
        sql = """
            UPDATE owners SET
                gifts_count = (SELECT COUNT(*) FROM gifts g WHERE g.owner_id = owners.id),
                value_ton = (SELECT COALESCE(SUM(COALESCE(c.floor_ton, :def)), 0)
                             FROM gifts g LEFT JOIN collections c ON c.slug = g.collection
                             WHERE g.owner_id = owners.id)
            {where};
            UPDATE owners SET tier = CASE WHEN value_ton >= :rich THEN 'rich'
                                          WHEN value_ton >= :medium THEN 'medium'
                                          ELSE 'light' END
            {where};
        """
        params = {"def": self.default_gift_ton, "rich": self.rich_ton, "medium": self.medium_ton}
        batches: list[list[int]] = [[]] if ids is None else _chunks(sorted(i for i in ids if i), 500)
        for batch in batches:
            where = f"WHERE id IN ({','.join(map(str, batch))})" if ids is not None else ""
            for statement in sql.format(where=where).split(";"):
                if statement.strip():
                    await self.conn.execute(statement, params)

    async def owner_ids_by_identity(self, user_id: int | None = None, username: str | None = None) -> int | None:
        for column, value in (("user_id", user_id), ("username", username)):
            if value is not None:
                cur = await self.conn.execute(f"SELECT id FROM owners WHERE {column} = ?", (value,))
                if row := await cur.fetchone():
                    return row["id"]
        return None

    async def owners_to_enrich(self, limit: int, stale_before: int) -> list[aiosqlite.Row]:
        """Для MTProto: владельцы с @username, чей портфель давно не обновлялся (богатые — первыми)."""
        cur = await self.conn.execute(
            """SELECT id, username FROM owners
               WHERE username IS NOT NULL AND (gifts_checked_at IS NULL OR gifts_checked_at < ?)
               ORDER BY value_ton DESC LIMIT ?""",
            (stale_before, limit),
        )
        return list(await cur.fetchall())

    async def mark_owner_checked(self, owner_id: int) -> None:
        await self.conn.execute("UPDATE owners SET gifts_checked_at = ? WHERE id = ?", (now(), owner_id))
        await self.conn.commit()

    # ----------------------------------------------------------------- search
    @staticmethod
    def _gift_conditions(q: SearchQuery) -> tuple[list[str], list[object]]:
        """Условия по самому подарку: коллекция, фон, модель, узор и свободный текст."""
        where: list[str] = []
        args: list[object] = []
        for field in FILTER_FIELDS:
            value = getattr(q, field)
            if value:
                where.append(f"g.{field} = ? COLLATE NOCASE")
                args.append(value)
        if q.min_rarity:
            where.append("g.model_rarity IS NOT NULL AND g.model_rarity <= ?")
            args.append(q.min_rarity)
        for word in (q.text or "").split():
            like = f"%{word}%"
            where.append(
                "(c.title LIKE ? OR g.collection LIKE ? OR g.model LIKE ? OR g.backdrop LIKE ? OR g.symbol LIKE ?)"
            )
            args += [like, like, like, like, like]
        return where, args

    async def search(self, q: SearchQuery, *, limit: int, offset: int) -> tuple[list[aiosqlite.Row], int]:
        where, args = self._gift_conditions(q)
        if q.owner:
            where.append("o.username = ?")
            args.append(q.owner.lstrip("@"))
        if q.tier in TIERS:
            where.append("o.tier = ?")
            args.append(q.tier)

        cond = f"WHERE {' AND '.join(where)}" if where else ""
        total = await self._scalar(
            f"SELECT COUNT(*) FROM gifts g LEFT JOIN owners o ON o.id = g.owner_id "
            f"LEFT JOIN collections c ON c.slug = g.collection {cond}",
            args,
        )
        shuffle = f"((g.rowid * {int(q.seed) % 1000003 or 1}) % 1000003)"
        order = f"o.value_ton DESC, {shuffle}" if q.tier == "rich" else shuffle
        cur = await self.conn.execute(f"{GIFT_SELECT} {cond} ORDER BY {order} LIMIT ? OFFSET ?", (*args, limit, offset))
        return list(await cur.fetchall()), total

    async def gift(self, slug: str) -> aiosqlite.Row | None:
        cur = await self.conn.execute(f"{GIFT_SELECT} WHERE g.slug = ?", (slug,))
        return await cur.fetchone()

    async def search_people(self, q: SearchQuery, *, limit: int, exclude: Iterable[int] = ()) -> list[dict]:
        """Люди, у которых есть подходящий подарок. Для каждого — самый дорогой из подходящих подарков."""
        where, args = self._gift_conditions(q)
        gift_filtered = bool(where)
        where.append(PERSON)
        if q.tier in TIERS:
            where.append("o.tier = ?")
            args.append(q.tier)
        if q.min_gifts:
            where.append("o.gifts_count >= ?")
            args.append(q.min_gifts)
        if excluded := ",".join(str(int(i)) for i in exclude):
            where.append(f"o.id NOT IN ({excluded})")
        shuffle = f"((o.id * {int(q.seed) % 1000003 or 1}) % 1000003)"
        order = f"o.value_ton DESC, {shuffle}" if q.tier == "rich" else shuffle
        cond = " AND ".join(where)
        fetch = limit * 8 if q.female else limit  # по имени фильтруем в Python — берём с запасом
        if gift_filtered:
            # bare-колонка g.rowid берётся из строки с MAX(floor) — особенность SQLite
            sql = f"""SELECT o.id AS owner_id, COUNT(*) AS matched, g.rowid AS gift_rowid,
                             MAX(COALESCE(c.floor_ton, 0)) AS best_floor
                      FROM gifts g JOIN owners o ON o.id = g.owner_id
                      LEFT JOIN collections c ON c.slug = g.collection
                      WHERE {cond} GROUP BY o.id ORDER BY {order} LIMIT ?"""
        else:  # без фильтров по подарку идём от таблицы владельцев — это быстрее
            sql = f"""SELECT o.id AS owner_id, 1 AS matched,
                             (SELECT g.rowid FROM gifts g LEFT JOIN collections c ON c.slug = g.collection
                              WHERE g.owner_id = o.id ORDER BY COALESCE(c.floor_ton, 0) DESC LIMIT 1) AS gift_rowid
                      FROM owners o WHERE {cond} AND o.gifts_count > 0 ORDER BY {order} LIMIT ?"""
        cur = await self.conn.execute(sql, (*args, fetch))
        people = await self._people_rows(list(await cur.fetchall()))
        if q.female:
            people = [p for p in people if looks_female(p["o_name"], p["username"])][:limit]
        return people

    async def random_people(self, count: int, *, exclude: Iterable[int] = ()) -> list[dict]:
        """Режим «Все подарки»: случайные люди со случайным подарком, по возможности из разных коллекций."""
        excluded = {int(i) for i in exclude}
        max_id = await self._scalar("SELECT COALESCE(MAX(id), 0) FROM owners")
        if not max_id:
            return []
        conditions = f"{PERSON} AND o.gifts_count > 0"
        if max_id > count * 50:  # большая база: случайные id вместо ORDER BY RANDOM() по всей таблице
            ids = [i for i in random.sample(range(1, max_id + 1), min(max_id, count * 40)) if i not in excluded]
            conditions += f" AND o.id IN ({','.join(map(str, ids)) or '0'})"
        elif excluded:
            conditions += f" AND o.id NOT IN ({','.join(map(str, excluded))})"
        cur = await self.conn.execute(
            f"""SELECT o.id AS owner_id, 1 AS matched,
                       (SELECT g.rowid FROM gifts g WHERE g.owner_id = o.id ORDER BY RANDOM() LIMIT 1) AS gift_rowid
                FROM owners o WHERE {conditions} ORDER BY RANDOM() LIMIT ?""",
            (count * 3,),
        )
        people = await self._people_rows(list(await cur.fetchall()))
        picked, rest, seen = [], [], set()
        for person in people:  # сначала по одному человеку на коллекцию — «абсолютно разные подарки»
            (rest if person["title"] in seen else picked).append(person)
            seen.add(person["title"])
        return (picked + rest)[:count]

    async def _people_rows(self, picks: list[aiosqlite.Row]) -> list[dict]:
        rowids = [p["gift_rowid"] for p in picks if p["gift_rowid"] is not None]
        if not rowids:
            return []
        cur = await self.conn.execute(f"{GIFT_SELECT} WHERE g.rowid IN ({','.join(map(str, rowids))})")
        gifts = {row["gift_rowid"]: dict(row) for row in await cur.fetchall()}
        return [{**gifts[p["gift_rowid"]], "matched": p["matched"]} for p in picks if p["gift_rowid"] in gifts]

    async def distinct_values(self, field: str, collection: str | None = None) -> list[str]:
        if field not in ("backdrop", "model", "symbol"):
            raise ValueError(field)
        cond, args = "", []
        if collection:
            cond, args = "AND collection = ?", [collection]
        cur = await self.conn.execute(
            f"SELECT DISTINCT {field} AS v FROM gifts WHERE {field} IS NOT NULL {cond} ORDER BY v COLLATE NOCASE",
            args,
        )
        return [row["v"] for row in await cur.fetchall()]

    async def cached_stats(self, ttl: float = 60.0) -> dict[str, int]:
        """COUNT(*) по большой таблице не бесплатный — кешируем для приветствия."""
        if self._stats_cache is None or time.monotonic() - self._stats_cache[0] > ttl:
            self._stats_cache = (time.monotonic(), await self.stats())
        return self._stats_cache[1]

    async def stats(self) -> dict[str, int]:
        result = {
            "gifts": await self._scalar("SELECT COUNT(*) FROM gifts"),
            "owners": await self._scalar("SELECT COUNT(*) FROM owners WHERE gifts_count > 0"),
            "collections": await self._scalar("SELECT COUNT(*) FROM collections"),
            "users": await self._scalar("SELECT COUNT(*) FROM users WHERE is_bot_user = 1"),
        }
        cur = await self.conn.execute("SELECT tier, COUNT(*) AS n FROM owners WHERE gifts_count > 0 GROUP BY tier")
        for row in await cur.fetchall():
            result[row["tier"]] = row["n"]
        return result

    async def _scalar(self, sql: str, args: Iterable[object] = ()) -> int:
        cur = await self.conn.execute(sql, tuple(args))
        row = await cur.fetchone()
        return row[0] if row else 0


def _chunks(items: list[int], size: int) -> list[list[int]]:
    return [items[i : i + size] for i in range(0, len(items), size)]
