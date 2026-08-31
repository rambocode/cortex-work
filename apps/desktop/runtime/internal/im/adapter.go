package im

import (
	"context"
	"io"

	"github.com/gin-gonic/gin"
)

type MessageType string

const (
	MessageTypeText  MessageType = "text"
	MessageTypeFile  MessageType = "file"
	MessageTypeImage MessageType = "image"
)

type ChatType string

const (
	ChatTypeDirect ChatType = "direct"
	ChatTypeGroup  ChatType = "group"
)

type QuotedMessage struct {
	MessageID, Content, SenderID string
	IsBotMessage                 bool
	NonTextType                  string
}
type ReplyMessage struct {
	Content              string
	IsStreaming, IsFinal bool
	Extra                map[string]string
}

type Adapter interface {
	Platform() Platform
	VerifyCallback(*gin.Context) error
	ParseCallback(*gin.Context) (*IncomingMessage, error)
	SendReply(context.Context, *IncomingMessage, *ReplyMessage) error
	HandleURLVerification(*gin.Context) bool
}
type StreamSender interface {
	StartStream(context.Context, *IncomingMessage) (string, error)
	UpdateStreamContent(context.Context, *IncomingMessage, string, string) error
	FinalizeStream(context.Context, *IncomingMessage, string, string) error
	EndStream(context.Context, *IncomingMessage, string) error
}
type FileDownloader interface {
	DownloadFile(context.Context, *IncomingMessage) (io.ReadCloser, string, error)
}

type IMChannel struct {
	ID, Platform, Name, Mode, OutputMode, SessionMode string
	Enabled                                           bool
	Credentials                                       []byte
}
type AdapterFactory func(context.Context, *IMChannel, func(context.Context, *IncomingMessage) error) (Adapter, context.CancelFunc, error)
