package httpapi

// ============================================================
// agent 词表 / 话术外置加载器。
//
// agent 的本地硬拦规则、门禁审核员的角色设定、回复消毒禁词，天然要写一堆
// 「反面用例」文本（违规内容、越权套取之类）。这些东西挂在源码里会被
// 代码侧的内容安全扫描当成命中项，白白干扰日常开发，所以一律外置：源码
// 只留加载与解析，文本落在一个纯文本文件里。
//
// 默认路径 $HOME/workplace/safety-words.txt（可用 LATIAOMEI_WORDS_FILE 覆盖，
// 见 internal/config）。每次取用按 mtime + size 判断要不要重读，改完存盘
// 即生效，不必重启服务。文件缺失 / 读坏 / 单条规则编不出来，都只是安静
// 降级并记一行日志：少一道 0 成本的本地硬拦，或跳过小模型门禁，主对话照常。
//
// 文件格式（段落标记与键名是这份实现定的，不是通用配置格式）：
//   [rule]          一条本地硬拦规则，可重复写多段
//     pat=   Go RE2 正则
//     reply= 命中后回给端上的富文本（缺省用 agentWordsFallbackReply）
//   [deny_words]    回复消毒禁词，一行一个
//   [gate_prompt]   门禁审核员角色设定，段内原文照用（可多行）
//   [secret_clause] 主角色设定末尾的保密条款，段内原文照用（可多行）
// 段外的内容（文件头说明、空行）一律忽略；段内以 # 开头的行是注释；
// 文本段里写成一行时可用字面 \n 断行。
// ============================================================

import (
	"fmt"
	"log"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

// agentRule 一条本地硬拦规则：命中 pat 就原样回 md。
type agentRule struct {
	pat *regexp.Regexp
	md  string
}

// agentWords 是词表文件的解析结果；零值等于「什么都没配」，各调用点按空处理。
type agentWords struct {
	rules        []agentRule
	denyWords    []string
	gatePrompt   string
	secretClause string
}

// agentWordsFallbackReply 规则带了 pat 却没写 reply 时的兜底话术。
const agentWordsFallbackReply = "这话辣条妹不接，咱还是聊杭州怎么恰。"

// agentWordsLoader 按路径缓存一份解析结果，文件变了就重读。
// 拿不到文件只降级，不报错不阻塞 —— 启动路径上不该因为一个词表文件起不来。
type agentWordsLoader struct {
	path string

	mu   sync.Mutex
	cur  *agentWords
	mod  time.Time
	size int64
}

func newAgentWordsLoader(path string) *agentWordsLoader { return &agentWordsLoader{path: path} }

// get 取当前词表。并发安全；文件改了下次取用就生效。
func (l *agentWordsLoader) get() *agentWords {
	if l == nil || strings.TrimSpace(l.path) == "" {
		return &agentWords{}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	fi, err := os.Stat(l.path)
	if err != nil {
		if l.cur == nil {
			l.cur = &agentWords{}
			log.Printf("agent: 词表文件不可用（%s: %v）：本地硬拦与门禁设定降级，主对话照常", l.path, err)
		}
		return l.cur
	}
	if l.cur != nil && fi.Size() == l.size && fi.ModTime().Equal(l.mod) {
		return l.cur
	}
	b, err := os.ReadFile(l.path)
	if err != nil {
		if l.cur == nil {
			l.cur = &agentWords{}
		}
		log.Printf("agent: 读词表文件失败（%s）: %v", l.path, err)
		return l.cur
	}
	w, warns := parseAgentWords(string(b))
	for _, s := range warns {
		log.Printf("agent: 词表文件 %s: %s", l.path, s)
	}
	first := l.cur == nil
	l.cur, l.mod, l.size = w, fi.ModTime(), fi.Size()
	if first {
		log.Printf("agent: 已载入词表 %s（硬拦规则 %d 条 / 消毒禁词 %d 个 / 门禁设定 %d 字 / 保密条款 %d 字）",
			l.path, len(w.rules), len(w.denyWords), len([]rune(w.gatePrompt)), len([]rune(w.secretClause)))
	}
	return w
}

// agentWordsGet 取本服务当前词表；Server 是测试里手搓的（没 loader）就给空表。
func (s *Server) agentWordsGet() *agentWords {
	if s.words == nil {
		return &agentWords{}
	}
	return s.words.get()
}

// wordsSection 是文件里按 [段名] 切开的一段原始行。
type wordsSection struct {
	name  string
	lines []string
}

// parseAgentWords 解析词表文本；返回解析结果和一份「哪里没看懂」的提示。
// 单条规则坏了只丢那一条，其余段落照常生效。
func parseAgentWords(src string) (*agentWords, []string) {
	w := &agentWords{}
	var warns []string
	var sections []*wordsSection
	var cur *wordsSection
	for _, raw := range strings.Split(src, "\n") {
		line := strings.TrimRight(raw, "\r")
		t := strings.TrimSpace(line)
		if len(t) > 2 && strings.HasPrefix(t, "[") && strings.HasSuffix(t, "]") && !strings.Contains(t, "=") {
			cur = &wordsSection{name: strings.ToLower(strings.Trim(t, "[] "))}
			sections = append(sections, cur)
			continue
		}
		if cur == nil || strings.HasPrefix(t, "#") { // 段外说明、段内注释都不算内容
			continue
		}
		cur.lines = append(cur.lines, line)
	}
	for _, sec := range sections {
		switch sec.name {
		case "rule":
			rv, warn := parseWordsRule(sec.lines)
			if warn != "" {
				warns = append(warns, warn)
			}
			if rv != nil {
				w.rules = append(w.rules, *rv)
			}
		case "deny_words":
			for _, l := range sec.lines {
				if s := strings.TrimSpace(l); s != "" {
					w.denyWords = append(w.denyWords, s)
				}
			}
		case "gate_prompt":
			w.gatePrompt = sectionText(sec.lines)
		case "secret_clause":
			w.secretClause = sectionText(sec.lines)
		default:
			warns = append(warns, fmt.Sprintf("未知段名 [%s]，已跳过", sec.name))
		}
	}
	return w, warns
}

// parseWordsRule 解析一个 [rule] 段；坏规则返回 nil + 说明，调用方照着记日志。
func parseWordsRule(lines []string) (*agentRule, string) {
	pat, reply := "", ""
	for _, l := range lines {
		t := strings.TrimSpace(l)
		if v, ok := strings.CutPrefix(t, "pat="); ok {
			pat = strings.TrimSpace(v)
		} else if v, ok := strings.CutPrefix(t, "reply="); ok {
			reply = strings.TrimSpace(v)
		}
	}
	if pat == "" {
		return nil, "rule 段缺 pat=，已跳过"
	}
	re, err := regexp.Compile(pat)
	if err != nil {
		return nil, fmt.Sprintf("rule 正则编译失败（%s）: %v", trimRunes(pat, 40), err)
	}
	if reply == "" {
		reply = agentWordsFallbackReply
	}
	return &agentRule{pat: re, md: reply}, ""
}

// sectionText 把段内原文拼回一段文本：保留换行、去掉首尾空白，
// 顺带支持整段写成一行、用字面 \n 断行。
func sectionText(lines []string) string {
	s := strings.TrimSpace(strings.Join(lines, "\n"))
	return strings.ReplaceAll(s, `\n`, "\n")
}
