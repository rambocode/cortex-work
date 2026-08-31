package im

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"time"

	"github.com/cortex-ai/cortex-runtime/internal/logger"
)

func ParseCredentials(data []byte) (map[string]any, error) {
	var out map[string]any
	if len(data) == 0 {
		return map[string]any{}, nil
	}
	err := json.Unmarshal(data, &out)
	return out, err
}
func GetString(values map[string]any, key string) string {
	value, _ := values[key].(string)
	return value
}
func GetBool(values map[string]any, key string) bool {
	switch value := values[key].(type) {
	case bool:
		return value
	case string:
		return value == "true" || value == "1"
	case float64:
		return value != 0
	}
	return false
}
func ResolveMode(channel *IMChannel, fallback string) string {
	if channel.Mode == "" {
		return fallback
	}
	return channel.Mode
}

type StreamDisplayPhase int

const (
	StreamDisplayIntermediate StreamDisplayPhase = iota
	StreamDisplayFinal
)

var thinkBlock = regexp.MustCompile(`(?s)<think>.*?</think>|<think>.*$`)

func FormatIMDisplayContent(raw string, phase StreamDisplayPhase) string {
	if phase == StreamDisplayFinal {
		return strings.TrimSpace(thinkBlock.ReplaceAllString(raw, ""))
	}
	return raw
}

type SupervisorConfig struct {
	Name                   string
	MaxConnAge, RetryDelay time.Duration
	Connect                func(context.Context) (func(), error)
}

func RunSupervised(ctx context.Context, cfg SupervisorConfig) {
	maxAge := cfg.MaxConnAge
	if maxAge <= 0 {
		maxAge = 6 * time.Hour
	}
	retry := cfg.RetryDelay
	if retry <= 0 {
		retry = 5 * time.Second
	}
	for ctx.Err() == nil {
		stop, err := cfg.Connect(ctx)
		if err != nil {
			logger.Warnf(ctx, "[IM] %s connect failed: %v", cfg.Name, err)
			select {
			case <-time.After(retry):
				continue
			case <-ctx.Done():
				return
			}
		}
		select {
		case <-time.After(maxAge):
			if stop != nil {
				stop()
			}
		case <-ctx.Done():
			if stop != nil {
				stop()
			}
			return
		}
	}
}
