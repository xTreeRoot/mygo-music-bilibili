package bilibili_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mygo-music/internal/music"
	"mygo-music/internal/plugin"
)

// The bundled Bilibili source must compile in MyGo and expose the playback and library operations it implements.
func TestExternalBilibiliPluginLoads(t *testing.T) {
	plugin.SetAppVersion("0.1.0")
	defer plugin.SetAppVersion("")
	pluginSource := filepath.Join(t.TempDir(), "plugins", "bilibili")
	pluginData := filepath.Join(t.TempDir(), "plugin-data")
	source, err := loadBilibili(pluginSource, pluginData)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	if source.Info().ID != "bilibili" {
		t.Fatalf("loaded source id %q", source.Info().ID)
	}
	for _, capability := range []string{
		"signIn", "signOut", "account", "home", "browse", "search", "playlists",
		"playlist", "liked", "isLiked", "like", "comments", "postComment",
		"lyrics", "stream",
	} {
		if !source.Can(capability) {
			t.Errorf("bundled Bilibili source does not export %s", capability)
		}
	}
}

type bundledTransport func(*http.Request) (*http.Response, error)

func (transport bundledTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

// A complete passport session must use raw Set-Cookie values regardless of its navigation URL.
func TestExternalBilibiliQRLogin(t *testing.T) {
	for _, callback := range []string{
		"https://passport.biligame.com/crossDomain",
		"http://passport.biligame.com/crossDomain",
		"https://passport.bilibili.com/crossDomain",
		"",
	} {
		t.Run(callback, func(t *testing.T) { testExternalBilibiliQRLogin(t, callback) })
	}
}

// Zhuoqi reads the authenticated passport response's cookies without requiring its navigation URL.
func testExternalBilibiliQRLogin(t *testing.T, callbackBase string) {
	t.Helper()
	transport := http.DefaultTransport
	defer func() { http.DefaultTransport = transport }()
	generated, validated := 0, 0
	http.DefaultTransport = bundledTransport(func(request *http.Request) (*http.Response, error) {
		header := make(http.Header)
		var body any
		switch request.URL.Path {
		case "/x/passport-login/web/qrcode/generate":
			generated++
			body = map[string]any{"code": 0, "data": map[string]any{
				"url":        "https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=test",
				"qrcode_key": "test",
			}}
		case "/x/passport-login/web/qrcode/poll":
			header.Add("Set-Cookie", "SESSDATA=raw%2Ccookie; Path=/; Domain=bilibili.com; HttpOnly")
			header.Add("Set-Cookie", "DedeUserID=123; Path=/; Domain=bilibili.com")
			header.Add("Set-Cookie", "bili_jct=csrf; Path=/; Domain=bilibili.com")
			callback := callbackBase
			if callback != "" {
				callback += "?" + url.Values{
					"SESSDATA": {"fallback-cookie"}, "DedeUserID": {"123"}, "bili_jct": {"csrf"},
				}.Encode()
			}
			body = map[string]any{"code": 0, "data": map[string]any{"code": 0, "url": callback}}
		case "/x/web-interface/nav":
			validated++
			if request.Header.Get("Cookie") != "SESSDATA=raw%2Ccookie; DedeUserID=123; bili_jct=csrf" {
				return nil, fmt.Errorf("login did not preserve response cookies")
			}
			body = map[string]any{"code": 0, "data": map[string]any{"isLogin": true, "mid": 123, "uname": "Listener"}}
		default:
			return nil, fmt.Errorf("unexpected request path %s", request.URL.Path)
		}
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		return &http.Response{StatusCode: http.StatusOK, Header: header, Body: io.NopCloser(strings.NewReader(string(encoded))), Request: request}, nil
	})
	directory, data := filepath.Join(t.TempDir(), "bilibili"), t.TempDir()
	source, err := loadBilibili(directory, data)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	account, err := source.SignIn()
	if err != nil {
		t.Fatal(err)
	}
	if account.ID != "123" || account.Name != "Listener" {
		t.Fatalf("account: %+v", account)
	}
	if err := source.SignOut(); err != nil {
		t.Fatal(err)
	}
	source.Close()
	path := filepath.Join(data, "bilibili", "storage.json")
	stored, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var storage struct {
		Session struct {
			Cookie string `json:"cookie"`
			Active bool   `json:"active"`
		} `json:"session"`
	}
	if err := json.Unmarshal(stored, &storage); err != nil {
		t.Fatal(err)
	}
	if storage.Session.Cookie == "" || storage.Session.Active {
		t.Fatal("sign-out did not keep a disabled session in the software data directory")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatal("session storage must remain readable only by the current user")
	}
	again, err := plugin.Load(os.Getenv("BILIBILI_PLUGIN_ROOT"), data)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if account, err := again.Account(); err != nil || account != nil || validated != 1 {
		t.Fatal("a disabled session was used after restarting")
	}
	account, err = again.SignIn()
	if err != nil || account == nil || account.ID != "123" || generated != 1 || validated != 2 {
		t.Fatalf("saved cookie was not validated and reused: generated %d, validated %d, error %v", generated, validated, err)
	}
}

// Cancelling the QR dialog must stop its delay rather than leave authentication polling in the background.
func TestExternalBilibiliQRCancel(t *testing.T) {
	transport := http.DefaultTransport
	defer func() { http.DefaultTransport = transport }()
	http.DefaultTransport = bundledTransport(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/x/passport-login/web/qrcode/generate" {
			return nil, fmt.Errorf("cancelled sign-in continued polling")
		}
		body := `{"code":0,"data":{"url":"https://account.bilibili.com/scan","qrcode_key":"test"}}`
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	})
	source, err := loadBilibili(filepath.Join(t.TempDir(), "bilibili"), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	prompted := make(chan struct{}, 1)
	source.OnSignInPrompt(func(_ music.SignInPrompt) { prompted <- struct{}{} })
	finished := make(chan error, 1)
	go func() { _, err := source.SignIn(); finished <- err }()
	select {
	case <-prompted:
	case <-time.After(3 * time.Second):
		t.Fatal("QR prompt was not delivered")
	}
	source.CancelSignIn()
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("cancelled sign-in succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("cancelling sign-in did not stop its timer")
	}
}

// loadBilibili loads the independent plugin through the real generic host.
func loadBilibili(directory, dataDirectory string) (*plugin.Plugin, error) {
    source := os.Getenv("BILIBILI_PLUGIN_ROOT")
    if source == "" { return nil, fmt.Errorf("BILIBILI_PLUGIN_ROOT is required") }
    return plugin.Load(source, dataDirectory)
}
