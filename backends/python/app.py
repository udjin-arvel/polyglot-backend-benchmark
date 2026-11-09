import asyncio
import json
import os
import re
import signal
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qs, urlparse

import asyncpg

JSON_CT = b"application/json; charset=utf-8"
PRICE_RE = re.compile(r"^\d+(\.\d{1,2})?$")
SORT_SET = frozenset({"created_at", "-created_at", "price", "-price"})

pool: asyncpg.Pool | None = None
_shutting_down = False
_inflight: set[asyncio.Task] = set()


async def create_pool() -> asyncpg.Pool:
    return await asyncpg.create_pool(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "5432")),
        database=os.getenv("DB_NAME", "polyglot"),
        user=os.getenv("DB_USER", "polyglot"),
        password=os.getenv("DB_PASSWORD", "polyglot"),
        min_size=1,
        max_size=int(os.getenv("DB_POOL_SIZE", "20")),
        timeout=5,
        command_timeout=5,
    )


async def app(scope, receive, send):
    if scope["type"] == "lifespan":
        await lifespan(scope, receive, send)
        return
    if scope["type"] != "http":
        return
    if _shutting_down:
        await respond(send, 503, {"error": {"code": "internal_error", "message": "internal error"}})
        return

    task = asyncio.current_task()
    if task:
        _inflight.add(task)
    try:
        await handle_http(scope, receive, send)
    finally:
        if task:
            _inflight.discard(task)


async def lifespan(scope, receive, send):
    global pool
    while True:
        message = await receive()
        if message["type"] == "lifespan.startup":
            pool = await create_pool()
            loop = asyncio.get_running_loop()
            loop.add_signal_handler(signal.SIGTERM, lambda: asyncio.create_task(begin_shutdown()))
            await send({"type": "lifespan.startup.complete"})
        elif message["type"] == "lifespan.shutdown":
            await begin_shutdown()
            if pool:
                await pool.close()
            await send({"type": "lifespan.shutdown.complete"})
            return


async def begin_shutdown():
    global _shutting_down
    _shutting_down = True
    deadline = asyncio.get_running_loop().time() + 5
    while _inflight and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)


async def handle_http(scope, receive, send):
    method = scope["method"]
    path = scope["path"]
    qs = parse_qs(scope.get("query_string", b"").decode())

    if method == "OPTIONS":
        await respond(send, 204, None, extra_headers=cors_headers())
        return

    try:
        if path == "/health" and method == "GET":
            if qs.get("db", [""])[0] == "1":
                await pool_fetchval("SELECT 1")
            await respond(send, 200, {"status": "ok"}, extra_headers=cors_headers())
            return
        if path == "/stats" and method == "GET":
            rows = await pool_fetch(
                """
                SELECT c.name AS category, COUNT(i.id) AS count, COALESCE(AVG(i.price), 0) AS avg_price
                FROM categories c
                LEFT JOIN items i ON i.category_id = c.id
                GROUP BY c.name
                ORDER BY c.name
                """
            )
            stats = [
                {"category": r["category"], "count": int(r["count"]), "avg_price": fmt_num(float(r["avg_price"]))}
                for r in rows
            ]
            await respond(send, 200, {"stats": stats}, extra_headers=cors_headers())
            return
        if path == "/items" and method == "GET":
            await list_items(qs, send)
            return
        if path == "/items" and method == "POST":
            body = await read_body(receive)
            await create_item(body, send)
            return
        if path.startswith("/items/"):
            id_str = path[len("/items/") :]
            if not id_str or "/" in id_str:
                await err(send, 404, "not_found", "item not found")
                return
            if not id_str.isdigit():
                await err(send, 400, "bad_request", "invalid id")
                return
            item_id = int(id_str)
            if method == "GET":
                await get_item(item_id, send)
            elif method == "PUT":
                body = await read_body(receive)
                await update_item(item_id, body, send)
            elif method == "DELETE":
                await delete_item(item_id, send)
            else:
                await err(send, 400, "bad_request", "invalid query")
            return
        await err(send, 404, "not_found", "item not found")
    except Exception as exc:
        print(exc)
        await err(send, 500, "internal_error", "internal error")


async def list_items(qs: dict[str, list[str]], send):
    limit = int_param(qs.get("limit", [""])[0], 20)
    offset = int_param(qs.get("offset", [""])[0], 0)
    sort = qs.get("sort", ["-created_at"])[0] or "-created_at"
    if limit is None or limit < 1 or limit > 10000:
        await err(send, 400, "bad_request", "invalid query")
        return
    if offset is None or offset < 0:
        await err(send, 400, "bad_request", "invalid query")
        return
    if sort not in SORT_SET:
        await err(send, 400, "bad_request", "invalid query")
        return
    category = qs.get("category", [""])[0]
    search = qs.get("search", [""])[0]
    where, args = build_where(category, search)
    total = await pool_fetchval(f"SELECT COUNT(*) FROM items i JOIN categories c ON c.id = i.category_id {where}", *args)
    order = order_clause(sort)
    n = len(args)
    sql = f"""
        SELECT i.id, i.title, i.price, c.name AS category, i.created_at
        FROM items i JOIN categories c ON c.id = i.category_id
        {where}
        ORDER BY {order}
        LIMIT ${n + 1} OFFSET ${n + 2}
    """
    rows = await pool_fetch(sql, *args, limit, offset)
    items = [map_row(r) for r in rows]
    await respond(send, 200, {"items": items, "total": int(total), "limit": limit, "offset": offset}, extra_headers=cors_headers())


async def get_item(item_id: int, send):
    rows = await pool_fetch(
        """
        SELECT i.id, i.title, i.price, c.name AS category, i.created_at
        FROM items i JOIN categories c ON c.id = i.category_id WHERE i.id = $1
        """,
        item_id,
    )
    if not rows:
        await err(send, 404, "not_found", "item not found")
        return
    await respond(send, 200, map_row(rows[0]), extra_headers=cors_headers())


async def create_item(raw: bytes, send):
    body = parse_json(raw)
    if body is None:
        await err(send, 400, "bad_request", "invalid query")
        return
    if not await validate(body):
        await err(send, 422, "validation_error", "validation failed")
        return
    cat_id = await pool_fetchval("SELECT id FROM categories WHERE name = $1", body["category"])
    if cat_id is None:
        await err(send, 422, "validation_error", "validation failed")
        return
    row = await pool_fetchrow(
        "INSERT INTO items (title, price, category_id) VALUES ($1, $2, $3) RETURNING id, created_at",
        body["title"],
        body["price"],
        cat_id,
    )
    await respond(
        send,
        201,
        {
            "id": int(row["id"]),
            "title": body["title"],
            "price": fmt_price(body["price"]),
            "category": body["category"],
            "created_at": fmt_time(row["created_at"]),
        },
        extra_headers=cors_headers(),
    )


async def update_item(item_id: int, raw: bytes, send):
    body = parse_json(raw)
    if body is None:
        await err(send, 400, "bad_request", "invalid query")
        return
    if not await validate(body):
        await err(send, 422, "validation_error", "validation failed")
        return
    cat_id = await pool_fetchval("SELECT id FROM categories WHERE name = $1", body["category"])
    if cat_id is None:
        await err(send, 422, "validation_error", "validation failed")
        return
    row = await pool_fetchrow(
        "UPDATE items SET title = $1, price = $2, category_id = $3 WHERE id = $4 RETURNING created_at",
        body["title"],
        body["price"],
        cat_id,
        item_id,
    )
    if row is None:
        await err(send, 404, "not_found", "item not found")
        return
    await respond(
        send,
        200,
        {
            "id": item_id,
            "title": body["title"],
            "price": fmt_price(body["price"]),
            "category": body["category"],
            "created_at": fmt_time(row["created_at"]),
        },
        extra_headers=cors_headers(),
    )


async def delete_item(item_id: int, send):
    tag = await pool_execute("DELETE FROM items WHERE id = $1", item_id)
    if tag == "DELETE 0":
        await err(send, 404, "not_found", "item not found")
        return
    await respond(send, 204, None, extra_headers=cors_headers())


def build_where(category: str, search: str) -> tuple[str, list[Any]]:
    parts = ["WHERE 1=1"]
    args: list[Any] = []
    n = 1
    if category:
        parts.append(f"AND c.name = ${n}")
        args.append(category)
        n += 1
    if search:
        parts.append(f"AND i.title ILIKE ${n}")
        args.append(f"%{search}%")
    return " ".join(parts), args


def order_clause(sort: str) -> str:
    return {
        "created_at": "i.created_at ASC",
        "-created_at": "i.created_at DESC",
        "price": "i.price ASC",
        "-price": "i.price DESC",
    }.get(sort, "i.created_at DESC")


async def validate(body: dict[str, Any]) -> bool:
    title = (body.get("title") or "").strip()
    if len(title) < 1 or len(title) > 255:
        return False
    price = (body.get("price") or "").strip()
    if not PRICE_RE.match(price):
        return False
    if float(price) < 0:
        return False
    category = (body.get("category") or "").strip()
    if not category:
        return False
    exists = await pool_fetchval("SELECT 1 FROM categories WHERE name = $1", category)
    return exists == 1


def map_row(r: asyncpg.Record) -> dict[str, Any]:
    return {
        "id": int(r["id"]),
        "title": r["title"],
        "price": fmt_num(float(r["price"])),
        "category": r["category"],
        "created_at": fmt_time(r["created_at"]),
    }


def fmt_num(v: float) -> str:
    return f"{v:.2f}"


def fmt_price(s: str) -> str:
    return fmt_num(float(s))


def fmt_time(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def int_param(s: str, default: int) -> int | None:
    if s == "":
        return default
    if not s.isdigit():
        return None
    return int(s)


def parse_json(raw: bytes) -> dict[str, Any] | None:
    if not raw:
        return {}
    try:
        data = json.loads(raw.decode())
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


async def read_body(receive) -> bytes:
    body = b""
    while True:
        message = await receive()
        if message["type"] == "http.request":
            body += message.get("body", b"")
            if not message.get("more_body"):
                break
    return body


def cors_headers() -> list[tuple[bytes, bytes]]:
    return [
        (b"access-control-allow-origin", b"*"),
        (b"access-control-allow-methods", b"GET, POST, PUT, DELETE, OPTIONS"),
        (b"access-control-allow-headers", b"Content-Type"),
    ]


async def respond(send, status: int, data: Any | None, extra_headers: list[tuple[bytes, bytes]] | None = None):
    headers = list(extra_headers or [])
    if status != 204:
        headers.append((b"content-type", JSON_CT))
        body = json.dumps(data, ensure_ascii=False).encode()
    else:
        body = b""
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


async def err(send, status: int, code: str, message: str):
    await respond(send, status, {"error": {"code": code, "message": message}}, extra_headers=cors_headers())


async def pool_fetch(query: str, *args):
    async with pool.acquire() as conn:
        return await conn.fetch(query, *args)


async def pool_fetchrow(query: str, *args):
    async with pool.acquire() as conn:
        return await conn.fetchrow(query, *args)


async def pool_fetchval(query: str, *args):
    async with pool.acquire() as conn:
        return await conn.fetchval(query, *args)


async def pool_execute(query: str, *args):
    async with pool.acquire() as conn:
        return await conn.execute(query, *args)
