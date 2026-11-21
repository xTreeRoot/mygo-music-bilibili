package bilibili_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"mygo-music/internal/plugin"
)

// Exercise the external JS through the real Go boundary, including artwork nesting and signed playback.
func TestExternalBilibiliArtworkAndPlayback(t *testing.T) {
	original := http.DefaultTransport
	defer func() { http.DefaultTransport = original }()
	metadataReads := 0
	http.DefaultTransport = bundledTransport(func(r *http.Request) (*http.Response, error) {
		header := make(http.Header)
		var data any
		switch r.URL.Path {
		case "/x/passport-login/web/qrcode/generate":
			data = map[string]any{"url": "https://account.bilibili.com/scan", "qrcode_key": "test"}
		case "/x/passport-login/web/qrcode/poll":
			header.Add("Set-Cookie", "SESSDATA=test; Path=/; Domain=bilibili.com")
			header.Add("Set-Cookie", "DedeUserID=123; Path=/; Domain=bilibili.com")
			header.Add("Set-Cookie", "bili_jct=test; Path=/; Domain=bilibili.com")
			data = map[string]any{"code": 0}
		case "/x/web-interface/nav":
			data = map[string]any{"isLogin": true, "mid": 123, "uname": "Listener", "wbi_img": map[string]any{"img_url": "https://i.example/" + strings.Repeat("a", 32) + ".png", "sub_url": "https://i.example/" + strings.Repeat("b", 32) + ".png"}}
		case "/x/v3/fav/folder/created/list-all":
			data = map[string]any{"list": []any{map[string]any{"id": 10, "title": "Favorites", "media_count": 1}}}
		case "/x/v3/fav/folder/info":
			metadataReads++
			if r.URL.Query().Get("media_id") != "10" {
				return nil, fmt.Errorf("wrong folder query")
			}
			data = map[string]any{"id": 10, "title": "Favorites", "cover": "//i0.hdslb.com/folder.jpg", "media_count": 1}
		case "/x/v3/fav/resource/list":
			data = map[string]any{"info": map[string]any{"id": 10, "title": "Favorites", "cover": "//i0.hdslb.com/folder.jpg"}, "medias": []any{map[string]any{"bvid": "BV12BHV6gEdo", "title": "Track", "cover": "//i0.hdslb.com/track.jpg", "duration": 109, "upper": map[string]any{"mid": 9, "name": "Artist"}}}}
		case "/x/web-interface/view":
			data = map[string]any{"bvid": "BV12BHV6gEdo", "cid": 8, "aid": 123, "duration": 109}
		case "/x/player/wbi/playurl":
			q := r.URL.Query()
			if len(q.Get("w_rid")) != 32 || q.Get("wts") == "" || q.Get("bvid") != "BV12BHV6gEdo" || q.Get("cid") != "8" || q.Get("fnval") != "4048" {
				return nil, fmt.Errorf("unsigned or incomplete playback query: %s", r.URL.RawQuery)
			}
			data = map[string]any{"dash": map[string]any{"audio": []any{map[string]any{"base_url": "https://media.bilivideo.com/audio.m4a", "mime_type": "audio/mp4"}}, "video": []any{map[string]any{"baseUrl": "https://media.bilivideo.com/video.m4s", "height": 720, "codecid": 7}}}}
		default:
			return nil, fmt.Errorf("unexpected media API %s", r.URL.Path)
		}
		b, err := json.Marshal(map[string]any{"code": 0, "data": data})
		if err != nil {
			return nil, err
		}
		return &http.Response{StatusCode: 200, Header: header, Body: io.NopCloser(strings.NewReader(string(b))), Request: r}, nil
	})
	src, err := loadBilibili(filepath.Join(t.TempDir(), "bilibili"), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	if _, err = src.SignIn(); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		lists, e := src.Playlists()
		if e != nil {
			t.Fatal(e)
		}
		if len(lists) != 1 || lists[0].ImageURL != "https://i0.hdslb.com/folder.jpg" {
			t.Fatalf("folder artwork: %+v", lists)
		}
	}
	if metadataReads != 1 {
		t.Fatalf("folder metadata not cached: %d reads", metadataReads)
	}
	pl, err := src.Playlist("10")
	if err != nil {
		t.Fatal(err)
	}
	if pl.ImageURL != "https://i0.hdslb.com/folder.jpg" || len(pl.Tracks) != 1 || pl.Tracks[0].Album.ImageURL != "https://i0.hdslb.com/track.jpg" || pl.Tracks[0].Source != "bilibili" {
		t.Fatalf("Go artwork boundary: %+v", pl)
	}
	u, _ := url.Parse(pl.Tracks[0].Album.ImageURL)
	h := src.HeadersFor(u, plugin.KindImage)
	if h["Referer"] != "https://www.bilibili.com/" || h["Cookie"] != "" {
		t.Fatalf("image request headers: %+v", h)
	}
	stream, err := src.Stream(pl.Tracks[0].ID, "high")
	if err != nil {
		t.Fatal(err)
	}
	if stream.URL != "https://media.bilivideo.com/audio.m4a" || stream.Headers["Cookie"] != "" {
		t.Fatalf("audio stream: %+v", stream)
	}
	picture, err := src.Video(pl.Tracks[0].ID, "high")
	if err != nil {
		t.Fatal(err)
	}
	if picture.URL != "https://media.bilivideo.com/video.m4s" || picture.Headers["Cookie"] != "" {
		t.Fatalf("video stream: %+v", picture)
	}
}
