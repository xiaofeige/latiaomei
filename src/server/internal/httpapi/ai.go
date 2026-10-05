package httpapi

// v10 AI 工坊（管理小程序 Tab3 专用）：
//   - hAdminAiPolish：把语音转写/随手敲的任务描述，交给 LLM 结构化成规范的视频
//     制作提示词。绝不让原始语音转写直接进生产链路——那样产出质量很差。
//   - hAdminVideoMission：收下「素材（多图/多文件）+ 结构化提示词 + 目标平台」，
//     入队 video_mission 任务。worker 产成片后落 social_items 等人工审核放行，
//     和文案一样：机器只有提案权，发布权在辣条妹手里。
//   - hAdminUploadFile：非图片素材（视频/音频/文档）透传落盘，不做图片处理。

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"latiaomei/internal/store"
)

// hAdminAiPolish 提示词结构化优化。LLMKey 未配置时返回 501，小程序端有本地模板兜底。
func (s *Server) hAdminAiPolish(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Text string `json:"text"`
		Kind string `json:"kind"` // 目前只有 video；预留扩展
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	text := strings.TrimSpace(b.Text)
	if text == "" {
		s.jsonErr(w, http.StatusBadRequest, "先把想做的内容说一句或打几个字")
		return
	}
	if len([]rune(text)) > 4000 {
		s.jsonErr(w, http.StatusBadRequest, "描述超过 4000 字，先精简一下")
		return
	}
	if s.cfg.LLMKey == "" {
		s.jsonErr(w, http.StatusNotImplemented, "服务端未配置 LATIAOMEI_LLM_API_KEY，AI 优化暂不可用")
		return
	}
	prompt, err := s.llmChat(r.Context(), []map[string]string{
		{"role": "system", "content": polishSystemPrompt},
		{"role": "user", "content": text},
	}, 0.4, 1200)
	if err != nil {
		s.jsonErr(w, http.StatusBadGateway, "AI 优化失败："+err.Error())
		return
	}
	s.jsonOK(w, map[string]any{"prompt": strings.TrimSpace(prompt), "raw": text})
}

const polishSystemPrompt = `你是"辣条妹的御膳房"短视频制片助理。管理员给你的是一段口语化、可能含语音转写误差的任务描述。
你的工作：把它整理成一份结构化的视频制作提示词，交给下游 AI 直接产分镜脚本。

要求：
1. 先纠正明显的语音转写错字（结合杭州美食探店语境，例如"恰饭""落胃""儿化音"）。
2. 按下面模板输出，缺失的信息根据上下文合理补全，补不了的写"由 AI 按内容自行发挥"，不要提问。
3. 语言用中文，条目化、短促、无废话。不要使用破折号连接。

输出模板：
【主题】一句话说明这条视频讲什么
【钩子】前 3 秒怎么留住人（画面+一句话文案）
【素材使用】逐条说明上传素材怎么用（图1做XX场景背景、视频素材插入XX处等；没给素材就给建议）
【分镜要点】4-6 个场景的内容顺序与各自文案方向
【文案口吻】市井、直接、毒舌但公道，杭州话点缀；禁绝对化用语
【时长画幅】默认 10-14 秒、1080x1920 竖屏；描述里另有要求则照办
【行动号召】结尾 CTA（引导关注/主页看全文）
【话题标签】5 个左右，含 #辣条妹的御膳房 #杭州美食
【避坑】描述里提到的禁忌（"别拍后厨""别提价格"等），没有可省略本段`

// llmChat 一次不带联网的对话（管理端 AI 优化等用）。
func (s *Server) llmChat(ctx context.Context, messages any, temperature float64, maxTokens int) (string, error) {
	return s.llmChatOpts(ctx, messages, temperature, maxTokens, false)
}

// buildLLMPayload 组装 /chat/completions 请求体。鉴店时 enableSearch=true，
// 让通义的服务端检索管线替辣条妹「上网盘风评」——这是抖音/小红书/点评
// 这类强反爬平台唯一可持续的盘道方式（自爬要签名+登录态，必死）。
func buildLLMPayload(model string, messages any, temperature float64, maxTokens int, enableSearch bool) []byte {
	payload, _ := json.Marshal(map[string]any{
		"model":       model,
		"messages":    messages,
		"temperature": temperature,
		"max_tokens":  maxTokens,
		// qwen3 系默认开隐式推理，非流式下能把延迟拖到分钟级；关掉后 5s 级回包。
		// 辣条妹的“思考过程”由块协议里的 thinking 字段显式展示，不需要模型内推理。
		"enable_thinking": false,
		// DashScope 兼容模式支持；检索产生的引用由模型消化后写进 verdict。
		"enable_search": enableSearch,
	})
	return payload
}

// llmChatOpts 带联网搜索开关的 LLM 调用（60s 超时，不重试；小程序端有兜底）。
func (s *Server) llmChatOpts(ctx context.Context, messages any, temperature float64, maxTokens int, enableSearch bool) (string, error) {
	payload := buildLLMPayload(s.cfg.LLMModel, messages, temperature, maxTokens, enableSearch)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(s.cfg.LLMBase, "/")+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+s.cfg.LLMKey)
	cli := &http.Client{Timeout: 60 * time.Second}
	res, err := cli.Do(req)
	if err != nil {
		return "", fmt.Errorf("网络：%v", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d %s", res.StatusCode, trimRunes(string(body), 120))
	}
	var j struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &j); err != nil || len(j.Choices) == 0 {
		return "", fmt.Errorf("回包解析失败")
	}
	// 剥掉部分模型爱包的 ``` 围栏。
	out := strings.TrimSpace(j.Choices[0].Message.Content)
	out = strings.TrimPrefix(out, "```")
	out = strings.TrimSuffix(out, "```")
	if i := strings.Index(out, "\n"); strings.HasPrefix(out, "text") && i > 0 {
		out = out[i+1:]
	}
	return strings.TrimSpace(out), nil
}

func trimRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// hAdminVideoMission 视频工坊下单：素材 + 提示词 + 平台 → 入队 video_mission。
func (s *Server) hAdminVideoMission(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Title     string   `json:"title"`
		Prompt    string   `json:"prompt"`
		Images    []string `json:"images"`
		Files     []string `json:"files"`
		Platforms []string `json:"platforms"`
	}
	if err := decode(r, &b); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(b.Prompt) == "" {
		s.jsonErr(w, http.StatusBadRequest, "任务描述不能空")
		return
	}
	okExt := func(p string) bool {
		return strings.HasPrefix(p, "/uploads/") && len(p) < 300 && !strings.Contains(p, "..")
	}
	for _, p := range append(append([]string{}, b.Images...), b.Files...) {
		if !okExt(p) {
			s.jsonErr(w, http.StatusBadRequest, "素材路径不合法："+trimRunes(p, 40))
			return
		}
	}
	plats := make([]string, 0, len(b.Platforms))
	seen := map[string]bool{}
	for _, p := range b.Platforms {
		if !store.ValidSocialPlatform(p) || seen[p] {
			s.jsonErr(w, http.StatusBadRequest, "平台不合法："+p)
			return
		}
		seen[p] = true
		plats = append(plats, p)
	}
	if len(plats) == 0 {
		s.jsonErr(w, http.StatusBadRequest, "至少选一个发布平台")
		return
	}
	actor := actorFrom(r.Context())
	payload := map[string]any{
		"title":     strings.TrimSpace(b.Title),
		"prompt":    strings.TrimSpace(b.Prompt),
		"images":    b.Images,
		"files":     b.Files,
		"platforms": plats,
		"by":        actor.Label(),
	}
	added, err := s.st.EnqueueTask(store.TaskVideoMission, 0, payload, 0)
	if err != nil {
		log500(s, w, err, "视频任务入队")
		return
	}
	s.auditAs(r, "video mission", strings.TrimSpace(b.Title))
	s.jsonOK(w, map[string]any{"added": added, "platforms": plats,
		"hint": "成片与平台稿会进「审文案」等你审核放行；不放行，机器永远不发"})
}

// ---- 非图片素材透传上传 ----

// 允许的扩展名 → MIME。视频/音频/常见文档；不在表内的一律拒。
var mediaMimes = map[string]string{
	".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v",
	".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".aac": "audio/aac", ".amr": "audio/amr",
	".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
}

// hAdminUploadFile 视频/音频/文档原样落 /uploads/media/，记同一套台账。
// 图片继续走 /admin/upload（压缩+清 EXIF），这里不做任何转码。
func (s *Server) hAdminUploadFile(w http.ResponseWriter, r *http.Request) {
	maxBytes := s.cfg.MediaMax
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes+1<<20)
	if err := r.ParseMultipartForm(16 << 20); err != nil {
		s.jsonErr(w, http.StatusBadRequest, fmt.Sprintf("表单解析失败（单文件上限 %dMB）", maxBytes>>20))
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "没收到文件，字段名应为 file")
		return
	}
	defer file.Close()
	ext := strings.ToLower(filepath.Ext(hdr.Filename))
	mime, ok := mediaMimes[ext]
	if !ok {
		s.jsonErr(w, http.StatusBadRequest, "不支持的文件类型 "+ext+"（可用：mp4/mov/m4v、mp3/m4a/wav/aac/amr、pdf/txt/md/csv）")
		return
	}
	if hdr.Size > maxBytes {
		s.jsonErr(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("文件 %.1fMB 超过上限 %dMB", float64(hdr.Size)/(1<<20), maxBytes>>20))
		return
	}
	head := make([]byte, 32)
	n, _ := io.ReadFull(file, head)
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		log500(s, w, err, "回绕文件")
		return
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "读取文件失败")
		return
	}
	sum := sha256.Sum256(append(data, hdr.Filename...))
	now := s.st.Now()
	sub := now.Format("2006/01")
	dir := filepath.Join(s.cfg.UploadDir(), "media", sub)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log500(s, w, err, "建上传目录")
		return
	}
	base := fmt.Sprintf("%x", sum[:8])
	rel := "/uploads/media/" + sub + "/" + base + ext
	if err := os.WriteFile(filepath.Join(dir, base+ext), data, 0o644); err != nil {
		log500(s, w, err, "写文件")
		return
	}
	u := &store.Upload{
		Path: rel, Mime: mime, Bytes: int64(len(data)), SHA: fmt.Sprintf("%x", sum),
	}
	if err := s.st.SaveUpload(u); err != nil {
		log500(s, w, err, "写台账")
		return
	}
	s.uploadCache.invalidate()
	s.jsonOK(w, map[string]any{
		"path": rel, "mime": mime, "bytes": u.Bytes,
		"name": filepath.Base(hdr.Filename), "head": hex.EncodeToString(head[:n]),
	})
}
