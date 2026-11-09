package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const jsonCT = "application/json; charset=utf-8"

var (
	priceRe = regexp.MustCompile(`^\d+(\.\d{1,2})?$`)
	sortSet = map[string]bool{
		"created_at": true, "-created_at": true, "price": true, "-price": true,
	}
)

type app struct {
	pool *pgxpool.Pool
	srv  *http.Server
	wg   sync.WaitGroup
}

type errBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type item struct {
	ID        int64  `json:"id"`
	Title     string `json:"title"`
	Price     string `json:"price"`
	Category  string `json:"category"`
	CreatedAt string `json:"created_at"`
}

type itemInput struct {
	Title    string `json:"title"`
	Price    string `json:"price"`
	Category string `json:"category"`
}

func main() {
	ctx := context.Background()
	pool, err := newPool(ctx)
	if err != nil {
		log.Fatalf("db pool: %v", err)
	}

	port := env("PORT", "8081")
	a := &app{pool: pool}
	mux := http.NewServeMux()
	mux.HandleFunc("/", a.withCORS(a.route))
	a.srv = &http.Server{Addr: ":" + port, Handler: mux}

	log.Printf("go backend listening on :%s", port)

	go func() {
		if err := a.srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("server error: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = a.srv.Shutdown(shutdownCtx)
	done := make(chan struct{})
	go func() {
		a.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-shutdownCtx.Done():
	}
	pool.Close()
}

func newPool(ctx context.Context) (*pgxpool.Pool, error) {
	host := env("DB_HOST", "localhost")
	port := env("DB_PORT", "5432")
	name := env("DB_NAME", "polyglot")
	user := env("DB_USER", "polyglot")
	pass := env("DB_PASSWORD", "polyglot")
	size, _ := strconv.Atoi(env("DB_POOL_SIZE", "20"))

	cfg, err := pgxpool.ParseConfig(fmt.Sprintf(
		"postgres://%s:%s@%s:%s/%s?pool_max_conns=%d",
		user, pass, host, port, name, size,
	))
	if err != nil {
		return nil, err
	}
	cfg.ConnConfig.ConnectTimeout = 5 * time.Second
	cfg.MaxConnLifetime = 0
	return pgxpool.NewWithConfig(ctx, cfg)
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func (a *app) withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

func (a *app) route(w http.ResponseWriter, r *http.Request) {
	a.wg.Add(1)
	defer a.wg.Done()

	path := r.URL.Path
	if path == "/health" && r.Method == http.MethodGet {
		a.health(w, r)
		return
	}
	if path == "/items" && r.Method == http.MethodGet {
		a.listItems(w, r)
		return
	}
	if path == "/items" && r.Method == http.MethodPost {
		a.createItem(w, r)
		return
	}
	if path == "/stats" && r.Method == http.MethodGet {
		a.stats(w, r)
		return
	}
	if strings.HasPrefix(path, "/items/") {
		idStr := strings.TrimPrefix(path, "/items/")
		if idStr == "" || strings.Contains(idStr, "/") {
			writeErr(w, http.StatusNotFound, "not_found", "item not found")
			return
		}
		id, err := strconv.ParseInt(idStr, 10, 64)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
			return
		}
		switch r.Method {
		case http.MethodGet:
			a.getItem(w, r, id)
		case http.MethodPut:
			a.updateItem(w, r, id)
		case http.MethodDelete:
			a.deleteItem(w, r, id)
		default:
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid query")
		}
		return
	}
	writeErr(w, http.StatusNotFound, "not_found", "item not found")
}

func (a *app) health(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("db") == "1" {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		if err := a.pool.Ping(ctx); err != nil {
			writeErr(w, http.StatusServiceUnavailable, "internal_error", "internal error")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *app) listItems(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, err := intParam(q.Get("limit"), 20)
	if err != nil || limit < 1 || limit > 10000 {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid query")
		return
	}
	offset, err := intParam(q.Get("offset"), 0)
	if err != nil || offset < 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid query")
		return
	}
	sort := q.Get("sort")
	if sort == "" {
		sort = "-created_at"
	}
	if !sortSet[sort] {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid query")
		return
	}

	order := orderClause(sort)
	category := q.Get("category")
	search := q.Get("search")

	where, args := buildWhere(category, search)
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	countSQL := "SELECT COUNT(*) FROM items i JOIN categories c ON c.id = i.category_id " + where
	var total int64
	if err := a.pool.QueryRow(ctx, countSQL, args...).Scan(&total); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}

	listArgs := append(args, limit, offset)
	listSQL := fmt.Sprintf(`
		SELECT i.id, i.title, i.price, c.name, i.created_at
		FROM items i
		JOIN categories c ON c.id = i.category_id
		%s
		ORDER BY %s
		LIMIT $%d OFFSET $%d`, where, order, len(args)+1, len(args)+2)

	rows, err := a.pool.Query(ctx, listSQL, listArgs...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}
	defer rows.Close()

	items := make([]item, 0)
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", "internal error")
			return
		}
		items = append(items, it)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items":  items,
		"total":  total,
		"limit":  limit,
		"offset": offset,
	})
}

func orderClause(sort string) string {
	switch sort {
	case "created_at":
		return "i.created_at ASC"
	case "-created_at":
		return "i.created_at DESC"
	case "price":
		return "i.price ASC"
	case "-price":
		return "i.price DESC"
	default:
		return "i.created_at DESC"
	}
}

func buildWhere(category, search string) (string, []any) {
	parts := []string{"WHERE 1=1"}
	args := []any{}
	n := 1
	if category != "" {
		parts = append(parts, fmt.Sprintf("AND c.name = $%d", n))
		args = append(args, category)
		n++
	}
	if search != "" {
		parts = append(parts, fmt.Sprintf("AND i.title ILIKE $%d", n))
		args = append(args, "%"+search+"%")
	}
	return strings.Join(parts, " "), args
}

func (a *app) getItem(w http.ResponseWriter, r *http.Request, id int64) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	row := a.pool.QueryRow(ctx, `
		SELECT i.id, i.title, i.price, c.name, i.created_at
		FROM items i
		JOIN categories c ON c.id = i.category_id
		WHERE i.id = $1`, id)
	it, err := scanItemRow(row)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "item not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, it)
}

func (a *app) createItem(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeInput(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if msg := validateInput(ctx, a.pool, in); msg != "" {
		writeErr(w, http.StatusUnprocessableEntity, "validation_error", "validation failed")
		return
	}
	var catID int
	if err := a.pool.QueryRow(ctx, `SELECT id FROM categories WHERE name = $1`, in.Category).Scan(&catID); err != nil {
		writeErr(w, http.StatusUnprocessableEntity, "validation_error", "validation failed")
		return
	}
	var id int64
	var created time.Time
	err := a.pool.QueryRow(ctx, `
		INSERT INTO items (title, price, category_id) VALUES ($1, $2, $3)
		RETURNING id, created_at`, in.Title, in.Price, catID).Scan(&id, &created)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}
	writeJSON(w, http.StatusCreated, item{
		ID: id, Title: in.Title, Price: formatPrice(in.Price),
		Category: in.Category, CreatedAt: formatTime(created),
	})
}

func (a *app) updateItem(w http.ResponseWriter, r *http.Request, id int64) {
	in, ok := decodeInput(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if msg := validateInput(ctx, a.pool, in); msg != "" {
		writeErr(w, http.StatusUnprocessableEntity, "validation_error", "validation failed")
		return
	}
	var catID int
	if err := a.pool.QueryRow(ctx, `SELECT id FROM categories WHERE name = $1`, in.Category).Scan(&catID); err != nil {
		writeErr(w, http.StatusUnprocessableEntity, "validation_error", "validation failed")
		return
	}
	var created time.Time
	err := a.pool.QueryRow(ctx, `
		UPDATE items SET title = $1, price = $2, category_id = $3
		WHERE id = $4
		RETURNING created_at`, in.Title, in.Price, catID, id).Scan(&created)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "item not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, item{
		ID: id, Title: in.Title, Price: formatPrice(in.Price),
		Category: in.Category, CreatedAt: formatTime(created),
	})
}

func (a *app) deleteItem(w http.ResponseWriter, r *http.Request, id int64) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	tag, err := a.pool.Exec(ctx, `DELETE FROM items WHERE id = $1`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "item not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) stats(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	rows, err := a.pool.Query(ctx, `
		SELECT c.name, COUNT(i.id), COALESCE(AVG(i.price), 0)
		FROM categories c
		LEFT JOIN items i ON i.category_id = c.id
		GROUP BY c.name
		ORDER BY c.name`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}
	defer rows.Close()
	type stat struct {
		Category string `json:"category"`
		Count    int64  `json:"count"`
		AvgPrice string `json:"avg_price"`
	}
	out := make([]stat, 0, 20)
	for rows.Next() {
		var name string
		var count int64
		var avg float64
		if err := rows.Scan(&name, &count, &avg); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", "internal error")
			return
		}
		out = append(out, stat{Category: name, Count: count, AvgPrice: formatAvg(avg)})
	}
	writeJSON(w, http.StatusOK, map[string]any{"stats": out})
}

func decodeInput(w http.ResponseWriter, r *http.Request) (itemInput, bool) {
	var in itemInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid query")
		return in, false
	}
	return in, true
}

func validateInput(ctx context.Context, pool *pgxpool.Pool, in itemInput) string {
	t := strings.TrimSpace(in.Title)
	if len(t) < 1 || len(t) > 255 {
		return "title"
	}
	if !priceRe.MatchString(strings.TrimSpace(in.Price)) {
		return "price"
	}
	p, err := strconv.ParseFloat(in.Price, 64)
	if err != nil || p < 0 || math.IsNaN(p) {
		return "price"
	}
	if strings.TrimSpace(in.Category) == "" {
		return "category"
	}
	var exists int
	_ = pool.QueryRow(ctx, `SELECT 1 FROM categories WHERE name = $1`, in.Category).Scan(&exists)
	if exists != 1 {
		return "category"
	}
	return ""
}

func scanItem(rows pgx.Rows) (item, error) {
	var id int64
	var title, cat string
	var price float64
	var created time.Time
	if err := rows.Scan(&id, &title, &price, &cat, &created); err != nil {
		return item{}, err
	}
	return item{ID: id, Title: title, Price: formatNumeric(price), Category: cat, CreatedAt: formatTime(created)}, nil
}

func scanItemRow(row pgx.Row) (item, error) {
	var id int64
	var title, cat string
	var price float64
	var created time.Time
	if err := row.Scan(&id, &title, &price, &cat, &created); err != nil {
		return item{}, err
	}
	return item{ID: id, Title: title, Price: formatNumeric(price), Category: cat, CreatedAt: formatTime(created)}, nil
}

func formatNumeric(v float64) string {
	return fmt.Sprintf("%.2f", v)
}

func formatPrice(s string) string {
	p, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return s
	}
	return fmt.Sprintf("%.2f", p)
}

func formatAvg(v float64) string {
	return fmt.Sprintf("%.2f", v)
}

func formatTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05Z")
}

func intParam(s string, def int) (int, error) {
	if s == "" {
		return def, nil
	}
	return strconv.Atoi(s)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", jsonCT)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", jsonCT)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errBody{Error: struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{Code: code, Message: message}})
}
