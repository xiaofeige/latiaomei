// Package stats 做访问统计的采集与落盘。
//
// 设计取舍（这台机器只有 3.5G 内存，还要跟别的站点共用磁盘）：
//   - 不存任何原始访问流水。内存里攒增量，定时以聚合方式 UPSERT 进统计表。
//   - UV 不记访客身份，只维护每天一个 1KB 的 HyperLogLog，可跨重启累计。
//   - 路径/来源/内容榜的 key 数量在内存里就封上限，超出部分并进 "(other)"，
//     保证库里每天行数是常数级；配合 Prune 的保留窗口，磁盘占用趋于恒定。
package stats

import (
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"latiaomei/internal/store"
)

const (
	maxPaths   = 512
	maxRefs    = 256
	maxTops    = 512
	maxPathLen = 96
)

// Kind 区分被统计的请求类型。
type Kind int

const (
	KindDoc    Kind = iota // HTML 文档请求（首屏/直链）计入 PV
	KindTrack              // 前端上报的路由切换计入 PV
	KindAPI                // 数据接口只记 api 数
	KindAsset              // 静态资源忽略
	KindAdmin              // 后台请求忽略，不混进对外流量
	KindHealth             // 健康检查忽略
)

// Hit 是一次被统计的请求。由 http 中间件填好，采集器不认识 http.Request。
type Hit struct {
	When    time.Time
	IP      string
	UA      string
	Path    string
	Ref     string
	Status  int
	Kind    Kind
	TopKind string // review / shop，非空表示这是内容详情页访问
	TopKey  string
	IsBot   bool
}

// Options 是采集器构造参数。
type Options struct {
	Location    *time.Location
	Salt        string // UV 哈希盐
	FlushEvery  time.Duration
	Enabled     func() bool // 每次 Observe 前问一次，便于后台一键关统计
	PruneConfig store.PruneConfig
	PruneEvery  time.Duration
}

// Collector 是并发安全的访问计数器。
type Collector struct {
	st   *store.Store
	opt  Options
	mu   sync.Mutex
	cur  *dayBucket
	stop chan struct{}
	done chan struct{}

	self      string
	tracked   int64
	flushed   int64
	startedAt time.Time
}

type dayBucket struct {
	date     string
	pv       int64
	bot      int64
	api      int64
	err      int64
	hours    map[int]int64
	hourHLL  map[int]*HLL
	paths    map[string]int64
	refs     map[string]int64
	devices  map[string]int64
	tops     map[[2]string]int64
	hll      *HLL
	overflow int64
}

func newDayBucket(date string) *dayBucket {
	return &dayBucket{
		date:    date,
		hours:   map[int]int64{},
		hourHLL: map[int]*HLL{},
		paths:   map[string]int64{},
		refs:    map[string]int64{},
		devices: map[string]int64{},
		tops:    map[[2]string]int64{},
		hll:     &HLL{},
	}
}

// New 构造采集器，并把今天已有的 HLL 状态读回来，重启不丢当日 UV 口径。
func New(st *store.Store, opt Options) *Collector {
	if opt.Location == nil {
		opt.Location = time.Local
	}
	if opt.FlushEvery <= 0 {
		opt.FlushEvery = 30 * time.Second
	}
	if opt.PruneEvery <= 0 {
		opt.PruneEvery = 24 * time.Hour
	}
	if opt.Enabled == nil {
		opt.Enabled = func() bool { return true }
	}
	c := &Collector{st: st, opt: opt, stop: make(chan struct{}), done: make(chan struct{}), startedAt: time.Now()}
	c.cur = newDayBucket(c.today(time.Now()))
	c.restoreHLL(c.cur)
	return c
}

// Run 启动定时落盘与定时清理，直到 Close。
func (c *Collector) Run() {
	go func() {
		defer close(c.done)
		flushTick := time.NewTicker(c.opt.FlushEvery)
		defer flushTick.Stop()
		pruneTick := time.NewTicker(c.opt.PruneEvery)
		defer pruneTick.Stop()
		for {
			select {
			case <-flushTick.C:
				c.Flush()
			case <-pruneTick.C:
				c.Prune()
			case <-c.stop:
				c.Flush()
				return
			}
		}
	}()
}

// Close 停掉后台协程并把最后一段增量落盘。
func (c *Collector) Close() {
	close(c.stop)
	<-c.done
}

// Observe 记录一次请求。纯内存累加，慢磁盘不会拖住请求。
func (c *Collector) Observe(h Hit) {
	if h.Kind == KindAsset || h.Kind == KindAdmin || h.Kind == KindHealth {
		return
	}
	if !c.opt.Enabled() {
		return
	}
	date := c.today(h.When)
	// selfHost() 自己会拿 c.mu，必须在进锁之前取好：sync.Mutex 不可重入，
	// 在持锁时调用它会把整条请求路径连同采集器一起锁死。
	self := c.selfHost()

	c.mu.Lock()
	if c.cur.date != date {
		// 跨日：先把旧的一天写库，再开新桶。
		pending := c.cur
		c.cur = newDayBucket(date)
		c.restoreHLL(c.cur)
		c.mu.Unlock()
		c.write(pending)
		c.mu.Lock()
	}
	b := c.cur

	if h.IsBot {
		b.bot++
		c.mu.Unlock()
		return
	}
	if h.Kind == KindAPI {
		b.api++
		if h.Status >= 500 {
			b.err++
		}
		c.mu.Unlock()
		return
	}

	now := h.When.In(c.opt.Location)
	hour := now.Hour()
	b.pv++
	b.hours[hour]++
	if h.Status >= 500 {
		b.err++
	}
	addBounded(b.paths, normalizePath(h.Path), maxPaths, &b.overflow)
	addBounded(b.refs, normalizeRef(h.Ref, self), maxRefs, &b.overflow)
	b.devices[deviceOf(h.UA)]++

	visitor := ipKey(h.IP) + "|" + uaClass(h.UA) + "|" + date
	k := hashKey(c.opt.Salt, visitor)
	b.hll.Add(k)
	hh, ok := b.hourHLL[hour]
	if !ok {
		hh = &HLL{}
		b.hourHLL[hour] = hh
	}
	hh.Add(k)

	if h.TopKind != "" && h.TopKey != "" {
		key := [2]string{h.TopKind, sanitizeKey(h.TopKey)}
		if _, seen := b.tops[key]; seen || len(b.tops) < maxTops {
			b.tops[key]++
		}
	}
	c.tracked++
	c.mu.Unlock()
}

// Flush 把当前增量写库。
func (c *Collector) Flush() {
	c.mu.Lock()
	b := c.cur
	c.mu.Unlock()
	c.write(b)
}

// write 把桶里的数据落成 Delta。计数与 map 会被清空（累计量已经交给这一批），
// 但 HLL 保留，它是全天状态。
func (c *Collector) write(b *dayBucket) {
	if b == nil {
		return
	}
	c.mu.Lock()
	d := &store.Delta{
		Date:    b.date,
		PV:      b.pv,
		Bot:     b.bot,
		API:     b.api,
		Err:     b.err,
		Hours:   make(map[int]int64, len(b.hours)),
		UVHour:  make(map[int]int64, len(b.hourHLL)),
		Paths:   make(map[string]int64, len(b.paths)),
		Refs:    make(map[string]int64, len(b.refs)),
		Devices: make(map[string]int64, len(b.devices)),
		Tops:    make(map[[2]string]int64, len(b.tops)),
		HLL:     b.hll.Bytes(),
		UV:      b.hll.Cardinality(),
	}
	for h, n := range b.hours {
		d.Hours[h] = n
	}
	for h, hh := range b.hourHLL {
		d.UVHour[h] = hh.Cardinality()
	}
	for k, n := range b.paths {
		d.Paths[k] = n
	}
	for k, n := range b.refs {
		d.Refs[k] = n
	}
	for k, n := range b.devices {
		d.Devices[k] = n
	}
	for k, n := range b.tops {
		d.Tops[k] = n
	}
	empty := d.PV == 0 && d.Bot == 0 && d.API == 0 && d.Err == 0 && len(d.Hours) == 0
	b.pv, b.bot, b.api, b.err = 0, 0, 0, 0
	b.hours = map[int]int64{}
	b.paths = map[string]int64{}
	b.refs = map[string]int64{}
	b.devices = map[string]int64{}
	b.tops = map[[2]string]int64{}
	c.mu.Unlock()

	if empty {
		return
	}
	if err := c.st.ApplyDelta(d); err != nil {
		log.Printf("stats: 落盘失败，本批增量丢弃: %v", err)
		return
	}
	c.flushed++
}

// Prune 执行保留窗口清理，并把空闲页还给文件系统。
func (c *Collector) Prune() {
	rep, err := c.st.Prune(c.opt.PruneConfig)
	if err != nil {
		log.Printf("stats: 清理失败: %v", err)
		return
	}
	_ = c.st.SaveSettings(map[string]string{"last_prune_at": fmt.Sprint(time.Now().Unix())})
	if rep.Total > 0 {
		log.Printf("stats: 清理 %d 行聚合数据，库体积 %.1f MB", rep.Total, float64(rep.DBBytes)/1048576)
	}
}

// Stats 返回采集器自身状态，后台"运行状态"卡片用。
func (c *Collector) Stats() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return map[string]any{
		"date":        c.cur.date,
		"pending_pv":  c.cur.pv,
		"tracked":     c.tracked,
		"flushed":     c.flushed,
		"overflow":    c.cur.overflow,
		"uv_estimate": c.cur.hll.Cardinality(),
		"uptime_secs": int64(time.Since(c.startedAt).Seconds()),
	}
}

func (c *Collector) restoreHLL(b *dayBucket) {
	blob, err := c.st.LoadHLL(b.date)
	if err != nil {
		log.Printf("stats: 读当天 UV 状态失败（不影响计数）: %v", err)
	}
	b.hll.Merge(blob)
}

func (c *Collector) today(t time.Time) string { return t.In(c.opt.Location).Format("2006-01-02") }

func (c *Collector) selfHost() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.self
}

// SetSelfHost 设置本站域名，来源同域时归为 internal。
func (c *Collector) SetSelfHost(host string) {
	c.mu.Lock()
	c.self = strings.ToLower(strings.TrimSpace(host))
	c.mu.Unlock()
}

func addBounded(m map[string]int64, key string, cap int, overflow *int64) {
	if key == "" {
		return
	}
	if n, ok := m[key]; ok {
		m[key] = n + 1
		return
	}
	if len(m) >= cap {
		*overflow++
		m["(other)"]++
		return
	}
	m[key] = 1
}
