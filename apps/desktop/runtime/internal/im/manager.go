package im

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type pendingDelivery struct {
	adapter   Adapter
	incoming  *IncomingMessage
	createdAt time.Time
}

type adapterBox struct {
	ready   chan struct{}
	adapter Adapter
}

type Manager struct {
	mu        sync.RWMutex
	channels  map[string]Channel
	statuses  map[string]ChannelStatus
	adapters  map[string]Adapter
	stops     map[string]context.CancelFunc
	factories map[Platform]AdapterFactory
	incoming  chan IncomingEnvelope
	pending   map[string]pendingDelivery
}

func NewManager(factories ...map[Platform]AdapterFactory) *Manager {
	registered := map[Platform]AdapterFactory{}
	if len(factories) > 0 {
		registered = factories[0]
	}
	return &Manager{channels: map[string]Channel{}, statuses: map[string]ChannelStatus{}, adapters: map[string]Adapter{}, stops: map[string]context.CancelFunc{}, factories: registered, incoming: make(chan IncomingEnvelope, 128), pending: map[string]pendingDelivery{}}
}

// Replace 先构建完整下一代 adapter 集，全部成功才交换；失败会停止刚创建的连接并保留旧代。
func (m *Manager) Replace(channels []Channel) error {
	next := make(map[string]Channel, len(channels))
	statuses := make(map[string]ChannelStatus, len(channels))
	adapters := map[string]Adapter{}
	stops := map[string]context.CancelFunc{}
	stopNext := func() {
		for _, stop := range stops {
			if stop != nil {
				stop()
			}
		}
	}
	for _, channel := range channels {
		if err := ValidateChannel(channel); err != nil {
			stopNext()
			return fmt.Errorf("channel %s: %w", channel.ID, err)
		}
		if _, exists := next[channel.ID]; exists {
			stopNext()
			return fmt.Errorf("duplicate channel id %s", channel.ID)
		}
		channel.Credentials = cloneStrings(channel.Credentials)
		next[channel.ID] = channel
		state := "ready"
		if !channel.Enabled {
			state = "disabled"
		}
		statuses[channel.ID] = ChannelStatus{ID: channel.ID, State: state, UpdatedAt: time.Now().UTC()}
		if !channel.Enabled {
			continue
		}
		factory := m.factories[channel.Platform]
		if factory == nil {
			stopNext()
			return fmt.Errorf("platform %s adapter is not registered", channel.Platform)
		}
		credentials, _ := json.Marshal(channel.Credentials)
		legacy := &IMChannel{ID: channel.ID, Platform: string(channel.Platform), Name: channel.Name, Mode: string(channel.Mode), OutputMode: string(channel.OutputMode), SessionMode: channel.SessionMode, Enabled: true, Credentials: credentials}
		box := &adapterBox{ready: make(chan struct{})}
		adapter, stop, err := factory(context.Background(), legacy, m.wrapIncoming(channel, box))
		if err != nil {
			stopNext()
			return fmt.Errorf("start platform %s: %w", channel.Platform, err)
		}
		box.adapter = adapter
		close(box.ready)
		adapters[channel.ID] = adapter
		if stop != nil {
			stops[channel.ID] = stop
		}
		status := statuses[channel.ID]
		status.State = "running"
		statuses[channel.ID] = status
	}
	m.mu.Lock()
	oldStops := m.stops
	m.channels, m.statuses, m.adapters, m.stops = next, statuses, adapters, stops
	m.mu.Unlock()
	for _, stop := range oldStops {
		if stop != nil {
			stop()
		}
	}
	return nil
}

func (m *Manager) wrapIncoming(channel Channel, boxes ...*adapterBox) func(context.Context, *IncomingMessage) error {
	return func(ctx context.Context, message *IncomingMessage) error {
		if message == nil {
			return nil
		}
		deliveryID := uuid.NewString()
		message.DeliveryID = deliveryID
		message.ChannelID = channel.ID
		message.Target = channel.Target
		var adapter Adapter
		if len(boxes) > 0 {
			select {
			case <-boxes[0].ready:
				adapter = boxes[0].adapter
			case <-ctx.Done():
				return ctx.Err()
			}
		} else {
			m.mu.RLock()
			adapter = m.adapters[channel.ID]
			m.mu.RUnlock()
		}
		m.mu.Lock()
		m.pending[deliveryID] = pendingDelivery{adapter: adapter, incoming: message, createdAt: time.Now()}
		m.cleanupPendingLocked()
		m.mu.Unlock()
		select {
		case m.incoming <- IncomingEnvelope{DeliveryID: deliveryID, Message: *message}:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		default:
			return fmt.Errorf("incoming message queue is full")
		}
	}
}

func (m *Manager) Next(ctx context.Context) (IncomingEnvelope, bool) {
	select {
	case event := <-m.incoming:
		return event, true
	case <-ctx.Done():
		return IncomingEnvelope{}, false
	}
}
func (m *Manager) Reply(ctx context.Context, deliveryID, content string) error {
	m.mu.Lock()
	pending, ok := m.pending[deliveryID]
	if ok {
		delete(m.pending, deliveryID)
	}
	m.mu.Unlock()
	if !ok || pending.adapter == nil {
		return fmt.Errorf("delivery not found")
	}
	return pending.adapter.SendReply(ctx, pending.incoming, &ReplyMessage{Content: content, IsFinal: true})
}

func (m *Manager) HandleWebhook(w http.ResponseWriter, r *http.Request, id string) {
	m.mu.RLock()
	adapter, ok := m.adapters[id]
	channel := m.channels[id]
	m.mu.RUnlock()
	if !ok {
		http.Error(w, "channel not found", http.StatusNotFound)
		return
	}
	c, _ := gin.CreateTestContext(w)
	c.Request = r
	if err := adapter.VerifyCallback(c); err != nil {
		http.Error(w, "invalid signature", http.StatusUnauthorized)
		return
	}
	if adapter.HandleURLVerification(c) {
		return
	}
	message, err := adapter.ParseCallback(c)
	if err != nil {
		http.Error(w, "invalid callback", http.StatusBadRequest)
		return
	}
	if message != nil {
		if err := m.wrapIncoming(channel)(r.Context(), message); err != nil {
			http.Error(w, "runtime busy", http.StatusServiceUnavailable)
			return
		}
	}
	if !c.Writer.Written() {
		w.WriteHeader(http.StatusOK)
	}
}

func (m *Manager) List() []Channel {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]Channel, 0, len(m.channels))
	for _, channel := range m.channels {
		channel.Credentials = nil
		result = append(result, channel)
	}
	return result
}
func (m *Manager) Statuses() []ChannelStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]ChannelStatus, 0, len(m.statuses))
	for _, status := range m.statuses {
		result = append(result, status)
	}
	return result
}
func (m *Manager) Channel(id string) (Channel, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	channel, ok := m.channels[id]
	if ok {
		channel.Credentials = cloneStrings(channel.Credentials)
	}
	return channel, ok
}
func (m *Manager) Close() {
	m.mu.Lock()
	stops := m.stops
	m.stops = map[string]context.CancelFunc{}
	m.adapters = map[string]Adapter{}
	m.mu.Unlock()
	for _, stop := range stops {
		if stop != nil {
			stop()
		}
	}
}
func (m *Manager) cleanupPendingLocked() {
	cutoff := time.Now().Add(-30 * time.Minute)
	for id, item := range m.pending {
		if item.createdAt.Before(cutoff) {
			delete(m.pending, id)
		}
	}
}
func cloneStrings(source map[string]string) map[string]string {
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}
func CallbackChannelID(path string) string { return strings.TrimPrefix(path, "/im/callback/") }
