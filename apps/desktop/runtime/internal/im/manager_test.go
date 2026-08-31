package im

import (
	"context"
	"testing"
)

func validChannel(id string) Channel {
	return Channel{ID: id, Name: "Bot", Platform: PlatformTelegram, Mode: ModeLongPoll,
		OutputMode: OutputStream, SessionMode: "user", Enabled: true,
		Credentials: map[string]string{"bot_token": "secret"}, Target: WorkspaceTarget{Kind: "personal"}}
}

func TestPlatformSpecsCoverWeKnoraPlatforms(t *testing.T) {
	want := map[Platform]bool{PlatformWeCom: true, PlatformFeishu: true, PlatformLark: true, PlatformSlack: true,
		PlatformTelegram: true, PlatformDingTalk: true, PlatformMattermost: true, PlatformWeChat: true,
		PlatformQQBot: true, PlatformYunzhijia: true}
	for _, spec := range PlatformSpecs() {
		delete(want, spec.Platform)
	}
	if len(want) != 0 {
		t.Fatalf("missing platforms: %v", want)
	}
}

func TestManagerReplaceIsAtomicAndDoesNotExposeCredentials(t *testing.T) {
	manager := NewManager(map[Platform]AdapterFactory{PlatformTelegram: func(context.Context, *IMChannel, func(context.Context, *IncomingMessage) error) (Adapter, context.CancelFunc, error) {
		return nil, nil, nil
	}})
	if err := manager.Replace([]Channel{validChannel("one")}); err != nil {
		t.Fatal(err)
	}
	invalid := validChannel("two")
	invalid.Credentials = nil
	if err := manager.Replace([]Channel{invalid}); err == nil {
		t.Fatal("expected validation error")
	}
	channels := manager.List()
	if len(channels) != 1 || channels[0].ID != "one" {
		t.Fatalf("old config was not preserved: %+v", channels)
	}
	if channels[0].Credentials != nil {
		t.Fatal("list exposed credentials")
	}
}

func TestValidateChannelUsesModeSpecificCredentials(t *testing.T) {
	channel := validChannel("slack")
	channel.Platform, channel.Mode = PlatformSlack, ModeWebhook
	channel.Credentials = map[string]string{"bot_token": "x"}
	if err := ValidateChannel(channel); err == nil {
		t.Fatal("missing signing_secret accepted")
	}
	channel.Credentials["signing_secret"] = "y"
	if err := ValidateChannel(channel); err != nil {
		t.Fatal(err)
	}
}
