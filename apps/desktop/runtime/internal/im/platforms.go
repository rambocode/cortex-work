package im

import (
	"fmt"
	"sort"
	"strings"
)

type PlatformSpec struct {
	Platform         Platform `json:"platform"`
	Modes            []Mode   `json:"modes"`
	DefaultMode      Mode     `json:"default_mode"`
	CredentialFields []string `json:"credential_fields"`
}

var platformSpecs = map[Platform]PlatformSpec{
	PlatformWeCom:      {PlatformWeCom, []Mode{ModeWebSocket, ModeWebhook}, ModeWebSocket, []string{"bot_id", "bot_secret"}},
	PlatformFeishu:     {PlatformFeishu, []Mode{ModeWebSocket, ModeWebhook}, ModeWebSocket, []string{"app_id", "app_secret"}},
	PlatformLark:       {PlatformLark, []Mode{ModeWebSocket, ModeWebhook}, ModeWebSocket, []string{"app_id", "app_secret"}},
	PlatformSlack:      {PlatformSlack, []Mode{ModeWebSocket, ModeWebhook}, ModeWebSocket, []string{"app_token", "bot_token"}},
	PlatformTelegram:   {PlatformTelegram, []Mode{ModeLongPoll, ModeWebhook}, ModeLongPoll, []string{"bot_token"}},
	PlatformDingTalk:   {PlatformDingTalk, []Mode{ModeWebSocket, ModeWebhook}, ModeWebSocket, []string{"client_id", "client_secret"}},
	PlatformMattermost: {PlatformMattermost, []Mode{ModeWebhook}, ModeWebhook, []string{"site_url", "bot_token", "outgoing_token"}},
	PlatformWeChat:     {PlatformWeChat, []Mode{ModeLongPoll}, ModeLongPoll, []string{"bot_token", "ilink_bot_id"}},
	PlatformQQBot:      {PlatformQQBot, []Mode{ModeWebSocket}, ModeWebSocket, []string{"app_id", "client_secret"}},
	PlatformYunzhijia:  {PlatformYunzhijia, []Mode{ModeWebhook, ModeWebSocket}, ModeWebhook, []string{"send_msg_url"}},
}

func PlatformSpecs() []PlatformSpec {
	result := make([]PlatformSpec, 0, len(platformSpecs))
	for _, spec := range platformSpecs {
		result = append(result, spec)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Platform < result[j].Platform })
	return result
}

func ValidateChannel(channel Channel) error {
	if strings.TrimSpace(channel.ID) == "" {
		return fmt.Errorf("channel id is required")
	}
	if strings.TrimSpace(channel.Name) == "" {
		return fmt.Errorf("channel name is required")
	}
	spec, ok := platformSpecs[channel.Platform]
	if !ok {
		return fmt.Errorf("unsupported platform %q", channel.Platform)
	}
	validMode := false
	for _, mode := range spec.Modes {
		if channel.Mode == mode {
			validMode = true
			break
		}
	}
	if !validMode {
		return fmt.Errorf("platform %s does not support mode %s", channel.Platform, channel.Mode)
	}
	if channel.OutputMode != OutputStream && channel.OutputMode != OutputFull {
		return fmt.Errorf("invalid output mode")
	}
	if channel.SessionMode != "user" && channel.SessionMode != "thread" {
		return fmt.Errorf("invalid session mode")
	}
	if channel.Target.Kind != "personal" && channel.Target.Kind != "team" {
		return fmt.Errorf("invalid workspace target kind")
	}
	for _, field := range requiredCredentials(channel.Platform, channel.Mode) {
		if strings.TrimSpace(channel.Credentials[field]) == "" {
			return fmt.Errorf("credential %s is required", field)
		}
	}
	return nil
}

func requiredCredentials(platform Platform, mode Mode) []string {
	switch platform {
	case PlatformWeCom:
		if mode == ModeWebhook {
			return []string{"corp_id", "agent_secret", "token", "encoding_aes_key", "corp_agent_id"}
		}
	case PlatformFeishu, PlatformLark:
		if mode == ModeWebhook {
			return []string{"app_id", "app_secret", "verification_token"}
		}
	case PlatformSlack:
		if mode == ModeWebhook {
			return []string{"bot_token", "signing_secret"}
		}
	case PlatformTelegram:
		return []string{"bot_token"}
	case PlatformDingTalk:
		return []string{"client_id", "client_secret"}
	}
	return platformSpecs[platform].CredentialFields
}
