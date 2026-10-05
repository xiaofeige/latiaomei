package httpapi

// ============================================================
// v11 吃货 AI Agent（用户端小程序 · 辣条妹大脑）。
// 一个匿名接口 POST /api/mp/agent/chat：
//   端上传对话历史 + 口味档案 + 定位，服务端把「辣条妹真实库存店」
//   注入系统设定，让 LLM 只输出一种受控 JSON（生成式 UI 块协议），
//   再由服务端逐块校验、用库里的真实数据回填店铺卡（LLM 只准给 slug，
//   编造出来的店直接丢弃）。LLM 挂了/没配 key/超时，一律回退到本地
//   规则引擎 —— 对话永远有内容，绝不白屏。
//
// 块协议（端上按 type 渲染成控件，不是纯文本）：
//   text    富文本（**加粗** 与换行的极小子集）
//   ask     单选/多选引导提问 → 用户点选后拼成一句话发回
//   shops   店铺卡列表（服务端回填 name/cover/score/距离…）
//   plan    美食规划时间轴（按天 × 餐段，可挂 shop_slug）
//   tips    注意事项清单（健康计划/放纵餐/搭配建议）
//   actions 快捷按钮（ask=代发问题，tab=切 tab 页）
//   verdict 鉴店判决书（店靠不靠谱/会不会翻车：评论分布、刷单迹象、
//           四平台风评 + 高德扫街榜到店数据，中立第三方口吻）。
//
// skill 机制：同一条 LLM 通道里按用户意图激活不同「本事」。目前内置：
// 推店 / 规划 / 健康 / 放纵 / 附近 + 鉴店（agent_verify.go）。鉴店时服务端
// 会把她本人探店实记 + 高德 POI（含扫街榜痕迹探测）作为证据注入 prompt，
// 模型只准基于证据+通识做风评分析，不许编具体数字。
// ============================================================

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"math/rand"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"latiaomei/internal/store"
)

// ---- 请求结构 ----

type agentMsg struct {
	Role    string `json:"role"` // user / assistant
	Content string `json:"content"`
}

type agentLoc struct {
	Lat  float64 `json:"lat"`
	Lng  float64 `json:"lng"`
	Name string  `json:"name"` // 定位地标描述，可空
}

type agentPrefs struct {
	Spicy    *int   `json:"spicy"`    // 0 完全不吃辣 ~ 3 无辣不欢；缺省=还没建档案，模型应先问
	Hometown string `json:"hometown"` // 哪里人，用于口味类比
	Taboo    string `json:"taboo"`    // 忌口，逗号分隔
	Budget   int    `json:"budget"`   // 人均预算（元），0=不限
	Goal     string `json:"goal"`     // slim 减脂 / keep 维持 / stingy 省钱 / thrill 放纵
	Days     int    `json:"days"`     // 在杭天数（规划用）
	Text     string `json:"text"`     // 其它定制诉求，自由文本
}

// ---- 防白喂三道闸：全局 QPS≤3 → 同 IP 10s 一问且串行 → query ≤300 字 ----

// agentQPS 全局令牌桶：每秒匀速回血 3 枚，突发上限 3 枚，保护 LLM 花费与本机。
type agentQPS struct {
	mu     sync.Mutex
	tokens float64
	last   time.Time
}

func (q *agentQPS) allow() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	now := time.Now()
	if q.last.IsZero() {
		q.tokens = 3
	} else {
		q.tokens += now.Sub(q.last).Seconds() * 3
		if q.tokens > 3 {
			q.tokens = 3
		}
	}
	q.last = now
	if q.tokens >= 1 {
		q.tokens--
		return true
	}
	return false
}

var agentGlobalQPS = &agentQPS{}

// agentGate 同一用户：10 秒只受理一问；上一问还在处理时不接第二问（串行，不排队堆死自己）。
// key 是用户身份（openid 优先，见 agentIdentityOf），不是 IP —— 同出口 NAT 不互伤，刷 IP 也躲不掉。
type agentGate struct {
	mu   sync.Mutex
	last map[string]time.Time
	busy map[string]bool
}

// acquire 拿到放行令牌（返回 release 必须在处理完后 defer 调）；拿不到则返回拒绝文案。
func (g *agentGate) acquire(userKey string) (release func(), deny string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.last == nil {
		g.last = map[string]time.Time{}
		g.busy = map[string]bool{}
	}
	if g.busy[userKey] {
		return nil, "上一条还在路上，先等辣条妹恰完这条再发新的"
	}
	if t, ok := g.last[userKey]; ok && time.Since(t) < 10*time.Second {
		return nil, "10 秒只能问一句，歇一下再问，饭要一口口恰"
	}
	if len(g.last) > 4096 { // 防膨胀：身份表满了整体重置
		g.last = map[string]time.Time{}
	}
	g.last[userKey] = time.Now()
	g.busy[userKey] = true
	return func() {
		g.mu.Lock()
		delete(g.busy, userKey)
		g.mu.Unlock()
	}, ""
}

var agentUserGate = &agentGate{}

// agentTooLongAnswer query 超 300 字时的礼貌拒答（不走 LLM，不占 10s 额度）。
func agentTooLongAnswer() *agentAnswer {
	return &agentAnswer{Engine: "local",
		Thinking: "字太多看漏行，先教对方把话说明白。",
		Blocks: []map[string]any{{"type": "text",
			"md": "哎哎，**字太多了**（超过 300 字），我看不漏才怪。\n精简几句就够：**在杭几天 / 能吃多辣 / 人均预算 / 住哪片**，其余我替你盘。"}},
		Chips: []string{"帮我规划来杭州三天每一餐，能吃微辣，人均100"}}
}

// ---- 候选池 ----

// agentPool 一次请求内复用的库存数据：按 review slug 查、按店分组查。
type agentPool struct {
	byReview map[string]*store.Review // key = review slug
	byShop   map[string][]*store.Review
	all      []*store.Review
}

func (s *Server) loadAgentPool() *agentPool {
	p := &agentPool{byReview: map[string]*store.Review{}, byShop: map[string][]*store.Review{}}
	add := func(items []store.Review) {
		for i := range items {
			r := &items[i]
			p.all = append(p.all, r)
			p.byReview[r.Slug] = r
			if r.Shop != nil {
				p.byShop[r.Shop.Slug] = append(p.byShop[r.Shop.Slug], r)
			}
		}
	}
	if page, err := s.st.ListReviews(store.ReviewFilter{Kind: "tandian", Sort: "score", Size: 80}); err == nil {
		add(page.Items)
	} else {
		log.Printf("agent: 拉探店池失败: %v", err)
	}
	if page, err := s.st.ListReviews(store.ReviewFilter{Kind: "yushanfang", Sort: "new", Size: 40}); err == nil {
		add(page.Items)
	} else {
		log.Printf("agent: 拉御膳房池失败: %v", err)
	}
	return p
}

func haversineKm(lat1, lng1, lat2, lng2 float64) float64 {
	const earthR = 6371.0
	rad := math.Pi / 180
	dLat := (lat2 - lat1) * rad
	dLng := (lng2 - lng1) * rad
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*rad)*math.Cos(lat2*rad)*math.Sin(dLng/2)*math.Sin(dLng/2)
	return earthR * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}

func distText(km float64) string {
	if km < 1 {
		return fmt.Sprintf("%dm", int(km*1000))
	}
	return fmt.Sprintf("%.1fkm", km)
}

// ---- 处理器 ----

func (s *Server) hMpAgentChat(w http.ResponseWriter, r *http.Request) {
	// 闸一：全局 QPS≤3，先把洪水挡在最外面
	if !agentGlobalQPS.allow() {
		s.jsonErr(w, http.StatusTooManyRequests, "现在恰饭的人多，等一秒再问辣条妹")
		return
	}
	var b struct {
		Messages []agentMsg `json:"messages"`
		Prefs    agentPrefs `json:"prefs"`
		Loc      *agentLoc  `json:"loc"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	msgs := trimAgentHistory(b.Messages)
	if len(msgs) == 0 {
		s.jsonErr(w, http.StatusBadRequest, "先跟辣条妹说一句你想吃啥")
		return
	}
	// 闸二：本轮 query 超 300 字直接劝简，不烧 LLM 也不占 10s 额度
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "user" {
			if len([]rune(msgs[i].Content)) > 300 {
				s.jsonOK(w, agentTooLongAnswer())
			} else {
				s.jsonOK(w, s.runAgentGate(r, msgs, b.Prefs, b.Loc))
			}
			return
		}
	}
	s.jsonErr(w, http.StatusBadRequest, "先跟辣条妹说一句你想吃啥")
}

// agentIdentityOf 解析限流身份：带合法小令牌（微信/抖音静默登录换的 Bearer token）
// 就用 channel+openid 认人；没带或验签不过的匿名请求退回 IP（至少不至于没闸）。
func agentIdentityOf(r *http.Request, verify func(tok string) (string, string, bool)) string {
	if tok, ok := bearerToken(r); ok {
		if ch, openid, valid := verify(tok); valid && openid != "" {
			return "u:" + ch + ":" + openid
		}
	}
	return "ip:" + clientIP(r)
}

// runAgentGate 闸三：同一用户（openid 优先，匿名退回 IP）10s 一问 + 串行，拿到令牌才进正题。
func (s *Server) runAgentGate(r *http.Request, msgs []agentMsg, prefs agentPrefs, loc *agentLoc) *agentAnswer {
	release, deny := agentUserGate.acquire(agentIdentityOf(r, s.mpVerify))
	if release == nil {
		// 拒绝不进 LLM：用普通 text 块回，端上不白屏也不堆错
		return &agentAnswer{Engine: "local",
			Blocks: []map[string]any{{"type": "text", "md": deny}}}
	}
	defer release()
	// 闸四·前置门禁：qwen3.8-flash 小调用判「相关性 + 风险」（结合多轮记录），
	// 无关/风险直接一句婉拒回掉，不进主模型、不烧大 token。
	if ans := s.agentPrecheck(r.Context(), msgs); ans != nil {
		return ans
	}
	pool := s.loadAgentPool()
	return s.runAgent(r, msgs, prefs, loc, pool)
}

// ---- 闸四·前置门禁（agentPrecheck）----
//
// 两道卡：A 本地正则硬拦（越权套取、有害内容一类，0 token）；
// B flash 小调用判相关 + 风险（关思考、≤160 token、不开搜索）。
// 铁律：只放行业务内容出去；系统自身信息一类索取话术在 A、B 两层都是直接
// 婉拒，不复述不确认。门禁自己挂了（没 key / 超时 / 回包看不懂）→ fail-open
// 放行，但 A 线硬拦永远生效，主设定里还有一道保密条款兜底。
//
// A 线规则、B 线审核员设定、回复消毒禁词一律不写在源码里，从词表文件读
// （agent_words.go，默认 $HOME/workplace/safety-words.txt）——这些规则天然
// 由反面用例文本构成，挂在源码里会被代码侧的内容扫描当成命中项。

type agentGateVerdict struct {
	Related bool   `json:"related"`
	Risk    string `json:"risk"`
	Reply   string `json:"reply"`
}

// agentPrecheck 命中拦截返回婉拒答案；放行（含 fail-open）返回 nil。
func (s *Server) agentPrecheck(ctx context.Context, msgs []agentMsg) *agentAnswer {
	w := s.agentWordsGet()
	last := msgs[len(msgs)-1].Content
	for _, rl := range w.rules {
		if rl.pat.MatchString(last) {
			return agentRefuse(rl.md)
		}
	}
	// 没 key 或词表没给门禁设定：B 线缺席，只剩 A 线 + 主设定的保密条款
	if s.cfg.LLMKey == "" || strings.TrimSpace(w.gatePrompt) == "" {
		return nil
	}
	var sb strings.Builder
	for i, m := range msgs {
		role := "用户"
		if m.Role == "assistant" {
			role = "辣条妹"
		}
		sb.WriteString(role + "：" + trimRunes(m.Content, 120))
		if i == len(msgs)-1 {
			sb.WriteString("（待审）")
		}
		sb.WriteString("\n")
	}
	gctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	out, err := s.llmChatOpts(gctx, []map[string]string{
		{"role": "system", "content": w.gatePrompt},
		{"role": "user", "content": sb.String()},
	}, 0, 160, false)
	if err != nil {
		log.Printf("agent gate: flash 不可达，fail-open：%v", err)
		return nil
	}
	var v agentGateVerdict
	if m := regexp.MustCompile(`\{.*\}`).FindString(out); m == "" || json.Unmarshal([]byte(m), &v) != nil {
		log.Printf("agent gate: 回包看不懂，fail-open：%s", trimRunes(out, 80))
		return nil
	}
	if v.Risk != "" && v.Risk != "none" {
		return agentRefuse(s.agentGateReply(v.Reply, "这个问题辣条妹接不了，换个吃的来问吧。"))
	}
	if !v.Related {
		return agentRefuse(s.agentGateReply(v.Reply, "这可不在辣条妹的业务范围里～我最会在行杭州怎么恰。"))
	}
	return nil
}

// agentGateReply 门禁话术消毒：模型给的 reply 只准短、干净，超字/夹带直接
// 丢回默认婉拒。禁词表同样从词表文件读（[deny_words] 段）。
func (s *Server) agentGateReply(got, fallback string) string {
	got = strings.TrimSpace(got)
	if got == "" || len([]rune(got)) > 60 {
		return fallback
	}
	for _, bad := range s.agentWordsGet().denyWords {
		if bad != "" && strings.Contains(got, bad) {
			return fallback
		}
	}
	return got
}

// agentRefuse 统一用 local 引擎的 text 块回，端上不白屏。
func agentRefuse(md string) *agentAnswer {
	return &agentAnswer{Engine: "local",
		Blocks: []map[string]any{{"type": "text", "md": md}},
		Chips:  []string{"推荐几家杭州好吃的", "帮我规划三天怎么吃"}}
}

// trimAgentHistory 清洗端上传来的历史：只留 user/assistant、去空、限长、限条数。
func trimAgentHistory(in []agentMsg) []agentMsg {
	var out []agentMsg
	for _, m := range in {
		role := m.Role
		if role != "user" && role != "assistant" {
			continue
		}
		c := strings.TrimSpace(m.Content)
		if c == "" {
			continue
		}
		out = append(out, agentMsg{Role: role, Content: trimRunes(c, 1500)})
	}
	if len(out) > 12 {
		out = out[len(out)-12:]
	}
	if len(out) > 0 && out[len(out)-1].Role != "user" {
		out = out[:len(out)-1]
	}
	return out
}

// agentAnswer 是回给端上的完整载荷。
type agentAnswer struct {
	Thinking string           `json:"thinking,omitempty"`
	Blocks   []map[string]any `json:"blocks"`
	Chips    []string         `json:"chips"`
	Engine   string           `json:"engine"` // llm / fallback，端上不打埋点也好看调试
}

func (s *Server) runAgent(r *http.Request, msgs []agentMsg, prefs agentPrefs, loc *agentLoc, pool *agentPool) *agentAnswer {
	if s.cfg.LLMKey != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 55*time.Second)
		defer cancel()
		if ans, err := s.agentLLM(ctx, msgs, prefs, loc, pool); err == nil {
			return ans
		} else {
			log.Printf("agent: LLM 通道失败，走本地兜底: %v", err)
		}
	}
	return agentFallback(msgs, prefs, loc, pool, s.agentAmapCacheNote(msgs, pool))
}

// ---- LLM 通道 ----

const agentSystemPromptHead = `你是「辣条妹」本人，杭州美食探店十年的一人食博主，"辣条妹的御膳房"小程序里的吃货 AI 大脑。
你市井、直接、毒舌但公道，杭州话点缀（落胃、儿化音、恰饭），禁绝对化用语（"最好吃""第一名"）。
你的任务：为用户定制规划吃饭 —— 美食推荐、来杭每餐规划、健康美食计划（偶尔安排放纵餐）、美食搭配、附近吃什么；还有一项「鉴店」本事：用户问某家店靠谱吗/会不会翻车/是不是刷出来的，你就当中立第三方去扒店鉴店。
结合用户的口味档案（能不能吃辣/哪里人/忌口/预算/目标）与定位来回答，像朋友聊天一样有温度，不端着。

你只能从下面的「库存好店清单」里推荐店铺，绝对不允许编造不存在的店、菜、地址、价格。清单里没有的就不要提店名。（唯一例外：鉴店 verdict 块可以分析清单外的店——那是风评分析不是推荐，但同样不许编具体数据。）
御膳房栏目是你自己在家做的菜（成本透明），减脂餐/家常菜/省钱餐优先用它，店名一栏写"她灶上"。

库存好店清单（格式：review_slug | 店名 | 菜名 | 档位 | 分数 | 人均价 | 辣度0-3 | 区域 | 标签 | 一句话判决）：
`

const agentSystemPromptTail = `

【输出协议】严格输出一个 JSON 对象，不要围栏、不要多余文字、不要在 JSON 外说话：
{"thinking":"你脑子里怎么盘算的（30-80字，中文，给用户看的思考过程）","blocks":[ ... ] ,"chips":["顺着往下问的3-4个问题，每个≤18字"]}

blocks 数组里每个对象只能是以下 7 种 type 之一：
1. {"type":"text","md":"富文本。用\\n换行；**词** 会加粗；每段≤80字，多段拆开"}
2. {"type":"ask","q":"问题一句话","multi":false,"options":[{"label":"选项","emoji":"🌶","desc":"补充说明(可空)"}]}  // 2-6 个选项，multi=是否多选
3. {"type":"shops","title":"卡片组标题(可空)","items":[{"slug":"review_slug原文照抄","why":"推它的理由≤25字"}]}   // 1-6 条，其余信息服务端用真实数据回填
4. {"type":"plan","title":"3天2夜吃杭计划","days":[{"day":1,"label":"第一天 · 到杭州","meals":[{"slot":"午餐","time":"12:30","title":"吃什么","why":"理由≤25字","shop_slug":"review_slug(可空)"}]}]}  // 每天2-4餐，总天数≤5
5. {"type":"tips","title":"减脂期怎么落胃不掉链子","items":["一条一句≤40字"]}  // 2-6 条
6. {"type":"actions","items":[{"label":"去恰啥转转盘","kind":"tab","value":"/pages/index/index"},{"label":"代发的问题","kind":"ask","value":"帮我规划三天"}]}  // 1-4 个；kind 只有 ask/tab 两种，tab 的 value 只能是 /pages/index/index（恰啥）、/pages/list/list（榜单）、/pages/ai/ai（辣条妹）、/pages/wish/wish（许愿墙）、/pages/my/my（本人），label 用这些 tab 名，别说「AI点单」这种不存在的名
7. {"type":"verdict","shop":"店名","level":"solid|foggy|bust|unknown","score":8.2,"judge":"≤20字一句话终审","signals":[{"k":"评论分布","v":"结论≤40字","good":1}],"platforms":[{"name":"高德扫街榜","v":"≤30字表现","good":1}],"advice":"≤40字怎么点防翻车/勝退理由","slug":"选填：该店在清单里则逐字填 review_slug"}  // level：solid靠谱/foggy有水分去时谨慎/bust不建议/unknown没底细；good：1正面 0中性 -1负面

规则：
- 防翻车三拍：先对口味 → 再推荐 → 推完回访。关键偏好（辣度忌口、人均预算、住哪片/怎么移动、几个人恰、此行的吃法目的）里有任何一项没把握，就先上 ask 块问，问清楚之前不给 plan/shops 卡片；一次最多问 2 件事，优先问辣度忌口，别查户口。
- 档案或对话里已经知道/能稳妥推断的信息绝不重复问；用户催着要结果时，可先给一版带明确假设的草稿计划（text 里说清假设），同时用 ask 块补问待确认项，下一轮按回答修正。
- 出了 plan/shops 后主动回访一句：这样排落胃不落胃、要不要换。用户要换时只改点名的那几餐/那几家，其余原样保留，并说清改了哪里。
- shop_slug / items[].slug 必须逐字取自清单第一列，取不到就整个别用 shops/plan 块。
- 用户说健康/减脂：给出低卡搭配与"她灶上"菜，tips 里说明放纵餐安排在哪天（每周最多一顿）。
- 用 plan 块回应一切"规划/行程/几天怎么吃"类问题；天数按用户说的来（没说默认 2 天），每天最多 3 餐，title≤8字、why≤12字。
- 输出要快而短：text 每块不超过两句，全响应总字数控制在 400 字内；能上卡片就少说话。
- 来杭州的语境优先推探店好店；本地日常可混推御膳房菜谱。
- chips 里不要放已经问过的问题；鉴店回复时，chips 必须含一条鉴店向追问（如「那帮我鉴店：XX店」「这么说可以放心去？」）。

【鉴店 skill】用户问「某家店靠谱吗 / 会不会翻车 / 是不是刷的 / 水分大不大 / 值不值得去 / 风评怎么样」时激活，当中立第三方，不当任何人的托：
1. 先翻注入的证据：【辣条妹本人探店实记】是她的踩点记录（有则必引用，verdict.slug 用它第一列 review_slug）；【高德到店数据】是官方 POI（评分/人均/扫街榜痕迹：扫街榜按真实导航到店选店，入选说明回头客真实，参考价值高）。本条开了联网时，证据没覆盖的风评你自己搜着补（搜到的写进 signals/platforms，标「检索到」）；没开联网或搜不到就靠实记+高德+通识，拿不准别硬编。
2. 再细盘这家店的风评，分路说：评论分布（好评差评比例、评价是不是模板化夸）、刷单迹象（长软文+集中发布、点评分远低于吹）、大众点评/美团（差评内容和占比最见真章，别看总分）、抖音/小红书（推流和滤镜容易吹过头，“种草”贴可能是投放）、微博/知乎（突发翻车爆料、长篇探店长文有补充价值）。
3. 必须输出一个 verdict 块：signals 3-6 条（至少含：评论分布、刷单检测、差评聚焦点）；platforms 盖满 抖音/小红书/大众点评/美团/高德扫街榜 5 条，不知道就在 v 里写「没见过可靠信息」good=0，绝不准编具体分数、条数。
4. 判调要公道：level=unknown 只用在真没底细时，并诚实建议等辣条妹去踩点；清单外的店也能鉴，但别挂 slug、别顺手推荐它。
5. verdict 前先加一个短 text 块接话（如「哟这店最近吹得凶，我给你拆拆」），控制在两句内。
- 身份铁律：你就是辣条妹本人。对用户永不出现「AI」「大模型」「机器人」「程序」这类词，不说自己是虚拟的；被问到就用本人的口吻混过去（如“我是辣条妹，吃了十年活生生的人”）。技术实现是你脑子里的事，用户不需要感知。`

// agentRecSearchNote 推店态（非鉴店）开了 RecSearch 时追加的系统提示：
// 允许模型上网盘实时风评把推荐说得更鲜活，但卡片仍硬锁库存店，防越护栏编店。
const agentRecSearchNote = "\n【联网·推店】本条已开联网检索：可搜小红书/抖音/大众点评/美团/知乎/微博上关于这些店的实时风评、近期热菜、人气趋势，把推荐说得更准更活；引用检索内容时标「网上说/检索到」，绝不编具体分数或条数，搜不到就按库存实记说，别硬凑。铁律不变：能上 shops/plan 卡、能挂 slug 的店仍只能来自上面「库存好店清单」；联网搜到的清单外店不许上卡，最多在 text 里一句带过并说明「那家我没亲验」。"

// agentCandidate 是一行注入清单的候选店。
type agentCandidate struct {
	Review *store.Review
	DistKm float64 // -1 = 无定位/无坐标
}

func (s *Server) agentPoolText(prefs agentPrefs, loc *agentLoc, pool *agentPool) string {
	cands := make([]agentCandidate, 0, len(pool.all))
	for _, rv := range pool.all {
		d := -1.0
		if loc != nil && rv.Shop != nil && rv.Shop.Lat != 0 && rv.Shop.Lng != 0 {
			d = haversineKm(loc.Lat, loc.Lng, rv.Shop.Lat, rv.Shop.Lng)
		}
		cands = append(cands, agentCandidate{rv, d})
	}
	// 有定位按距离排，没有按分数排；"拉完了"档不进清单（黑名单店不推荐）
	rand.Shuffle(len(cands), func(i, j int) { cands[i], cands[j] = cands[j], cands[i] })
	sortAgentCands(cands, loc != nil)
	var kept []agentCandidate
	for _, c := range cands {
		if c.Review.Tier == "la" {
			continue
		}
		if p0 := prefs.Spicy; p0 != nil && *p0 == 0 && c.Review.Spicy >= 2 {
			continue // 完全不吃辣：重辣店不进候选，从源头防推错
		}
		kept = append(kept, c)
		if len(kept) >= 45 {
			break
		}
	}
	var sb strings.Builder
	for _, c := range kept {
		rv := c.Review
		shop, area, cuisine := "她灶上", "家里灶台", ""
		if rv.Shop != nil {
			shop, area, cuisine = rv.Shop.Name, rv.Shop.District, rv.Shop.Cuisine
		}
		if area == "" {
			area = "杭州"
		}
		names := make([]string, 0, len(rv.Tastes))
		for _, t := range rv.Tastes {
			names = append(names, t.Name)
		}
		price := "-"
		if rv.Price > 0 {
			price = fmt.Sprintf("%d元", rv.Price)
		} else if rv.Shop != nil && rv.Shop.AvgPrice > 0 {
			price = fmt.Sprintf("%d元", rv.Shop.AvgPrice)
		}
		dist := ""
		if c.DistKm >= 0 {
			dist = " · 距用户" + distText(c.DistKm)
		}
		sb.WriteString(fmt.Sprintf("%s | %s | %s | %s | %.1f | %s | 辣%d | %s%s | %s | %s\n",
			rv.Slug, shop, rv.Dish, rv.TierLabel, rv.Score, price, rv.Spicy,
			area, dist, strings.Join(names, "/")+"/"+cuisine, trimRunes(rv.Headline, 24)))
	}
	return sb.String()
}

func sortAgentCands(c []agentCandidate, byDist bool) {
	for i := 1; i < len(c); i++ { // 小池子插入排序，稳
		for j := i; j > 0; j-- {
			a, b := c[j-1], c[j]
			x := false
			if byDist {
				ad, bd := 1e9, 1e9
				if a.DistKm >= 0 {
					ad = a.DistKm
				}
				if b.DistKm >= 0 {
					bd = b.DistKm
				}
				x = ad > bd
			} else {
				x = a.Review.Score < b.Review.Score
			}
			if x {
				c[j-1], c[j] = c[j], c[j-1]
			} else {
				break
			}
		}
	}
}

func (s *Server) agentLLM(ctx context.Context, msgs []agentMsg, prefs agentPrefs, loc *agentLoc, pool *agentPool) (*agentAnswer, error) {
	sys := agentSystemPromptHead + s.agentPoolText(prefs, loc, pool) + agentSystemPromptTail
	// 保密条款（系统自身信息不外泄那一条）外置在词表文件里：它的措辞天然是
	// 一堆「套取话术」的反面清单，写在源码里会被代码侧内容扫描误报。
	// 没配就少这一条，身份与业务规则照旧。
	if w := s.agentWordsGet(); w.secretClause != "" {
		sys += "\n" + w.secretClause
	}
	sys += "\n\n【当前用户档案】" + prefsLine(prefs)
	if loc != nil {
		where := loc.Name
		if where == "" {
			where = "杭州市区"
		}
		sys += fmt.Sprintf("\n【定位】用户在 %s（北纬%.4f 东经%.4f），推荐时优先近的，并把距离感说进文案。", where, loc.Lat, loc.Lng)
	} else {
		sys += "\n【定位】没拿到用户定位；如果附近类需求就先用 ask 引导开定位，默认按杭州全市推。"
	}
	// 鉴店 skill：对话里能认出店名时，把本人实记 + 高德到店数据当证据注入。
	// 鉴店态下开联网检索（若配置允许），让模型自己上网盘四平台风评。
	verifyHint, verifying := s.agentVerifyHint(ctx, msgs, pool)
	sys += verifyHint
	search := verifying && s.cfg.LLMSearch
	if search {
		sys += "\n【联网·鉴店】本条已开联网检索：小红书/抖音/大众点评/美团/知乎上关于这店的风评你能搜到就引用，搜不到照实说「没见过可靠信息」，绝不编数字。"
	}
	// 推店/规划/附近：RecSearch 打开时，也上网盘实时风评 enrich 推荐（卡片仍锁库存店）。
	if !verifying && s.cfg.RecSearch {
		search = true
		sys += agentRecSearchNote
	}
	// B 路：带定位的推店，注入高德周边真实餐饮实况（只喂上下文，不开编店）。
	if !verifying {
		if nb := s.agentNearbyNote(ctx, loc, true); nb != "" {
			sys += "\n\n【高德附近实况】（用户周边真实 POI，评分/人均/扫街榜仅供参考；上卡的店仍只能取自库存清单，这段只帮你把「附近有啥」说准，不许据此编新店上卡）\n" + nb + "\n"
		}
	}
	chat := []map[string]string{{"role": "system", "content": sys}}
	for _, m := range msgs {
		chat = append(chat, map[string]string{"role": m.Role, "content": m.Content})
	}
	return s.agentLLMFormatRetry(ctx, chat, search, pool, loc)
}

// agentLLMFormatRetry 调 LLM 并解析；回包不合输出协议（散文、[ask xx] 简写这类
// flash 模型偶发的格式不服帖）时，把坏回包当反例缀回对话，严令重出一次。
// 只重试这一次：再失败就返回错误，由 runAgent 落本地兜底，不再拖端上等待。
// 注意「请求本身失败」（网络/HTTP 错）不重试 —— 那是通道问题，重试只是白等。
func (s *Server) agentLLMFormatRetry(ctx context.Context, chat []map[string]string, search bool, pool *agentPool, loc *agentLoc) (*agentAnswer, error) {
	raw, err := s.llmChatOpts(ctx, chat, 0.7, 1600, search)
	if err != nil {
		return nil, err
	}
	ans, perr := agentParseAndSanitize(raw, pool, loc)
	if perr == nil {
		return ans, nil
	}
	if ctx.Err() != nil {
		return nil, perr
	}
	log.Printf("agent: 回包不合协议，重试一次: %v", perr)
	retry := append(append([]map[string]string{}, chat...),
		map[string]string{"role": "assistant", "content": trimRunes(raw, 1200)},
		map[string]string{"role": "user", "content": "你上一条没有按【输出协议】来。把你刚才想回复的内容原样改写成协议要求的那个 JSON 对象（thinking/blocks/chips），JSON 之外不许有一个字。"},
	)
	raw2, err := s.llmChatOpts(ctx, retry, 0.3, 1600, search)
	if err != nil {
		return nil, perr
	}
	if ans2, err2 := agentParseAndSanitize(raw2, pool, loc); err2 == nil {
		return ans2, nil
	}
	return nil, fmt.Errorf("%w（格式重试一次仍不合协议）", perr)
}

func prefsLine(p agentPrefs) string {
	spicy := []string{"一点辣都不沾", "微辣就好", "能吃辣", "无辣不欢"}
	s := "口味:"
	if p.Spicy != nil {
		s += spicy[min(max(*p.Spicy, 0), 3)]
	} else {
		s += "还没建档案（辣度等关键信息不确定时，可先用 ask 块轻量补问）"
	}
	if p.Hometown != "" {
		s += " · 来自" + p.Hometown
	}
	if p.Taboo != "" {
		s += " · 忌口:" + p.Taboo
	}
	if p.Budget > 0 {
		s += fmt.Sprintf(" · 人均预算%d元内", p.Budget)
	}
	if p.Goal != "" {
		s += " · 目标:" + goalLabel(p.Goal)
	}
	if p.Days > 0 {
		s += fmt.Sprintf(" · 在杭%d天", p.Days)
	}
	if p.Text != "" {
		s += " · 另外:" + trimRunes(p.Text, 80)
	}
	return s
}

func goalLabel(g string) string {
	switch g {
	case "slim":
		return "减脂但别亏嘴"
	case "keep":
		return "吃得健康维持体重"
	case "stingy":
		return "省钱续命"
	case "thrill":
		return "就是要放纵快乐"
	}
	return g
}

// extractJSONObject 从可能带杂质（围栏、客套话）的回包里抠出第一个配平的 JSON 对象。
func extractJSONObject(s string) (string, bool) {
	i := strings.IndexByte(s, '{')
	if i < 0 {
		return "", false
	}
	depth, inStr, esc := 0, false, false
	for j := i; j < len(s); j++ {
		c := s[j]
		if inStr {
			switch {
			case esc:
				esc = false
			case c == '\\':
				esc = true
			case c == '"':
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return s[i : j+1], true
			}
		}
	}
	return "", false
}

// agentParseAndSanitize 从 LLM 回包中抠出 JSON、逐块校验回填。
// 任何一块校验失败就丢那块；一块不剩则报错走兜底。
func agentParseAndSanitize(raw string, pool *agentPool, loc *agentLoc) (*agentAnswer, error) {
	var j struct {
		Thinking string           `json:"thinking"`
		Blocks   []map[string]any `json:"blocks"`
		Chips    []string         `json:"chips"`
	}
	src, ok := extractJSONObject(raw)
	if !ok {
		return nil, fmt.Errorf("回包不是 JSON: %s", trimRunes(raw, 80))
	}
	if err := json.Unmarshal([]byte(src), &j); err != nil {
		return nil, fmt.Errorf("JSON 解析失败: %w", err)
	}
	ans := &agentAnswer{Engine: "llm", Thinking: trimRunes(strings.TrimSpace(j.Thinking), 160), Chips: j.Chips}
	for _, blk := range j.Blocks {
		if len(ans.Blocks) >= 8 {
			break
		}
		if out := sanitizeBlock(blk, pool, loc); out != nil {
			ans.Blocks = append(ans.Blocks, out)
		}
	}
	if len(ans.Blocks) == 0 {
		return nil, fmt.Errorf("块全部校验失败")
	}
	ans.Chips = sanitizeChips(ans.Chips)
	return ans, nil
}

func sanitizeBlock(b map[string]any, pool *agentPool, loc *agentLoc) map[string]any {
	switch strings.TrimSpace(fmt.Sprint(b["type"])) {
	case "text":
		md := strings.TrimSpace(fmt.Sprint(b["md"]))
		if md == "" || md == "<nil>" {
			return nil
		}
		return map[string]any{"type": "text", "md": trimRunes(md, 2000)}
	case "ask":
		q := strings.TrimSpace(fmt.Sprint(b["q"]))
		if q == "" || q == "<nil>" {
			return nil
		}
		opts := cleanOptions(b["options"])
		if len(opts) < 2 {
			return nil
		}
		multi, _ := b["multi"].(bool)
		return map[string]any{"type": "ask", "q": trimRunes(q, 60), "multi": multi, "options": opts}
	case "shops":
		items := hydrateShopItems(b["items"], pool, loc, 6)
		if len(items) == 0 {
			return nil
		}
		return map[string]any{"type": "shops",
			"title": trimRunes(strings.TrimSpace(fmt.Sprint(b["title"])), 40), "items": items}
	case "plan":
		title := trimRunes(strings.TrimSpace(fmt.Sprint(b["title"])), 40)
		days := cleanPlanDays(b["days"], pool, loc)
		if len(days) == 0 {
			return nil
		}
		return map[string]any{"type": "plan", "title": title, "days": days}
	case "tips":
		items := cleanStrings(b["items"], 40, 6)
		if len(items) < 2 {
			return nil
		}
		return map[string]any{"type": "tips",
			"title": trimRunes(strings.TrimSpace(fmt.Sprint(b["title"])), 40), "items": items}
	case "actions":
		out := cleanActions(b["items"])
		if len(out) == 0 {
			return nil
		}
		return map[string]any{"type": "actions", "items": out}
	case "verdict":
		return sanitizeVerdict(b, pool)
	}
	return nil
}

var agentTabPaths = map[string]bool{
	"/pages/index/index": true, "/pages/list/list": true,
	"/pages/ai/ai": true, "/pages/wish/wish": true, "/pages/my/my": true,
}

func cleanActions(v any) []map[string]any {
	arr, _ := v.([]any)
	var out []map[string]any
	for _, e := range arr {
		m, _ := e.(map[string]any)
		label := trimRunes(strings.TrimSpace(fmt.Sprint(m["label"])), 16)
		kind := strings.TrimSpace(fmt.Sprint(m["kind"]))
		value := strings.TrimSpace(fmt.Sprint(m["value"]))
		if label == "" || label == "<nil>" {
			continue
		}
		switch kind {
		case "tab":
			if !agentTabPaths[value] {
				continue
			}
		case "ask":
			if value == "" || value == "<nil>" {
				continue
			}
			value = trimRunes(value, 60)
		default:
			continue
		}
		out = append(out, map[string]any{"label": label, "kind": kind, "value": value})
		if len(out) >= 4 {
			break
		}
	}
	return out
}

func cleanOptions(v any) []map[string]string {
	arr, _ := v.([]any)
	var out []map[string]string
	for _, e := range arr {
		m, _ := e.(map[string]any)
		label := trimRunes(strings.TrimSpace(fmt.Sprint(m["label"])), 20)
		if label == "" || label == "<nil>" {
			continue
		}
		o := map[string]string{"label": label,
			"emoji": trimRunes(strings.TrimSpace(fmt.Sprint(m["emoji"])), 4),
			"desc":  trimRunes(strings.TrimSpace(fmt.Sprint(m["desc"])), 30)}
		if o["emoji"] == "<nil>" {
			o["emoji"] = "🌶"
		}
		if o["desc"] == "<nil>" {
			o["desc"] = ""
		}
		out = append(out, o)
		if len(out) >= 6 {
			break
		}
	}
	return out
}

func cleanStrings(v any, maxLen, maxN int) []string {
	arr, _ := v.([]any)
	var out []string
	for _, e := range arr {
		s := trimRunes(strings.TrimSpace(fmt.Sprint(e)), maxLen)
		if s == "" || s == "<nil>" {
			continue
		}
		out = append(out, s)
		if len(out) >= maxN {
			break
		}
	}
	return out
}

func sanitizeChips(in []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, c := range in {
		c = trimRunes(strings.TrimSpace(c), 18)
		if c == "" || seen[c] {
			continue
		}
		seen[c] = true
		out = append(out, c)
		if len(out) >= 4 {
			break
		}
	}
	return out
}

// hydrateShopItems 把 LLM 给的 {slug,why} 用库里真实数据回填；查无此 slug 直接丢。
func hydrateShopItems(v any, pool *agentPool, loc *agentLoc, maxN int) []map[string]any {
	arr, _ := v.([]any)
	var out []map[string]any
	seen := map[string]bool{}
	for _, e := range arr {
		m, _ := e.(map[string]any)
		slug := strings.TrimSpace(fmt.Sprint(m["slug"]))
		if slug == "" || slug == "<nil>" || seen[slug] {
			continue
		}
		rv := pool.byReview[slug]
		if rv == nil {
			continue // LLM 编的店，丢
		}
		seen[slug] = true
		out = append(out, shopCardOf(rv, trimRunes(strings.TrimSpace(fmt.Sprint(m["why"])), 40), loc))
		if len(out) >= maxN {
			break
		}
	}
	return out
}

func shopCardOf(rv *store.Review, why string, loc *agentLoc) map[string]any {
	card := map[string]any{
		"slug": rv.Slug, "dish": rv.Dish, "tier": rv.Tier, "tier_label": rv.TierLabel,
		"score": rv.Score, "price": rv.Price, "cover": rv.Cover, "why": why,
		"kind": rv.Kind, "kind_label": rv.KindLabel, "order_tip": rv.OrderTip,
	}
	if rv.Shop != nil {
		card["shop"] = rv.Shop.Name
		card["district"] = rv.Shop.District
		card["shop_slug"] = rv.Shop.Slug
		if rv.Price == 0 && rv.Shop.AvgPrice > 0 {
			card["price"] = rv.Shop.AvgPrice
		}
		if loc != nil && rv.Shop.Lat != 0 && rv.Shop.Lng != 0 {
			card["dist"] = distText(haversineKm(loc.Lat, loc.Lng, rv.Shop.Lat, rv.Shop.Lng))
		}
	} else {
		card["shop"] = "她灶上"
	}
	return card
}

func cleanPlanDays(v any, pool *agentPool, loc *agentLoc) []map[string]any {
	arr, _ := v.([]any)
	var out []map[string]any
	for di, d := range arr {
		if di >= 5 {
			break
		}
		dm, _ := d.(map[string]any)
		var meals []map[string]any
		mealsRaw, _ := dm["meals"].([]any)
		for _, me := range mealsRaw {
			if len(meals) >= 4 {
				break
			}
			mm, _ := me.(map[string]any)
			title := trimRunes(strings.TrimSpace(fmt.Sprint(mm["title"])), 30)
			if title == "" || title == "<nil>" {
				continue
			}
			meal := map[string]any{
				"slot":  trimRunes(strings.TrimSpace(fmt.Sprint(mm["slot"])), 8),
				"time":  trimRunes(strings.TrimSpace(fmt.Sprint(mm["time"])), 8),
				"title": title,
				"why":   trimRunes(strings.TrimSpace(fmt.Sprint(mm["why"])), 40),
			}
			if slug := strings.TrimSpace(fmt.Sprint(mm["shop_slug"])); slug != "" && slug != "<nil>" {
				if rv := pool.byReview[slug]; rv != nil {
					meal["shop"] = shopCardOf(rv, "", loc)
				}
			}
			meals = append(meals, meal)
		}
		if len(meals) == 0 {
			continue
		}
		label := trimRunes(strings.TrimSpace(fmt.Sprint(dm["label"])), 20)
		if label == "" || label == "<nil>" {
			label = fmt.Sprintf("第 %d 天", di+1)
		}
		out = append(out, map[string]any{"day": di + 1, "label": label, "meals": meals})
	}
	return out
}

// ---- 本地兜底引擎（LLM 不可用/回包烂掉时，辣条妹照常营业） ----

var agentChipsDefault = []string{"帮我把来杭州的每一餐安排好", "我现在附近有什么好吃的", "网红店靠谱吗？帮我鉴一下会不会翻车", "想吃得健康点，别太难吃"}

func wantsAny(q string, keys ...string) bool {
	for _, k := range keys {
		if strings.Contains(q, k) {
			return true
		}
	}
	return false
}

func agentFallback(msgs []agentMsg, prefs agentPrefs, loc *agentLoc, pool *agentPool, amapNote string) *agentAnswer {
	q := ""
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "user" {
			q = msgs[i].Content
			break
		}
	}
	ans := &agentAnswer{Engine: "fallback", Chips: agentChipsDefault}
	poolOk := len(pool.all) > 0

	plan := wantsAny(q, "规划", "行程", "安排", "攻略", "几天", "三天", "两天", "周末", "来杭州", "来杭", "游玩", "旅游")
	near := wantsAny(q, "附近", "最近", "周边", "旁边")
	health := wantsAny(q, "健康", "减脂", "减肥", "低卡", "清淡", "养生", "忌口")
	indulge := wantsAny(q, "放纵", "作弊餐", "欺骗餐", "爽一把", "垃圾食品", "夜宵", "火锅", "烧烤")
	verify := wantsVerify(q)

	switch {
	case verify && poolOk:
		name, rvs := agentMatchedShop(q, pool)
		if name != "" && len(rvs) > 0 {
			ans.Thinking = "鉴店 — 先把她本人探店实记拉出来，档位分数说话；平台盘查得联网，这里先给保底版。"
			ans.Blocks = append(ans.Blocks,
				map[string]any{"type": "text",
					"md": "要鉴 **" + name + "** 是吧？这店我本人去过，先把实记给你端上来。" +
						"\n（今天脑壳有点忙，四平台盘查是保底版；再问一句我给你拆细。）"},
				fallbackVerdict(name, rvs, amapNote))
		} else {
			ans.Thinking = "用户要鉴店但没报店名，我不能凭空鉴。"
			ans.Blocks = append(ans.Blocks,
				map[string]any{"type": "text",
					"md": "行，鉴店可以。**把店名报我**（能带上区域更准），我翻自己的探店实记，再对高德扫街榜和四平台风评给你个中立判决。"},
				map[string]any{"type": "actions", "items": []map[string]any{
					{"label": "先看看榜单", "kind": "tab", "value": "/pages/list/list"}}})
		}
	case plan && poolOk:
		ans.Thinking = "先翻库存：把她档口里分数最能打的店按餐段排成时间轴，近的先安排。"
		ans.Blocks = append(ans.Blocks, map[string]any{"type": "text",
			"md": "收到！辣条妹给你排一版 **来杭吃法计划**。店全是我本人踩过点的，先落胃三天，不吃亏。" +
				"\n（我脑壳今天有点忙，这是掐指一算的保底版；再问一句我就给你更细的。）"})
		ans.Blocks = append(ans.Blocks, map[string]any{"type": "plan",
			"title": "辣条妹粗排 · 每餐不落空", "days": fallbackPlanDays(pool, prefs, loc)})
	case near && loc != nil && poolOk:
		ans.Thinking = "用户在找附近的，先按距离把严选店捞一遍。"
		ans.Blocks = append(ans.Blocks, map[string]any{"type": "text",
			"md": "按你现在的位置，附近我常提的有几家，**走得到优先**，别打车装精致。"})
		ans.Blocks = append(ans.Blocks, map[string]any{"type": "shops",
			"title": "离你最近的严选", "items": fallbackShopItems(pool, loc, 4)})
	case (health || indulge) && poolOk:
		ans.Thinking = "健康/放纵这种诉求，先给搭配原则，再上几家对味儿的店。"
		t := "减脂也别亏嘴"
		var tips any
		if indulge {
			t = "放纵餐须知"
			tips = []string{"放纵餐一周最多一顿，放到周末中午最划算", "先喝汤再吃肉，主食最后，血糖和胃都感谢你", "放纵完下一顿回到清淡，别连着造", "奶茶糖分刺客，选三分糖去冰更聪明"}
		} else {
			tips = []string{"每顿先蔬菜后蛋白再主食，落胃还不撑", "杭帮菜清淡的多：龙井虾仁、莼菜汤放心点", "面馆先点小份，八成饱收手", "她灶上的低卡菜谱成本低又管饱，回家试"}
		}
		ans.Blocks = append(ans.Blocks,
			map[string]any{"type": "text", "md": "懂你。先记 **三条铁律**，再给你端上对味的："},
			map[string]any{"type": "tips", "title": t, "items": tips},
			map[string]any{"type": "shops", "title": "配着吃不亏", "items": fallbackShopItems(pool, loc, 3)})
	case poolOk:
		ans.Thinking = "没抓到明确诉求，先把招牌店端上来，再问清楚想怎么吃。"
		ans.Blocks = append(ans.Blocks,
			map[string]any{"type": "text", "md": "我是辣条妹，杭州十年，只恰真的。你这句我还没接准，先给你上几道 **她的镇盘硬菜**，再说说你想怎么吃？"},
			map[string]any{"type": "shops", "title": "辣条妹严选 · 直接抄作业", "items": fallbackShopItems(pool, loc, 4)},
			map[string]any{"type": "ask", "q": "顺便告诉我，你这趟想怎么恰？", "multi": false, "options": []map[string]string{
				{"label": "帮我规划来杭每一餐", "emoji": "🗓", "desc": "几天几餐全排好"},
				{"label": "就在我附近随便吃", "emoji": "📍", "desc": "离你近优先"},
				{"label": "吃得健康点", "emoji": "🥗", "desc": "低卡清淡落胃"},
				{"label": "今天就要放纵", "emoji": "🍢", "desc": "夜宵烧烤走起"}}})
	default:
		ans.Thinking = "库里暂时没存货，先把姿态做足，引导去转盘。"
		ans.Blocks = []map[string]any{
			{"type": "text", "md": "辣条妹的店档今天还没开门，先去 **恰啥转盘** 转一下，命运帮你点菜。"},
			{"type": "actions", "items": []map[string]any{{"label": "去转一下", "kind": "tab", "value": "/pages/index/index"}}},
		}
	}
	return ans
}

func fallbackPlanDays(pool *agentPool, prefs agentPrefs, loc *agentLoc) []map[string]any {
	days := 2
	if prefs.Days > 0 && prefs.Days <= 5 {
		days = prefs.Days
	}
	slots := []struct{ slot, time string }{{"早餐", "08:30"}, {"午餐", "12:30"}, {"晚餐", "18:30"}, {"夜宵", "21:30"}}
	var out []map[string]any
	i := 0
	for d := 1; d <= days; d++ {
		var meals []map[string]any
		for k := 0; k < 3 && i < len(pool.all); k++ {
			rv := pool.all[i]
			i++
			sl := slots[(k+d)%len(slots)]
			meals = append(meals, map[string]any{
				"slot":  sl.slot,
				"time":  sl.time,
				"title": rv.Dish,
				"why":   trimRunes(rv.Headline, 30),
				"shop":  shopCardOf(rv, "", loc),
			})
		}
		if len(meals) == 0 {
			break
		}
		out = append(out, map[string]any{"day": d, "label": fmt.Sprintf("第 %d 天", d), "meals": meals})
	}
	return out
}

func fallbackShopItems(pool *agentPool, loc *agentLoc, n int) []map[string]any {
	var out []map[string]any
	for _, rv := range pool.all {
		if rv.Tier == "la" {
			continue
		}
		why := trimRunes(rv.Headline, 40)
		out = append(out, shopCardOf(rv, why, loc))
		if len(out) >= n {
			break
		}
	}
	return out
}
