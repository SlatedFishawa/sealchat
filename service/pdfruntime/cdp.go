package pdfruntime

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"

	"github.com/fasthttp/websocket"
)

// maxCDPMessage bounds a single DevTools protocol message (IO.read chunks are
// requested at 1 MiB, i.e. about 1.4 MiB base64).
const maxCDPMessage = 32 << 20

var errCDPClosed = errors.New("浏览器控制通道已关闭")

// cdpTransport moves whole protocol messages.
type cdpTransport interface {
	Send(msg []byte) error
	Recv() ([]byte, error)
	Close() error
}

// pipeTransport implements --remote-debugging-pipe framing: JSON messages
// separated by a NUL byte, browser reads fd 3 and writes fd 4.
type pipeTransport struct {
	w      io.WriteCloser
	r      *bufio.Reader
	closer io.Closer
	wmu    sync.Mutex
}

func newPipeTransport(w io.WriteCloser, r io.ReadCloser) *pipeTransport {
	return &pipeTransport{w: w, r: bufio.NewReaderSize(r, 64<<10), closer: r}
}

func (t *pipeTransport) Send(msg []byte) error {
	t.wmu.Lock()
	defer t.wmu.Unlock()
	if _, err := t.w.Write(msg); err != nil {
		return err
	}
	_, err := t.w.Write([]byte{0})
	return err
}

func (t *pipeTransport) Recv() ([]byte, error) {
	var buf []byte
	for {
		chunk, err := t.r.ReadSlice(0)
		buf = append(buf, chunk...)
		if len(buf) > maxCDPMessage {
			return nil, errors.New("浏览器控制消息过大")
		}
		if err == nil {
			return buf[:len(buf)-1], nil
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return nil, err
		}
	}
}

func (t *pipeTransport) Close() error {
	err := t.w.Close()
	if cerr := t.closer.Close(); err == nil {
		err = cerr
	}
	return err
}

// wsTransport is used where pipes cannot be inherited (Windows): the browser
// listens on an ephemeral loopback port announced in DevToolsActivePort.
type wsTransport struct {
	conn *websocket.Conn
	wmu  sync.Mutex
}

func dialWSTransport(ctx context.Context, url string) (*wsTransport, error) {
	dialer := websocket.Dialer{}
	conn, _, err := dialer.DialContext(ctx, url, nil)
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(maxCDPMessage)
	return &wsTransport{conn: conn}, nil
}

func (t *wsTransport) Send(msg []byte) error {
	t.wmu.Lock()
	defer t.wmu.Unlock()
	return t.conn.WriteMessage(websocket.TextMessage, msg)
}

func (t *wsTransport) Recv() ([]byte, error) {
	_, msg, err := t.conn.ReadMessage()
	return msg, err
}

func (t *wsTransport) Close() error { return t.conn.Close() }

type cdpError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *cdpError) Error() string { return fmt.Sprintf("CDP %d: %s", e.Code, e.Message) }

type cdpMessage struct {
	ID        int64           `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	Params    any             `json:"params,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *cdpError       `json:"error,omitempty"`
}

type cdpReply struct {
	result json.RawMessage
	err    error
}

// cdpConn is a minimal DevTools protocol client: request/response by id, events
// are only inspected for crash/detach notifications.
type cdpConn struct {
	t       cdpTransport
	nextID  atomic.Int64
	mu      sync.Mutex
	pending map[int64]chan cdpReply
	done    chan struct{}
	err     error
	crashed atomic.Bool
}

func newCDPConn(t cdpTransport) *cdpConn {
	c := &cdpConn{t: t, pending: map[int64]chan cdpReply{}, done: make(chan struct{})}
	go c.readLoop()
	return c
}

func (c *cdpConn) readLoop() {
	var err error
	for {
		var raw []byte
		raw, err = c.t.Recv()
		if err != nil {
			break
		}
		var msg cdpMessage
		if json.Unmarshal(raw, &msg) != nil {
			continue
		}
		if msg.ID == 0 {
			switch msg.Method {
			case "Inspector.targetCrashed", "Target.targetCrashed":
				c.crashed.Store(true)
			}
			continue
		}
		c.mu.Lock()
		ch := c.pending[msg.ID]
		delete(c.pending, msg.ID)
		c.mu.Unlock()
		if ch == nil {
			continue
		}
		if msg.Error != nil {
			ch <- cdpReply{err: msg.Error}
		} else {
			ch <- cdpReply{result: msg.Result}
		}
	}
	c.mu.Lock()
	if err == nil || errors.Is(err, io.EOF) {
		err = errCDPClosed
	}
	c.err = err
	for id, ch := range c.pending {
		delete(c.pending, id)
		ch <- cdpReply{err: errCDPClosed}
	}
	c.mu.Unlock()
	close(c.done)
}

// Call sends one command and decodes its result into out (when non-nil).
func (c *cdpConn) Call(ctx context.Context, sessionID, method string, params any, out any) error {
	id := c.nextID.Add(1)
	ch := make(chan cdpReply, 1)
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return c.err
	}
	c.pending[id] = ch
	c.mu.Unlock()
	if params == nil {
		params = struct{}{}
	}
	raw, err := json.Marshal(cdpMessage{ID: id, Method: method, SessionID: sessionID, Params: params})
	if err != nil {
		return err
	}
	if err := c.t.Send(raw); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return err
	}
	select {
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return ctx.Err()
	case reply := <-ch:
		if reply.err != nil {
			return reply.err
		}
		if out != nil && len(reply.result) > 0 {
			return json.Unmarshal(reply.result, out)
		}
		return nil
	}
}

func (c *cdpConn) Crashed() bool { return c.crashed.Load() }

func (c *cdpConn) Close() error {
	err := c.t.Close()
	<-c.done
	return err
}
