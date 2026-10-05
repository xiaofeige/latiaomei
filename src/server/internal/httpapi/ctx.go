package httpapi

import (
	"context"
	"net/http"
	"time"
)

type ctxKey int

const (
	keyActor ctxKey = iota
	keySessionExp
	keyBearer
)

// Actor 是"当前是谁在调这个接口"的统一表达。
// 后台有两类入口：网页端用账号密码（Kind=web），小程序端用微信身份（Kind=wx）。
// 两者共用同一套 /api/admin/* 处理逻辑，所以在这里抹平差异。
type Actor struct {
	Kind   string // "web" | "wx"
	Name   string // 网页用户名，或微信 openid
	Role   string // wx: owner/admin/pending/banned；web 固定 admin
	OpenID string // 仅 wx
}

// IsWx 报告是否微信身份。
func (a *Actor) IsWx() bool { return a != nil && a.Kind == "wx" }

// CanWrite 决定能不能执行写操作。
// 网页端密码登录本身就是站长，一律可写；微信端 pending 只读。
func (a *Actor) CanWrite() bool {
	if a == nil {
		return false
	}
	if a.Kind != "wx" {
		return true
	}
	return a.Role == "owner" || a.Role == "admin"
}

// Label 给审计表用的人名。
func (a *Actor) Label() string {
	if a == nil {
		return "anonymous"
	}
	return a.Name
}

// withActor 把操作者、会话过期时间、是否 Bearer 通道写进 context。
func withActor(ctx context.Context, a *Actor, exp time.Time, bearer bool) context.Context {
	ctx = context.WithValue(ctx, keyActor, a)
	ctx = context.WithValue(ctx, keySessionExp, exp)
	return context.WithValue(ctx, keyBearer, bearer)
}

// actorFrom 取当前操作者；未登录返回 nil。
func actorFrom(ctx context.Context) *Actor {
	a, _ := ctx.Value(keyActor).(*Actor)
	return a
}

// bearerFrom 报告当前请求是否走 Bearer 通道。
func bearerFrom(ctx context.Context) bool {
	b, _ := ctx.Value(keyBearer).(bool)
	return b
}

// isSafeMethod 只读请求，pending 角色也允许。
func isSafeMethod(m string) bool {
	switch m {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	return false
}
