<?php

declare(strict_types=1);

const JSON_CT = 'application/json; charset=utf-8';

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$pdo = null;

function db(): PDO
{
    global $pdo;
    if ($pdo === null) {
        $host = getenv('DB_HOST') ?: 'localhost';
        $port = getenv('DB_PORT') ?: '5432';
        $name = getenv('DB_NAME') ?: 'polyglot';
        $user = getenv('DB_USER') ?: 'polyglot';
        $pass = getenv('DB_PASSWORD') ?: 'polyglot';
        $dsn = "pgsql:host={$host};port={$port};dbname={$name}";
        $pdo = new PDO($dsn, $user, $pass, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_TIMEOUT => 5,
        ]);
        $pdo->exec('SET statement_timeout = 5000');
    }
    return $pdo;
}

try {
    $method = $_SERVER['REQUEST_METHOD'];
    $path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/';

    if ($path === '/health' && $method === 'GET') {
        if (($_GET['db'] ?? '') === '1') {
            db()->query('SELECT 1');
        }
        json(200, ['status' => 'ok']);
    }

    if ($path === '/stats' && $method === 'GET') {
        $rows = db()->query('
            SELECT c.name AS category, COUNT(i.id) AS count, COALESCE(AVG(i.price), 0) AS avg_price
            FROM categories c
            LEFT JOIN items i ON i.category_id = c.id
            GROUP BY c.name
            ORDER BY c.name')->fetchAll();
        $stats = array_map(static fn ($r) => [
            'category' => $r['category'],
            'count' => (int) $r['count'],
            'avg_price' => fmt_num((float) $r['avg_price']),
        ], $rows);
        json(200, ['stats' => $stats]);
    }

    if ($path === '/items' && $method === 'GET') {
        list_items();
    }

    if ($path === '/items' && $method === 'POST') {
        create_item();
    }

    if (str_starts_with($path, '/items/')) {
        $idStr = substr($path, strlen('/items/'));
        if ($idStr === '' || str_contains($idStr, '/')) {
            err(404, 'not_found', 'item not found');
        }
        if (!ctype_digit($idStr)) {
            err(400, 'bad_request', 'invalid id');
        }
        $id = (int) $idStr;
        match ($method) {
            'GET' => get_item($id),
            'PUT' => update_item($id),
            'DELETE' => delete_item($id),
            default => err(400, 'bad_request', 'invalid query'),
        };
    }

    err(404, 'not_found', 'item not found');
} catch (Throwable $e) {
    if ((int) (getenv('LOG_LEVEL') ?: 'warn') !== 'error') {
        error_log($e->getMessage());
    }
    err(500, 'internal_error', 'internal error');
}

function list_items(): void
{
    $limit = int_param($_GET['limit'] ?? '', 20);
    $offset = int_param($_GET['offset'] ?? '', 0);
    $sort = $_GET['sort'] ?? '-created_at';
    if ($limit === null || $limit < 1 || $limit > 10000) {
        err(400, 'bad_request', 'invalid query');
    }
    if ($offset === null || $offset < 0) {
        err(400, 'bad_request', 'invalid query');
    }
    $allowed = ['created_at', '-created_at', 'price', '-price'];
    if (!in_array($sort, $allowed, true)) {
        err(400, 'bad_request', 'invalid query');
    }

    [$where, $params] = build_where($_GET['category'] ?? '', $_GET['search'] ?? '');
    $countStmt = db()->prepare("SELECT COUNT(*) FROM items i JOIN categories c ON c.id = i.category_id {$where}");
    $countStmt->execute($params);
    $total = (int) $countStmt->fetchColumn();

    $order = order_clause($sort);
    $n = count($params);
    $listParams = array_merge($params, [$limit, $offset]);
    $sql = "SELECT i.id, i.title, i.price, c.name AS category, i.created_at
            FROM items i JOIN categories c ON c.id = i.category_id
            {$where} ORDER BY {$order} LIMIT ? OFFSET ?";
    $stmt = db()->prepare($sql);
    foreach ($listParams as $i => $v) {
        $stmt->bindValue($i + 1, $v, is_int($v) ? PDO::PARAM_INT : PDO::PARAM_STR);
    }
    $stmt->execute();
    $items = array_map('map_row', $stmt->fetchAll());
    json(200, ['items' => $items, 'total' => $total, 'limit' => $limit, 'offset' => $offset]);
}

function get_item(int $id): void
{
    $stmt = db()->prepare('
        SELECT i.id, i.title, i.price, c.name AS category, i.created_at
        FROM items i JOIN categories c ON c.id = i.category_id WHERE i.id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row) {
        err(404, 'not_found', 'item not found');
    }
    json(200, map_row($row));
}

function create_item(): void
{
    $body = read_json();
    if ($body === null) {
        err(400, 'bad_request', 'invalid query');
    }
    if (!validate($body)) {
        err(422, 'validation_error', 'validation failed');
    }
    $cat = db()->prepare('SELECT id FROM categories WHERE name = ?');
    $cat->execute([$body['category']]);
    $catId = $cat->fetchColumn();
    if (!$catId) {
        err(422, 'validation_error', 'validation failed');
    }
    $ins = db()->prepare('INSERT INTO items (title, price, category_id) VALUES (?, ?, ?) RETURNING id, created_at');
    $ins->execute([$body['title'], $body['price'], $catId]);
    $row = $ins->fetch();
    json(201, [
        'id' => (int) $row['id'],
        'title' => $body['title'],
        'price' => fmt_price($body['price']),
        'category' => $body['category'],
        'created_at' => fmt_time($row['created_at']),
    ]);
}

function update_item(int $id): void
{
    $body = read_json();
    if ($body === null) {
        err(400, 'bad_request', 'invalid query');
    }
    if (!validate($body)) {
        err(422, 'validation_error', 'validation failed');
    }
    $cat = db()->prepare('SELECT id FROM categories WHERE name = ?');
    $cat->execute([$body['category']]);
    $catId = $cat->fetchColumn();
    if (!$catId) {
        err(422, 'validation_error', 'validation failed');
    }
    $upd = db()->prepare('UPDATE items SET title = ?, price = ?, category_id = ? WHERE id = ? RETURNING created_at');
    $upd->execute([$body['title'], $body['price'], $catId, $id]);
    $row = $upd->fetch();
    if (!$row) {
        err(404, 'not_found', 'item not found');
    }
    json(200, [
        'id' => $id,
        'title' => $body['title'],
        'price' => fmt_price($body['price']),
        'category' => $body['category'],
        'created_at' => fmt_time($row['created_at']),
    ]);
}

function delete_item(int $id): void
{
    $del = db()->prepare('DELETE FROM items WHERE id = ?');
    $del->execute([$id]);
    if ($del->rowCount() === 0) {
        err(404, 'not_found', 'item not found');
    }
    http_response_code(204);
}

function build_where(string $category, string $search): array
{
    $parts = ['WHERE 1=1'];
    $params = [];
    if ($category !== '') {
        $parts[] = 'AND c.name = ?';
        $params[] = $category;
    }
    if ($search !== '') {
        $parts[] = 'AND i.title ILIKE ?';
        $params[] = '%' . $search . '%';
    }
    return [implode(' ', $parts), $params];
}

function order_clause(string $sort): string
{
    return match ($sort) {
        'created_at' => 'i.created_at ASC',
        '-created_at' => 'i.created_at DESC',
        'price' => 'i.price ASC',
        '-price' => 'i.price DESC',
        default => 'i.created_at DESC',
    };
}

function validate(array $body): bool
{
    $title = trim((string) ($body['title'] ?? ''));
    if (strlen($title) < 1 || strlen($title) > 255) {
        return false;
    }
    $price = trim((string) ($body['price'] ?? ''));
    if (!preg_match('/^\d+(\.\d{1,2})?$/', $price)) {
        return false;
    }
    if ((float) $price < 0) {
        return false;
    }
    $category = trim((string) ($body['category'] ?? ''));
    if ($category === '') {
        return false;
    }
    $stmt = db()->prepare('SELECT 1 FROM categories WHERE name = ?');
    $stmt->execute([$category]);
    return (bool) $stmt->fetchColumn();
}

function map_row(array $r): array
{
    return [
        'id' => (int) $r['id'],
        'title' => $r['title'],
        'price' => fmt_num((float) $r['price']),
        'category' => $r['category'],
        'created_at' => fmt_time($r['created_at']),
    ];
}

function fmt_num(float $v): string
{
    return number_format($v, 2, '.', '');
}

function fmt_price(string $s): string
{
    return fmt_num((float) $s);
}

function fmt_time(string $ts): string
{
    $dt = new DateTimeImmutable($ts);
    return $dt->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z');
}

function int_param(string $s, int $def): ?int
{
    if ($s === '') {
        return $def;
    }
    if (!ctype_digit($s)) {
        return null;
    }
    return (int) $s;
}

function read_json(): ?array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : null;
}

function json(int $status, array $data): void
{
    http_response_code($status);
    header('Content-Type: ' . JSON_CT);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function err(int $status, string $code, string $message): void
{
    json($status, ['error' => ['code' => $code, 'message' => $message]]);
}
