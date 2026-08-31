package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/cortex-ai/cortex-runtime/internal/im"
	"github.com/cortex-ai/cortex-runtime/internal/im/dingtalk"
	"github.com/cortex-ai/cortex-runtime/internal/im/feishu"
	"github.com/cortex-ai/cortex-runtime/internal/im/mattermost"
	"github.com/cortex-ai/cortex-runtime/internal/im/qqbot"
	"github.com/cortex-ai/cortex-runtime/internal/im/slack"
	"github.com/cortex-ai/cortex-runtime/internal/im/telegram"
	"github.com/cortex-ai/cortex-runtime/internal/im/wechat"
	"github.com/cortex-ai/cortex-runtime/internal/im/wecom"
	"github.com/cortex-ai/cortex-runtime/internal/im/yunzhijia"
)

const runtimeVersion = "0.1.0"

type readyMessage struct {
	Type    string `json:"type"`
	Version string `json:"version"`
	Address string `json:"address"`
	Token   string `json:"token"`
}

func main() {
	logger := log.New(os.Stderr, "[cortex-runtime] ", log.LstdFlags|log.LUTC)
	token, err := randomToken()
	if err != nil {
		logger.Fatalf("generate control token: %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		logger.Fatalf("listen: %v", err)
	}

	controlMux := http.NewServeMux()
	rootMux := http.NewServeMux()
	rootMux.Handle("/v1/", requireToken(token, controlMux))
	server := &http.Server{Handler: rootMux, ReadHeaderTimeout: 5 * time.Second}
	manager := im.NewManager(map[im.Platform]im.AdapterFactory{
		im.PlatformWeCom: wecom.NewFactory(), im.PlatformFeishu: feishu.NewFactory(feishu.RegionFeishu),
		im.PlatformLark: feishu.NewFactory(feishu.RegionLark), im.PlatformSlack: slack.NewFactory(),
		im.PlatformTelegram: telegram.NewFactory(), im.PlatformDingTalk: dingtalk.NewFactory(),
		im.PlatformMattermost: mattermost.NewFactory(), im.PlatformWeChat: wechat.NewFactory(),
		im.PlatformQQBot: qqbot.NewFactory(), im.PlatformYunzhijia: yunzhijia.NewFactory(),
	})
	wechatQR := wechat.NewQRCodeService()
	defer manager.Close()
	// 平台回调不使用控制 token，而由各 adapter 按平台协议验签。监听仍只在 loopback；
	// 需要 Webhook 的用户通过设置页配置自己的反向代理/隧道。
	rootMux.HandleFunc("/im/callback/", func(w http.ResponseWriter, r *http.Request) {
		manager.HandleWebhook(w, r, im.CallbackChannelID(r.URL.Path))
	})
	controlMux.HandleFunc("GET /v1/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": runtimeVersion})
	})
	controlMux.HandleFunc("GET /v1/im/platforms", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"data": im.PlatformSpecs()})
	})
	controlMux.HandleFunc("GET /v1/im/channels", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"data": manager.List()})
	})
	controlMux.HandleFunc("GET /v1/im/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"data": manager.Statuses()})
	})
	controlMux.HandleFunc("POST /v1/im/wechat/qrcode", func(w http.ResponseWriter, r *http.Request) {
		result, err := wechatQR.GetLoginQRCode(r.Context())
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	})
	controlMux.HandleFunc("GET /v1/im/wechat/qrcode/status", func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("qrcode")
		if code == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "qrcode is required"})
			return
		}
		result, err := wechatQR.PollQRCodeStatus(r.Context(), code)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	})
	controlMux.HandleFunc("GET /v1/im/events/next", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
		defer cancel()
		if event, ok := manager.Next(ctx); ok {
			writeJSON(w, http.StatusOK, event)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	controlMux.HandleFunc("POST /v1/im/replies", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			DeliveryID string `json:"delivery_id"`
			Content    string `json:"content"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input); err != nil || input.DeliveryID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid reply"})
			return
		}
		if err := manager.Reply(r.Context(), input.DeliveryID, input.Content); err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
	})
	controlMux.HandleFunc("PUT /v1/im/channels", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Channels []im.Channel `json:"channels"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid channel configuration"})
			return
		}
		if err := manager.Replace(input.Channels); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": manager.List()})
	})
	shutdown := make(chan struct{}, 1)
	controlMux.HandleFunc("POST /v1/shutdown", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "shutting_down"})
		select {
		case shutdown <- struct{}{}:
		default:
		}
	})

	ready := readyMessage{Type: "ready", Version: runtimeVersion, Address: "http://" + listener.Addr().String(), Token: token}
	if err := json.NewEncoder(os.Stdout).Encode(ready); err != nil {
		logger.Fatalf("write ready frame: %v", err)
	}

	errCh := make(chan error, 1)
	go func() { errCh <- server.Serve(listener) }()
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-shutdown:
	case <-sigCh:
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Printf("serve: %v", err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
}

func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func requireToken(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
}
