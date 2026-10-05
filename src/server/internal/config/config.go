// Package config 读取运行期配置。全部来自环境变量，便于 systemd
// EnvironmentFile 注入；不引入配置文件解析器，省一个依赖。
package config

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config 是服务的全部可调项。
type Config struct {
	Addr         string // 监听地址，nginx 反代到它
	BaseDir      string // 部署根目录
	DataDir      string // 数据目录（sqlite + uploads）
	WebDir       string // 前端静态目录
	DBPath       string // sqlite 文件路径
	Domain       string // 对外域名，用于绝对 URL / Cookie
	Location     string // 时区名，统计按这个时区切日
	Loc          *time.Location
	AdminUser    string // 首次启动时创建的后台账号
	AdminPass    string // 首次启动时创建的后台密码
	Secret       string // 会话签名密钥
	CookieSecure bool   // 会话 Cookie 是否只走 HTTPS；本地 http 调试时用 LATIAOMEI_COOKIE_SECURE=0 关掉
	WXAppID      string // 微信小程序 AppID（可公开）
	WXAppSecret  string // 微信小程序 AppSecret（机密，只存服务端）
	WXOpenAdmins bool   // 为 true 时任何微信身份登录即可写；默认 false，新人只读待审
	WXAPIBase    string // jscode2session 端点，测试时可指向本地桩服务

	// ---- 生态端（v6）----
	// 用户端微信小程序（内容沉淀 + 订阅消息推送）。与后台小程序是不同 appid。
	MPAppID  string // LATIAOMEI_MP_APPID
	MPSecret string // LATIAOMEI_MP_SECRET
	// 抖音小程序（tt.login 换 openid）
	DYAppID   string // LATIAOMEI_DY_APPID
	DYSecret  string // LATIAOMEI_DY_SECRET
	DYAPIBase string // LATIAOMEI_DY_API_BASE，测试可指向桩
	// 流水线 worker（tools/pipeline）访问 /api/pipeline/* 的静态 token；空=流水线接口关闭
	PipelineToken string // LATIAOMEI_PIPELINE_TOKEN
	UploadMax     int64  // 单图上传上限（字节）
	MediaMax      int64  // 非图片素材（视频/音频/文档）上传上限（字节）LATIAOMEI_MEDIA_MAX_MB
	LLMBase       string // LATIAOMEI_LLM_API_BASE，OpenAI 兼容端点；管理小程序「AI 优化提示词」直连用
	LLMKey        string // LATIAOMEI_LLM_API_KEY，与 worker 同一份密钥；空则该功能关闭
	LLMModel      string // LATIAOMEI_LLM_MODEL
	LLMSearch     bool   // LATIAOMEI_LLM_SEARCH，鉴店时让模型联网检索四平台风评；默认开
	// 推店/规划/附近类对话是否也开联网检索（捞小红书/点评/美团/抖音/高德扫街榜的实时风评 enrich 文案）。
	// 卡片仍只锚库存店，联网只补风评，不放开编店。默认开。
	RecSearch bool // LATIAOMEI_REC_SEARCH
	// 带定位的推店时，是否实时查高德「附近餐饮」当周边实况参考（评分/人均/扫街榜），按网格缓存省配额。默认开。
	AmapNearby bool // LATIAOMEI_AMAP_NEARBY
	// 鉴店 skill：高德开放平台 Web 服务 key（扫街榜/评分/人均）。空=该证据源关闭。
	AmapKey  string // LATIAOMEI_AMAP_KEY
	AmapBase string // LATIAOMEI_AMAP_BASE，测试可指向桩
	AmapCity string // LATIAOMEI_AMAP_CITY，默认杭州
	// agent 词表 / 话术外置文件（本地硬拦规则、门禁角色设定、回复消毒禁词）。
	// 这些文本含大量「反面用例」，落在源码里会让代码侧内容扫描误报，故外置。
	// 文件缺失只让 agent 的本地规则与小模型门禁降级，不影响服务启动。
	WordsFile string        // LATIAOMEI_WORDS_FILE，默认 $HOME/workplace/safety-words.txt
	FlushSecs int           // 统计落盘间隔
	ReadTO    time.Duration // http 读超时
	WriteTO   time.Duration
}

// Load 组装配置。required 的只有 DataDir，其余都有适合本机的默认值。
func Load() (*Config, error) {
	c := &Config{
		Addr: env("LATIAOMEI_ADDR", "127.0.0.1:18821"),
		// 默认值对齐本机部署目录，保证不带 env 裸跑 CLI（passwd/migrate 等）也能落对地方；
		// systemd 侧由 EnvironmentFile 显式注入，不依赖这里。
		BaseDir:      env("LATIAOMEI_BASE", "/data/www/latiaomei"),
		DataDir:      env("LATIAOMEI_DATA", "/data/www/latiaomei/data"),
		WebDir:       env("LATIAOMEI_WEB", "/data/www/latiaomei/web"),
		Domain:       env("LATIAOMEI_DOMAIN", "latiaomei.infinityfly.xin"),
		Location:     env("LATIAOMEI_TZ", "Asia/Shanghai"),
		AdminUser:    env("LATIAOMEI_ADMIN_USER", "latiaomei"),
		AdminPass:    os.Getenv("LATIAOMEI_ADMIN_PASS"),
		Secret:       os.Getenv("LATIAOMEI_SECRET"),
		CookieSecure: envBool("LATIAOMEI_COOKIE_SECURE", true),
		// 微信登录：AppID/Secret 在公众平台→开发设置里拿。Secret 缺失时微信登录直接禁用，
		// 网页后台的账号密码登录不受影响，避免配错就把整个后台锁死。
		WXAppID:       os.Getenv("LATIAOMEI_WX_APPID"),
		WXAppSecret:   os.Getenv("LATIAOMEI_WX_SECRET"),
		WXOpenAdmins:  envBool("LATIAOMEI_WX_OPEN_ADMINS", false),
		WXAPIBase:     env("LATIAOMEI_WX_API_BASE", "https://api.weixin.qq.com"),
		MPAppID:       os.Getenv("LATIAOMEI_MP_APPID"),
		MPSecret:      os.Getenv("LATIAOMEI_MP_SECRET"),
		DYAppID:       os.Getenv("LATIAOMEI_DY_APPID"),
		DYSecret:      os.Getenv("LATIAOMEI_DY_SECRET"),
		DYAPIBase:     env("LATIAOMEI_DY_API_BASE", "https://developer.toutiao.com"),
		PipelineToken: os.Getenv("LATIAOMEI_PIPELINE_TOKEN"),
		UploadMax:     int64(envInt("LATIAOMEI_UPLOAD_MAX_MB", 6)) << 20,
		MediaMax:      int64(envInt("LATIAOMEI_MEDIA_MAX_MB", 120)) << 20,
		LLMBase:       env("LATIAOMEI_LLM_API_BASE", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
		LLMKey:        os.Getenv("LATIAOMEI_LLM_API_KEY"),
		LLMModel:      env("LATIAOMEI_LLM_MODEL", "qwen3.8-flash"),
		LLMSearch:     envBool("LATIAOMEI_LLM_SEARCH", true),
		RecSearch:     envBool("LATIAOMEI_REC_SEARCH", true),
		AmapNearby:    envBool("LATIAOMEI_AMAP_NEARBY", true),
		AmapKey:       os.Getenv("LATIAOMEI_AMAP_KEY"),
		AmapBase:      env("LATIAOMEI_AMAP_BASE", "https://restapi.amap.com"),
		AmapCity:      env("LATIAOMEI_AMAP_CITY", "杭州"),
		WordsFile:     env("LATIAOMEI_WORDS_FILE", defaultWordsFile()),
		FlushSecs:     envInt("LATIAOMEI_FLUSH_SECS", 30),
		ReadTO:        time.Duration(envInt("LATIAOMEI_READ_TIMEOUT", 15)) * time.Second,
		WriteTO:       time.Duration(envInt("LATIAOMEI_WRITE_TIMEOUT", 60)) * time.Second,
	}
	if c.DBPath == "" {
		c.DBPath = filepath.Join(c.DataDir, "latiaomei.db")
	}
	if c.DBPath == "" || c.DataDir == "" {
		return nil, fmt.Errorf("config: LATIAOMEI_DATA/LATIAOMEI_DB 不能为空")
	}
	loc, err := time.LoadLocation(c.Location)
	if err != nil {
		return nil, fmt.Errorf("config: 时区 %q 不可用: %w", c.Location, err)
	}
	c.Loc = loc
	// SECRET 缺失时按机器生成一份并落盘，避免每次重启把会话全刷掉。
	if c.Secret == "" {
		sec, err := persistSecret(filepath.Join(c.DataDir, ".secret"))
		if err != nil {
			return nil, err
		}
		c.Secret = sec
	}
	if err := os.MkdirAll(c.DataDir, 0o750); err != nil {
		return nil, fmt.Errorf("config: 建数据目录: %w", err)
	}
	if err := os.MkdirAll(c.UploadDir(), 0o755); err != nil {
		return nil, fmt.Errorf("config: 建上传目录: %w", err)
	}
	return c, nil
}

// UploadDir 是上传图片的落盘目录。
func (c *Config) UploadDir() string { return filepath.Join(c.DataDir, "uploads") }

// Now 返回时区化后的当前时间。
func (c *Config) Now() time.Time { return time.Now().In(c.Loc) }

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// defaultWordsFile 是 agent 词表文本的本机默认位置：$HOME/workplace/safety-words.txt。
// 取不到 HOME（裸容器、无 passwd 的账号）就给个相对路径 —— 文件读不到只会让
// agent 的本地硬拦与小模型门禁降级，不该拖住启动。
func defaultWordsFile() string {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, "workplace", "safety-words.txt")
	}
	return filepath.Join("workplace", "safety-words.txt")
}

func envBool(k string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(k))) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

func persistSecret(path string) (string, error) {
	if b, err := os.ReadFile(path); err == nil && len(b) >= 32 {
		return string(b), nil
	}
	buf := make([]byte, 48)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("config: 取随机数失败: %w", err)
	}
	val := fmt.Sprintf("%x", buf)
	if err := os.WriteFile(path, []byte(val), 0o600); err != nil {
		return "", fmt.Errorf("config: 写 %s: %w", path, err)
	}
	return val, nil
}
