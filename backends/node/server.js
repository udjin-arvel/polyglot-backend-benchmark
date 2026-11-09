"use strict";

const http = require("node:http");
const { URL } = require("node:url");
const { Pool } = require("pg");

const JSON_CT = "application/json; charset=utf-8";
const PRICE_RE = /^\d+(\.\d{1,2})?$/;
const SORT_SET = new Set(["created_at", "-created_at", "price", "-price"]);

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "polyglot",
  user: process.env.DB_USER || "polyglot",
  password: process.env.DB_PASSWORD || "polyglot",
  max: Number(process.env.DB_POOL_SIZE || 20),
  connectionTimeoutMillis: 5000,
  query_timeout: 5000,
  statement_timeout: 5000,
});

let shuttingDown = false;
const inflight = new Set();

const server = http.createServer((req, res) => {
  if (shuttingDown) {
    res.writeHead(503);
    res.end();
    return;
  }
  const done = () => inflight.delete(p);
  const p = handle(req, res).finally(done);
  inflight.add(p);
});

const port = Number(process.env.PORT || 8082);
server.listen(port, () => {
  console.log(`node backend listening on :${port}`);
});

process.on("SIGTERM", () => shutdown());

async function shutdown() {
  shuttingDown = true;
  server.close();
  const deadline = Date.now() + 5000;
  while (inflight.size > 0 && Date.now() < deadline) {
    await sleep(50);
  }
  await pool.end();
  process.exit(0);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function handle(req, res) {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  try {
    if (path === "/health" && req.method === "GET") {
      return health(url, res);
    }
    if (path === "/items" && req.method === "GET") {
      return listItems(url, res);
    }
    if (path === "/items" && req.method === "POST") {
      return createItem(req, res);
    }
    if (path === "/stats" && req.method === "GET") {
      return stats(res);
    }
    if (path.startsWith("/items/")) {
      const idStr = path.slice("/items/".length);
      if (!idStr || idStr.includes("/")) {
        return err(res, 404, "not_found", "item not found");
      }
      if (!/^\d+$/.test(idStr)) {
        return err(res, 400, "bad_request", "invalid id");
      }
      const id = Number(idStr);
      if (req.method === "GET") return getItem(id, res);
      if (req.method === "PUT") return updateItem(req, id, res);
      if (req.method === "DELETE") return deleteItem(id, res);
      return err(res, 400, "bad_request", "invalid query");
    }
    return err(res, 404, "not_found", "item not found");
  } catch (e) {
    console.error(e);
    return err(res, 500, "internal_error", "internal error");
  }
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function health(url, res) {
  if (url.searchParams.get("db") === "1") {
    try {
      await pool.query("SELECT 1");
    } catch {
      return err(res, 503, "internal_error", "internal error");
    }
  }
  return json(res, 200, { status: "ok" });
}

async function listItems(url, res) {
  const q = url.searchParams;
  const limit = intParam(q.get("limit"), 20);
  const offset = intParam(q.get("offset"), 0);
  let sort = q.get("sort") || "-created_at";
  if (limit === null || limit < 1 || limit > 10000) {
    return err(res, 400, "bad_request", "invalid query");
  }
  if (offset === null || offset < 0) {
    return err(res, 400, "bad_request", "invalid query");
  }
  if (!SORT_SET.has(sort)) {
    return err(res, 400, "bad_request", "invalid query");
  }
  const { where, args } = buildWhere(q.get("category") || "", q.get("search") || "");
  const count = await pool.query(
    `SELECT COUNT(*)::bigint AS c FROM items i JOIN categories c ON c.id = i.category_id ${where}`,
    args,
  );
  const total = Number(count.rows[0].c);
  const listArgs = [...args, limit, offset];
  const order = orderClause(sort);
  const n = args.length;
  const rows = await pool.query(
    `SELECT i.id, i.title, i.price, c.name AS category, i.created_at
     FROM items i JOIN categories c ON c.id = i.category_id
     ${where}
     ORDER BY ${order}
     LIMIT $${n + 1} OFFSET $${n + 2}`,
    listArgs,
  );
  const items = rows.rows.map(mapRow);
  return json(res, 200, { items, total, limit, offset });
}

async function getItem(id, res) {
  const rows = await pool.query(
    `SELECT i.id, i.title, i.price, c.name AS category, i.created_at
     FROM items i JOIN categories c ON c.id = i.category_id WHERE i.id = $1`,
    [id],
  );
  if (!rows.rowCount) return err(res, 404, "not_found", "item not found");
  return json(res, 200, mapRow(rows.rows[0]));
}

async function createItem(req, res) {
  const body = await readJson(req);
  if (!body) return err(res, 400, "bad_request", "invalid query");
  if (!(await validate(body))) return err(res, 422, "validation_error", "validation failed");
  const cat = await pool.query(`SELECT id FROM categories WHERE name = $1`, [body.category]);
  if (!cat.rowCount) return err(res, 422, "validation_error", "validation failed");
  const ins = await pool.query(
    `INSERT INTO items (title, price, category_id) VALUES ($1, $2, $3) RETURNING id, created_at`,
    [body.title, body.price, cat.rows[0].id],
  );
  const row = ins.rows[0];
  return json(res, 201, {
    id: Number(row.id),
    title: body.title,
    price: formatPrice(body.price),
    category: body.category,
    created_at: formatTime(row.created_at),
  });
}

async function updateItem(req, id, res) {
  const body = await readJson(req);
  if (!body) return err(res, 400, "bad_request", "invalid query");
  if (!(await validate(body))) return err(res, 422, "validation_error", "validation failed");
  const cat = await pool.query(`SELECT id FROM categories WHERE name = $1`, [body.category]);
  if (!cat.rowCount) return err(res, 422, "validation_error", "validation failed");
  const upd = await pool.query(
    `UPDATE items SET title = $1, price = $2, category_id = $3 WHERE id = $4 RETURNING created_at`,
    [body.title, body.price, cat.rows[0].id, id],
  );
  if (!upd.rowCount) return err(res, 404, "not_found", "item not found");
  return json(res, 200, {
    id,
    title: body.title,
    price: formatPrice(body.price),
    category: body.category,
    created_at: formatTime(upd.rows[0].created_at),
  });
}

async function deleteItem(id, res) {
  const del = await pool.query(`DELETE FROM items WHERE id = $1`, [id]);
  if (!del.rowCount) return err(res, 404, "not_found", "item not found");
  res.writeHead(204);
  res.end();
}

async function stats(res) {
  const rows = await pool.query(`
    SELECT c.name AS category, COUNT(i.id)::bigint AS count, COALESCE(AVG(i.price), 0) AS avg_price
    FROM categories c
    LEFT JOIN items i ON i.category_id = c.id
    GROUP BY c.name
    ORDER BY c.name`);
  const stats = rows.rows.map((r) => ({
    category: r.category,
    count: Number(r.count),
    avg_price: formatAvg(Number(r.avg_price)),
  }));
  return json(res, 200, { stats });
}

function buildWhere(category, search) {
  const parts = ["WHERE 1=1"];
  const args = [];
  let n = 1;
  if (category) {
    parts.push(`AND c.name = $${n++}`);
    args.push(category);
  }
  if (search) {
    parts.push(`AND i.title ILIKE $${n++}`);
    args.push(`%${search}%`);
  }
  return { where: parts.join(" "), args };
}

function orderClause(sort) {
  switch (sort) {
    case "created_at":
      return "i.created_at ASC";
    case "-created_at":
      return "i.created_at DESC";
    case "price":
      return "i.price ASC";
    case "-price":
      return "i.price DESC";
    default:
      return "i.created_at DESC";
  }
}

async function validate(body) {
  const title = (body.title || "").trim();
  if (title.length < 1 || title.length > 255) return false;
  const price = (body.price || "").trim();
  if (!PRICE_RE.test(price)) return false;
  if (Number(price) < 0) return false;
  const category = (body.category || "").trim();
  if (!category) return false;
  const row = await pool.query(`SELECT 1 FROM categories WHERE name = $1`, [category]);
  return row.rowCount === 1;
}

function mapRow(r) {
  return {
    id: Number(r.id),
    title: r.title,
    price: formatNumeric(r.price),
    category: r.category,
    created_at: formatTime(r.created_at),
  };
}

function formatNumeric(v) {
  return formatAvg(Number(v));
}

function formatPrice(s) {
  return formatAvg(Number(s));
}

function formatAvg(v) {
  return v.toFixed(2);
}

function formatTime(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function intParam(s, def) {
  if (s === null || s === "") return def;
  if (!/^\d+$/.test(s)) return null;
  return Number(s);
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve(null);
      }
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": JSON_CT });
  res.end(JSON.stringify(body));
}

function err(res, status, code, message) {
  return json(res, status, { error: { code, message } });
}
