package httpapi

// ============================================================
// v8 许愿：用户端 POST /api/mp/wish（可匿名，带小令牌则记身份），
// 管理端 /api/admin/wishes*（列表 + 分析 + 状态流转 + 一键转指令）。
// ============================================================

import (
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"latiaomei/internal/store"
)

// wishLimit 许愿防刷：每分钟每 IP 8 条（比 track 严，这是纯输入口）。
var wishLimit = &rateLimit{hits: map[string]*rlEntry{}, lastGC: time.Now()}

// wishLikeLimit 呼声防刷：每分钟每 IP 60 次（toggle 来回点也算）。
var wishLikeLimit = &rateLimit{hits: map[string]*rlEntry{}, lastGC: time.Now()}

// mpWishBody 用户许愿请求体。
type mpWishBody struct {
	Content string `json:"content"`
	Contact string `json:"contact"`
}

// hMpWishNew 收一条许愿。带登录令牌就记 channel/openid（"我的许愿"可回溯），
// 不带也收（匿名），只按 IP 限频。
func (s *Server) hMpWishNew(w http.ResponseWriter, r *http.Request) {
	var b mpWishBody
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, "参数不对")
		return
	}
	if !wishLimit.allow(clientIP(r)) {
		s.jsonErr(w, http.StatusTooManyRequests, "许愿太密集啦，歇会儿再发")
		return
	}
	content := strings.TrimSpace(b.Content)
	if n := utf8.RuneCountInString(content); n < 4 || n > 200 {
		s.jsonErr(w, http.StatusBadRequest, "愿望要 4~200 字，写具体点更容易被翻牌")
		return
	}
	ch, openid := "anon", ""
	if tok, ok := bearerToken(r); ok {
		if c, o, valid := s.mpVerify(tok); valid {
			ch, openid = c, o
		}
	}
	wish, err := s.st.AddWish(ch, openid, content, b.Contact)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.jsonOK(w, map[string]any{"wish": wish})
}

// hMpWishMine 我的许愿：按小令牌里的 channel+openid 回看进度（已读/翻牌/批复）。
func (s *Server) hMpWishMine(w http.ResponseWriter, r *http.Request) {
	tok, ok := bearerToken(r)
	if !ok {
		s.jsonErr(w, http.StatusUnauthorized, "请先静默登录")
		return
	}
	ch, openid, ok := s.mpVerify(tok)
	if !ok {
		s.jsonErr(w, http.StatusUnauthorized, "登录态已失效，请重开小程序")
		return
	}
	list, err := s.st.ListMyWishes(ch, openid, 30)
	if err != nil {
		log500(s, w, err, "读我的许愿")
		return
	}
	if list == nil {
		list = []store.Wish{}
	}
	s.jsonOK(w, map[string]any{"wishes": list})
}

// hMpWishWall 呼声墙：公开列表，不含 openid/contact；sort=hot（默认，呼声降序）|new。
// Bearer 可选：带了就标出 liked（我喊过的）与 mine（我递的）。
func (s *Server) hMpWishWall(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	sort := q.Get("sort")
	if sort != "new" {
		sort = "hot"
	}
	page := intQuery(q.Get("page"), 1, 1000)
	size := intQuery(q.Get("size"), 20, 50)
	ch, openid := "", ""
	if tok, ok := bearerToken(r); ok {
		if c, o, valid := s.mpVerify(tok); valid {
			ch, openid = c, o
		}
	}
	list, total, err := s.st.ListWishWall(sort, ch, openid, size, (page-1)*size)
	if err != nil {
		log500(s, w, err, "读呼声墙")
		return
	}
	if list == nil {
		list = []store.WallWish{}
	}
	s.jsonOK(w, map[string]any{
		"wishes": list, "total": total, "page": page, "size": size,
		"has_more": page*size < total,
	})
}

// hMpWishLike 给愿望喊一声（toggle）：需要小令牌，端上静默登录后再调。
func (s *Server) hMpWishLike(w http.ResponseWriter, r *http.Request) {
	if !wishLikeLimit.allow(clientIP(r)) {
		s.jsonErr(w, http.StatusTooManyRequests, "喊太快了，先让呼声飞一会儿")
		return
	}
	tok, ok := bearerToken(r)
	if !ok {
		s.jsonErr(w, http.StatusUnauthorized, "先登录，再给愿望喊一声")
		return
	}
	ch, openid, ok := s.mpVerify(tok)
	if !ok {
		s.jsonErr(w, http.StatusUnauthorized, "登录态已失效，请重开小程序")
		return
	}
	var b struct {
		ID int64 `json:"id"`
	}
	if err := decode(r, &b); err != nil || b.ID <= 0 {
		s.jsonErr(w, http.StatusBadRequest, "参数不对")
		return
	}
	liked, likes, err := s.st.ToggleWishLike(b.ID, ch, openid)
	if err == store.ErrNotFound {
		s.jsonErr(w, http.StatusNotFound, "这条已经下墙了")
		return
	}
	if err != nil {
		log500(s, w, err, "许愿点赞")
		return
	}
	s.jsonOK(w, map[string]any{"id": b.ID, "liked": liked, "likes": likes})
}

// hAdminWishes 许愿池：列表 + 分析（状态分布、近 7 天、高频词）。
func (s *Server) hAdminWishes(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := intQuery(q.Get("limit"), 50, 200)
	status := ""
	if v := q.Get("status"); v != "" {
		if !store.ValidWishStatus(v) && v != "all" {
			s.jsonErr(w, http.StatusBadRequest, "status 非法")
			return
		}
		status = v
	}
	list, err := s.st.ListWishes(status, limit)
	if err != nil {
		log500(s, w, err, "读许愿")
		return
	}
	stats, err := s.st.WishStats()
	if err != nil {
		log500(s, w, err, "许愿分析")
		return
	}
	if list == nil {
		list = []store.Wish{}
	}
	s.jsonOK(w, map[string]any{"wishes": list, "stats": stats})
}

// hAdminWishStatus 许愿状态流转：new → read → picked → done / rejected，可带批复。
func (s *Server) hAdminWishStatus(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	var b struct {
		Status string `json:"status"`
		Note   string `json:"note"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.st.SetWishStatus(id, b.Status, b.Note); err != nil {
		if err == store.ErrNotFound {
			s.jsonErr(w, http.StatusNotFound, "许愿不存在")
			return
		}
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.jsonOK(w, map[string]any{"id": id, "status": b.Status})
}

// hAdminWishToDirective 一键把许愿翻成指令（进指挥中心，worker/AI 后续执行）。
func (s *Server) hAdminWishToDirective(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	var b struct {
		Title string `json:"title"`
	}
	_ = decode(r, &b) // 允许空体：标题默认取许愿内容
	target, err := s.st.GetWish(id)
	if err == store.ErrNotFound {
		s.jsonErr(w, http.StatusNotFound, "许愿不存在")
		return
	}
	if err != nil {
		log500(s, w, err, "读许愿")
		return
	}
	title := strings.TrimSpace(b.Title)
	if title == "" {
		title = target.Content
		if utf8.RuneCountInString(title) > 40 {
			title = string([]rune(title)[:40])
		}
	}
	d := store.Directive{Kind: "topic", Title: title,
		Brief:     "来自粉丝许愿 #" + strconv.FormatInt(id, 10) + "：" + target.Content,
		CreatedBy: actorFrom(r.Context()).Label()}
	if err := s.st.AddDirective(&d); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.st.SetWishStatus(id, "picked", "已翻牌：排进探店计划"); err != nil {
		log500(s, w, err, "更新许愿状态")
		return
	}
	s.jsonOK(w, map[string]any{"id": id, "directive": title})
}

// hAdminWishDelete 删许愿（垃圾/测试数据）。
func (s *Server) hAdminWishDelete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "id 非法")
		return
	}
	if err := s.st.DeleteWish(id); err != nil {
		s.jsonErr(w, http.StatusNotFound, "许愿不存在")
		return
	}
	s.jsonOK(w, map[string]any{"id": id, "deleted": true})
}
