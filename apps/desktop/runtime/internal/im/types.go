package im

import "time"

type Platform string

const (
	PlatformWeCom      Platform = "wecom"
	PlatformFeishu     Platform = "feishu"
	PlatformLark       Platform = "lark"
	PlatformSlack      Platform = "slack"
	PlatformTelegram   Platform = "telegram"
	PlatformDingTalk   Platform = "dingtalk"
	PlatformDingtalk            = PlatformDingTalk
	PlatformMattermost Platform = "mattermost"
	PlatformWeChat     Platform = "wechat"
	PlatformQQBot      Platform = "qqbot"
	PlatformYunzhijia  Platform = "yunzhijia"
)

type Mode string

const (
	ModeWebhook   Mode = "webhook"
	ModeWebSocket Mode = "websocket"
	ModeLongPoll  Mode = "longpoll"
)

type OutputMode string

const (
	OutputStream OutputMode = "stream"
	OutputFull   OutputMode = "full"
)

// WorkspaceTarget 只描述消息要进入哪个工作区域；个人与团队执行器由 Desktop 侧选择，
// Runtime 不依赖任何 UI/store 实现。
type WorkspaceTarget struct {
	Kind        string `json:"kind"` // personal | team
	WorkspaceID string `json:"workspace_id,omitempty"`
	AgentID     string `json:"agent_id,omitempty"`
	ProjectID   string `json:"project_id,omitempty"`
}

type ExecutionConfig struct {
	Agent      string `json:"agent,omitempty"`
	ProviderID string `json:"provider_id,omitempty"`
	Model      string `json:"model,omitempty"`
	CWD        string `json:"cwd,omitempty"`
}

type Channel struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Platform    Platform          `json:"platform"`
	Mode        Mode              `json:"mode"`
	OutputMode  OutputMode        `json:"output_mode"`
	SessionMode string            `json:"session_mode"` // user | thread
	Enabled     bool              `json:"enabled"`
	Credentials map[string]string `json:"credentials"`
	Target      WorkspaceTarget   `json:"target"`
	Execution   ExecutionConfig   `json:"execution,omitempty"`
}

type ChannelStatus struct {
	ID        string    `json:"id"`
	State     string    `json:"state"` // disabled | ready | running | error
	Message   string    `json:"message,omitempty"`
	UpdatedAt time.Time `json:"updated_at"`
}

type IncomingMessage struct {
	DeliveryID  string            `json:"delivery_id"`
	Platform    Platform          `json:"platform"`
	ChannelID   string            `json:"channel_id"`
	MessageID   string            `json:"message_id"`
	UserID      string            `json:"user_id"`
	UserName    string            `json:"user_name,omitempty"`
	ChatID      string            `json:"chat_id,omitempty"`
	ThreadID    string            `json:"thread_id,omitempty"`
	ChatType    ChatType          `json:"chat_type"`
	MessageType MessageType       `json:"type"`
	Content     string            `json:"content"`
	Extra       map[string]string `json:"extra,omitempty"`
	FileKey     string            `json:"file_key,omitempty"`
	FileName    string            `json:"file_name,omitempty"`
	FileSize    int64             `json:"file_size,omitempty"`
	Quote       *QuotedMessage    `json:"quote,omitempty"`
	Target      WorkspaceTarget   `json:"target"`
}

type IncomingEnvelope struct {
	DeliveryID string          `json:"delivery_id"`
	Message    IncomingMessage `json:"message"`
}

type WebhookResponse struct {
	Status  int
	Headers map[string]string
	Body    []byte
}
