package secutils

import (
	"context"
	"net"
	"os"
	"testing"
	"time"
)

func TestTrustedPlatformFakeIPPolicy(t *testing.T) {
	trusted := map[string]struct{}{"openws.work.weixin.qq.com": {}}
	if !allowTrustedPlatformFakeIP("openws.work.weixin.qq.com", net.ParseIP("198.18.27.3"), trusted) {
		t.Fatal("official WeCom host behind Fake-IP proxy should be allowed")
	}
	if allowTrustedPlatformFakeIP("attacker.example", net.ParseIP("198.18.27.3"), trusted) {
		t.Fatal("untrusted host must not inherit the Fake-IP exception")
	}
	if allowTrustedPlatformFakeIP("openws.work.weixin.qq.com", net.ParseIP("127.0.0.1"), trusted) {
		t.Fatal("trusted host must not bypass non-Fake-IP private ranges")
	}
}

func TestTrustedPlatformDialLive(t *testing.T) {
	if os.Getenv("CORTEX_TEST_LIVE_NETWORK") != "1" {
		t.Skip("set CORTEX_TEST_LIVE_NETWORK=1 to exercise the system proxy/DNS path")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	conn, err := TrustedPlatformDialContext("openws.work.weixin.qq.com")(
		ctx, "tcp", "openws.work.weixin.qq.com:443",
	)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
}
