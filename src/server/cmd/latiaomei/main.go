// latiaomei —— 辣条妹的御膳房 后端。
//
// 子命令：
//
//	serve            启动 HTTP 服务（默认）
//	migrate          只跑建表，不起服务
//	passwd -u USER   重置某个后台账号的密码
//	seed             灌一次演示数据（首次部署用，已有数据则拒绝）
//	seed-recipes     只补御膳房菜谱（按 slug 幂等，给已上线的老库用）
//	version          打印版本
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "time/tzdata" // 内嵌时区库：容器里没有 /usr/share/zoneinfo 也能按 Asia/Shanghai 切日

	"latiaomei/internal/config"
	"latiaomei/internal/httpapi"
	"latiaomei/internal/stats"
	"latiaomei/internal/store"
)

var version = "dev" // 由 build.sh 通过 -ldflags -X 注入

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[latiaomei] ")

	args := os.Args[1:]
	cmd := "serve"
	if len(args) > 0 && args[0][0] != '-' {
		cmd, args = args[0], args[1:]
	}

	// version 不碰配置和数据库：部署脚本里经常在服务还没建库时就要打版本号。
	if cmd == "version" {
		fmt.Println("latiaomei", version)
		return
	}

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("配置错误: %v", err)
	}
	st, err := store.Open(cfg.DBPath, cfg.Loc)
	if err != nil {
		log.Fatalf("打开数据库失败: %v", err)
	}
	defer st.Close()

	switch cmd {
	case "serve":
		if err := runServe(cfg, st); err != nil {
			log.Fatal(err)
		}
	case "migrate":
		fmt.Println("schema 已就绪:", cfg.DBPath)
	case "passwd":
		fs := flag.NewFlagSet("passwd", flag.ExitOnError)
		user := fs.String("u", cfg.AdminUser, "后台账号")
		pass := fs.String("p", "", "新密码（留空则读 LATIAOMEI_ADMIN_PASS）")
		_ = fs.Parse(args)
		newPass := *pass
		if newPass == "" {
			newPass = os.Getenv("LATIAOMEI_ADMIN_PASS")
		}
		if len(newPass) < 8 {
			log.Fatal("密码至少 8 位；用 -p 或 LATIAOMEI_ADMIN_PASS 提供")
		}
		if err := st.SetPassword(*user, newPass); err != nil {
			log.Fatalf("改密失败: %v", err)
		}
		fmt.Printf("账号 %s 密码已更新\n", *user)
	case "seed":
		if err := runSeed(st); err != nil {
			log.Fatal(err)
		}
	case "seed-recipes":
		n, err := runSeedRecipes(st)
		if err != nil {
			log.Fatalf("补菜谱失败: %v", err)
		}
		fmt.Printf("御膳房菜谱补齐：新增 %d 道（按 slug 查重，跑几次都一样）\n", n)
	case "version":
		fmt.Println("latiaomei", version)
	default:
		fmt.Fprintf(os.Stderr, "未知子命令 %q（可用：serve migrate passwd seed seed-recipes version）\n", cmd)
		os.Exit(2)
	}
}

func runServe(cfg *config.Config, st *store.Store) error {
	// 首启建号：密码只从环境读，不落仓库。
	if cfg.AdminPass != "" {
		created, err := st.EnsureAdmin(cfg.AdminUser, cfg.AdminPass)
		if err != nil {
			return fmt.Errorf("建后台账号: %w", err)
		}
		if created {
			log.Printf("已创建后台账号 %s", cfg.AdminUser)
		}
	} else if cnt, _ := st.AdminCount(); cnt == 0 {
		log.Printf("警告：还没有后台账号。设 LATIAOMEI_ADMIN_PASS 后重启，或用 passwd 子命令建号")
	}

	col := stats.New(st, stats.Options{
		Location:    cfg.Loc,
		Salt:        cfg.Secret,
		FlushEvery:  time.Duration(cfg.FlushSecs) * time.Second,
		Enabled:     func() bool { return st.Setting("track_enabled") != "0" },
		PruneConfig: defaultPrune(),
		PruneEvery:  24 * time.Hour,
	})
	col.Run()

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           httpapi.New(cfg, st, col).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       cfg.ReadTO,
		WriteTimeout:      cfg.WriteTO,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    1 << 16,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Printf("监听 %s，数据目录 %s，域名 %s", cfg.Addr, cfg.DataDir, cfg.Domain)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-errCh:
		col.Close()
		return fmt.Errorf("服务异常退出: %w", err)
	case sig := <-stop:
		log.Printf("收到 %s，开始优雅退出", sig)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("等待连接排空超时: %v", err)
	}
	col.Close() // 会把最后一段统计增量写库
	log.Printf("已退出")
	return nil
}

func defaultPrune() store.PruneConfig {
	return store.PruneConfig{
		PathDays: 400, HourDays: 45, RefDays: 200, TopDays: 200,
		PathTopN: 100, RefTopN: 50, TopTopN: 50,
		SessionTTL: 14 * 24 * time.Hour, VacuumPages: 20000,
	}
}
