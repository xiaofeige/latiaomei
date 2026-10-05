package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// ============================================================
// v8 许愿：粉丝想让辣条妹去踩的坑。前台收愿望，后台做分析。
// 设计：内容只有"许愿"这一个用户输入口，字段尽量少；分析靠
// 状态分布 + 高频词（中文 bigram），不引入分词依赖。
// ============================================================

// Wish 一条许愿。
type Wish struct {
	ID        int64  `json:"id"`
	Channel   string `json:"channel"`
	OpenID    string `json:"openid,omitempty"`
	Content   string `json:"content"`
	Contact   string `json:"contact,omitempty"`
	Status    string `json:"status"`
	StatusTxt string `json:"status_text"`
	Note      string `json:"note"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
	Likes     int    `json:"likes"` // v10 呼声：点赞人数，管理端排序用
}

// ValidWishStatus 许愿状态白名单。
func ValidWishStatus(k string) bool {
	switch k {
	case "new", "read", "picked", "done", "rejected":
		return true
	}
	return false
}

// WishStatusLabel 给人看的状态名（管理小程序直显）。
func WishStatusLabel(s string) string {
	switch s {
	case "new":
		return "待处理"
	case "read":
		return "已阅"
	case "picked":
		return "已翻牌"
	case "done":
		return "已踩坑"
	case "rejected":
		return "暂不做"
	}
	return s
}

// AddWish 收一条许愿。content 由调用方裁剪过空白；这里做兜底校验。
func (s *Store) AddWish(channel, openid, content, contact string) (*Wish, error) {
	content = strings.TrimSpace(content)
	n := utf8.RuneCountInString(content)
	if n < 4 || n > 200 {
		return nil, errors.New("store: 许愿内容需 4~200 字")
	}
	if channel == "" {
		channel = "anon"
	}
	if utf8.RuneCountInString(contact) > 50 {
		return nil, errors.New("store: 联系方式太长了")
	}
	now := s.Now().Unix()
	res, err := s.exec(`INSERT INTO wishes(channel, openid, content, contact, status, created_at, updated_at)
		VALUES (?,?,?,?, 'new', ?, ?)`, channel, openid, content, strings.TrimSpace(contact), now, now)
	if err != nil {
		return nil, fmt.Errorf("store: 收许愿: %w", err)
	}
	id, _ := res.LastInsertId()
	return &Wish{ID: id, Channel: channel, OpenID: openid, Content: content,
		Contact: contact, Status: "new", StatusTxt: "待处理", CreatedAt: now, UpdatedAt: now}, nil
}

var wishCols = `id, channel, openid, content, contact, status, note, created_at, updated_at`

func scanWish(row interface{ Scan(...any) error }) (Wish, error) {
	var w Wish
	err := scanWishInto(row, &w)
	return w, err
}

func scanWishInto(row interface{ Scan(...any) error }, w *Wish) error {
	err := row.Scan(&w.ID, &w.Channel, &w.OpenID, &w.Content, &w.Contact,
		&w.Status, &w.Note, &w.CreatedAt, &w.UpdatedAt)
	w.StatusTxt = WishStatusLabel(w.Status)
	return err
}

// ListWishes 管理端列表：新在前。status 空/all=全部。带呼声数。
func (s *Store) ListWishes(status string, limit int) ([]Wish, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := `SELECT w.id, w.channel, w.openid, w.content, w.contact, w.status, w.note, w.created_at, w.updated_at,
		      (SELECT COUNT(*) FROM wish_likes l WHERE l.wish_id = w.id) AS likes
	      FROM wishes w`
	var args []any
	if status != "" && status != "all" {
		q += " WHERE w.status = ?"
		args = append(args, status)
	}
	q += " ORDER BY likes DESC, w.id DESC LIMIT ?"
	rows, err := s.db.Query(q, append(args, limit)...)
	if err != nil {
		return nil, fmt.Errorf("store: 列许愿: %w", err)
	}
	defer rows.Close()
	var out []Wish
	for rows.Next() {
		w, err := scanWishRows(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

func scanWishRows(rows *sql.Rows) (Wish, error) {
	var w Wish
	err := rows.Scan(&w.ID, &w.Channel, &w.OpenID, &w.Content, &w.Contact,
		&w.Status, &w.Note, &w.CreatedAt, &w.UpdatedAt, &w.Likes)
	w.StatusTxt = WishStatusLabel(w.Status)
	return w, err
}

// ListMyWishes 用户端"我的许愿"：按 channel+openid 回溯。
func (s *Store) ListMyWishes(channel, openid string, limit int) ([]Wish, error) {
	if limit <= 0 || limit > 100 {
		limit = 30
	}
	rows, err := s.db.Query("SELECT "+wishCols+` FROM wishes WHERE channel=? AND openid=? ORDER BY id DESC LIMIT ?`,
		channel, openid, limit)
	if err != nil {
		return nil, fmt.Errorf("store: 列我的许愿: %w", err)
	}
	defer rows.Close()
	var out []Wish
	for rows.Next() {
		w, err := scanWish(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// GetWish 按 id 取一条许愿；不存在返回 ErrNotFound。
func (s *Store) GetWish(id int64) (*Wish, error) {
	w := &Wish{}
	err := scanWishInto(s.db.QueryRow("SELECT "+wishCols+" FROM wishes WHERE id=?", id), w)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return w, nil
}

// SetWishStatus 状态流转 + 批复（note 为空则保留原批复）。
func (s *Store) SetWishStatus(id int64, status, note string) error {
	if !ValidWishStatus(status) {
		return errors.New("store: 非法许愿状态")
	}
	now := s.Now().Unix()
	res, err := s.exec(`UPDATE wishes SET status=?, note=CASE WHEN ?='' THEN note ELSE ? END, updated_at=? WHERE id=?`,
		status, note, note, now, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteWish 删许愿（垃圾内容用）。
func (s *Store) DeleteWish(id int64) error {
	res, err := s.exec("DELETE FROM wishes WHERE id=?", id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// wishStopGrams 高频词分析里要滤掉的通用词：不构成"想去哪家"的信号。
var wishStopGrams = map[string]bool{
	"想吃": true, "希望": true, "帮忙": true, "推荐": true, "探店": true, "测评": true,
	"试试": true, "看看": true, "什么": true, "怎么": true, "可以": true, "这个": true,
	"那个": true, "觉得": true, "真的": true, "有点": true, "一家": true, "辣条": true,
	"条妹": true, "小店的": true, "你们": true, "我们": true, "一定": true, "不会": true,
	"没有": true, "不是": true, "好吃": true, "难吃": true, "避雷": true, "跪求": true,
	"求求": true, "杭州": true, "谢谢": true, "拜托": true, "最好": true,
	"这些": true, "那些": true, "时候": true, "地方": true, "朋友": true,
}

// WishStats 许愿池分析：总量、各状态数、近 7 天新增、高频词。
// 词频取最近 500 条的中文 2-gram（bigram），够看出"最近在求哪家/哪类"。
func (s *Store) WishStats() (map[string]any, error) {
	type sc struct {
		st string
		n  int
	}
	rows, err := s.db.Query(`SELECT status, COUNT(*) FROM wishes GROUP BY status`)
	if err != nil {
		return nil, fmt.Errorf("store: 许愿状态统计: %w", err)
	}
	defer rows.Close()
	byStatus := map[string]int{}
	total := 0
	for rows.Next() {
		var c sc
		if err := rows.Scan(&c.st, &c.n); err != nil {
			return nil, err
		}
		byStatus[c.st] = c.n
		total += c.n
	}
	week7 := s.Now().AddDate(0, 0, -7).Unix()
	var new7 int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM wishes WHERE created_at >= ?", week7).Scan(&new7); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("store: 许愿周统计: %w", err)
	}

	crows, err := s.db.Query(`SELECT content FROM wishes ORDER BY id DESC LIMIT 500`)
	if err != nil {
		return nil, fmt.Errorf("store: 读许愿内容: %w", err)
	}
	defer crows.Close()
	counter := map[string]int{}
	for crows.Next() {
		var content string
		if err := crows.Scan(&content); err != nil {
			return nil, err
		}
		for _, g := range bigrams(content) {
			if !wishStopGrams[g] {
				counter[g]++
			}
		}
	}
	if err := crows.Err(); err != nil {
		return nil, err
	}
	keywords := topGrams(counter, 15)

	return map[string]any{
		"total":    total,
		"new":      byStatus["new"],
		"read":     byStatus["read"],
		"picked":   byStatus["picked"],
		"done":     byStatus["done"],
		"rejected": byStatus["rejected"],
		"new_7d":   new7,
		"keywords": keywords,
	}, nil
}

// bigrams 抽取字符串里所有连续汉字段的 2-gram（跨标点/数字自动断开）。
func bigrams(s string) []string {
	var out []string
	var run []rune
	flush := func() {
		for i := 0; i+1 < len(run); i++ {
			out = append(out, string(run[i:i+2]))
		}
		run = run[:0]
	}
	for _, r := range s {
		if r >= 0x4e00 && r <= 0x9fff {
			run = append(run, r)
		} else {
			flush()
		}
	}
	flush()
	return out
}

// topGrams 按频次取前 n 个词（频次 <2 的碎词不要，没信号）。
func topGrams(counter map[string]int, n int) []map[string]any {
	type kv struct {
		g string
		c int
	}
	list := make([]kv, 0, len(counter))
	for g, c := range counter {
		if c >= 2 {
			list = append(list, kv{g, c})
		}
	}
	// 插入排序规模很小（≤几百），不引 sort 之外的复杂度
	for i := 1; i < len(list); i++ {
		for j := i; j > 0 && (list[j].c > list[j-1].c || (list[j].c == list[j-1].c && list[j].g < list[j-1].g)); j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
	if len(list) > n {
		list = list[:n]
	}
	out := make([]map[string]any, 0, len(list))
	for _, e := range list {
		out = append(out, map[string]any{"word": e.g, "count": e.c})
	}
	return out
}

// ============================================================
// v10 许愿墙：公开流水 + 粉丝呼声（点赞）。
// 上墙规则简单到不需要审核开关：除了被辣条妹标「暂不做」(rejected) 的，
// 所有愿望都上墙；contact/openid 永不外泄，展示用固定马甲。
// ============================================================

// WallWish 墙上展示的一条愿望（字段白名单，绝不含 openid/contact）。
type WallWish struct {
	ID        int64  `json:"id"`
	Nick      string `json:"nick"`
	Content   string `json:"content"`
	Status    string `json:"status"`
	StatusTxt string `json:"status_text"`
	Note      string `json:"note"`
	CreatedAt int64  `json:"created_at"`
	Likes     int    `json:"likes"`
	Liked     bool   `json:"liked"`
	Mine      bool   `json:"mine"`
}

var wishNickA = []string{"嘴馋", "挑食", "干饭", "夜宵", "排队", "探店", "落胃", "毒舌"}
var wishNickB = []string{"老饕", "路人", "食客", "饭搭子", "饕客", "吃货", "先生", "掌柜"}

// wishNick 用 openid 散列出固定马甲：同一人永远同一个名字，但逆向不出身份。
func wishNick(openid string) string {
	if openid == "" {
		return "没留名的吃货"
	}
	var h uint32 = 2166136261
	for _, b := range []byte(openid) {
		h = (h ^ uint32(b)) * 16777619
	}
	return wishNickA[h%uint32(len(wishNickA))] + wishNickB[(h>>4)%uint32(len(wishNickB))]
}

// ListWishWall 呼声墙列表。sort=hot 按呼声降序（默认，同票新在前），new 按时间。
// viewer 为当前登录用户（channel+openid，可空），只用于标 liked/mine。
func (s *Store) ListWishWall(sort, vCh, vOpenid string, limit, offset int) ([]WallWish, int, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	if offset < 0 {
		offset = 0
	}
	var total int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM wishes WHERE status <> 'rejected'`).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("store: 数墙: %w", err)
	}
	order := "likes DESC, id DESC"
	if sort == "new" {
		order = "id DESC"
	}
	rows, err := s.db.Query(`SELECT w.id, w.openid, w.content, w.status, w.note, w.created_at,
		       (SELECT COUNT(*) FROM wish_likes l WHERE l.wish_id = w.id) AS likes
		FROM wishes w WHERE w.status <> 'rejected' ORDER BY `+order+` LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("store: 列墙: %w", err)
	}
	defer rows.Close()
	var out []WallWish
	for rows.Next() {
		var w WallWish
		var openid string
		if err := rows.Scan(&w.ID, &openid, &w.Content, &w.Status, &w.Note, &w.CreatedAt, &w.Likes); err != nil {
			return nil, 0, err
		}
		w.StatusTxt = WishStatusLabel(w.Status)
		w.Nick = wishNick(openid)
		w.Mine = vOpenid != "" && openid == vOpenid
		out = append(out, w)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	// 当前观众给过哪些赞：一次查询标上，避免 N+1。
	if vOpenid != "" && len(out) > 0 {
		lr, err := s.db.Query(`SELECT wish_id FROM wish_likes WHERE channel=? AND openid=?`, vCh, vOpenid)
		if err != nil {
			return nil, 0, fmt.Errorf("store: 读我的呼声: %w", err)
		}
		mine := map[int64]bool{}
		for lr.Next() {
			var id int64
			if err := lr.Scan(&id); err == nil {
				mine[id] = true
			}
		}
		lr.Close()
		for i := range out {
			out[i].Liked = mine[out[i].ID]
		}
	}
	return out, total, nil
}

// ToggleWishLike 点赞/取消赞（切换）。返回当前状态与总呼声。
// 只能给在墙上的愿望点赞；一条愿望每人一票，由主键兼住。
func (s *Store) ToggleWishLike(wishID int64, channel, openid string) (liked bool, likes int, err error) {
	if channel == "" || openid == "" {
		return false, 0, errors.New("store: 未登录，不能点赞")
	}
	var st string
	e := s.db.QueryRow("SELECT status FROM wishes WHERE id=?", wishID).Scan(&st)
	if errors.Is(e, sql.ErrNoRows) {
		return false, 0, ErrNotFound
	}
	if e != nil {
		return false, 0, e
	}
	if st == "rejected" {
		return false, 0, ErrNotFound // 下墙的愿望等同于不存在，不透露状态
	}
	now := s.Now().Unix()
	res, e := s.exec(`INSERT OR IGNORE INTO wish_likes(wish_id, channel, openid, created_at) VALUES (?,?,?,?)`,
		wishID, channel, openid, now)
	if e != nil {
		return false, 0, fmt.Errorf("store: 点赞: %w", e)
	}
	if added, _ := res.RowsAffected(); added > 0 {
		liked = true
	} else {
		if _, e = s.exec(`DELETE FROM wish_likes WHERE wish_id=? AND channel=? AND openid=?`, wishID, channel, openid); e != nil {
			return false, 0, fmt.Errorf("store: 取消赞: %w", e)
		}
		liked = false
	}
	if e = s.db.QueryRow(`SELECT COUNT(*) FROM wish_likes WHERE wish_id=?`, wishID).Scan(&likes); e != nil {
		return liked, 0, e
	}
	return liked, likes, nil
}
