import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pluginSource = await readFile(new URL("../index.js", import.meta.url), "utf8");
let runtimeID = 0;

/** Load the Bilibili strategy with isolated host and network stubs. */
async function loadStrategy(fetchMock, prompts, storage = new Map()) {
  globalThis.host = {
    t: (message) => message,
    signInPrompt: (prompt) => prompts.push(prompt),
    crypto: { md5: () => "signature" },
    storage: {
      get: (key) => structuredClone(storage.get(key)),
      set: (key, value) => storage.set(key, structuredClone(value)),
      remove: (key) => storage.delete(key),
    },
  };
  globalThis.fetch = fetchMock;
  globalThis.setTimeout = (callback) => {
    queueMicrotask(callback);
    return 0;
  };
  const source = Buffer.from(pluginSource).toString("base64");
  return import(`data:text/javascript;base64,${source}#runtime-${runtimeID++}`);
}

/** Return the minimal Fetch response used by the sign-in API tests. */
function jsonResponse(data) {
  return { ok: true, status: 200, json: async () => data };
}

/** Build a successful login callback containing a session and unrelated query values. */
function loginCallback() {
  const query = new URLSearchParams({
    code: "0",
    gourl: "https://www.bilibili.com/",
    SESSDATA: "session-value",
    DedeUserID: "123",
    DedeUserID__ckMd5: "cookie-check",
    bili_jct: "csrf-value",
    sid: "session-id",
    unrelated: "must-not-be-a-cookie",
  });
  return `https://passport.biligame.com/crossDomain?${query}`;
}

/** Public recommendations, search and playback must remain usable before login. */
test("guests can browse, search and play without a cookie or QR login", async () => {
  const original = { fetch: globalThis.fetch, host: globalThis.host, setTimeout: globalThis.setTimeout };
  const prompts = [];
  const video = { goto: "av", bvid: "BV1Q9YX6QEn2", title: "Public video" };
  try {
    const module = await loadStrategy(async (input, options) => {
      const url = new URL(input);
      assert.equal(options.headers.Cookie, undefined);
      switch (url.pathname) {
        case "/x/web-interface/nav":
          return jsonResponse({ code: -101, data: { isLogin: false, wbi_img: {
            img_url: `https://i.example/${"a".repeat(32)}.png`, sub_url: `https://i.example/${"b".repeat(32)}.png`,
          } } });
        case "/x/web-interface/wbi/index/top/feed/rcmd":
          return jsonResponse({ code: 0, data: { item: [video] } });
        case "/x/web-interface/wbi/search/type":
          return jsonResponse({ code: 0, data: { result: [video], numPages: 1 } });
        case "/x/web-interface/view":
          return jsonResponse({ code: 0, data: { aid: 7, cid: 8 } });
        case "/x/player/wbi/playurl":
          return jsonResponse({ code: 0, data: { dash: {
            audio: [{ base_url: "https://media.bilivideo.com/audio.m4a" }],
            video: [{ base_url: "https://media.bilivideo.com/video.m4s", codecid: 7, height: 720 }],
          } } });
        default:
          throw new Error(`Unexpected guest request: ${url.pathname}`);
      }
    }, prompts);
    assert.equal(await module.account(), null);
    assert.equal((await module.home()).sections[0].tracks[0].id, video.bvid);
    assert.equal((await module.search({ query: "music", kind: "tracks", offset: 0 })).tracks[0].id, video.bvid);
    assert.equal((await module.stream({ id: video.bvid })).url, "https://media.bilivideo.com/audio.m4a");
    assert.equal((await module.video({ id: video.bvid })).url, "https://media.bilivideo.com/video.m4s");
    assert.deepEqual(await module.playlists(), []);
    await assert.rejects(module.browse({ page: "personal" }), { code: "signIn" });
    assert.deepEqual(prompts, []);
  } finally {
    Object.assign(globalThis, original);
  }
});

/** Keep a logged-out session across runtimes, then validate it before reusing it. */
test("sign-out preserves the cookie across restarts without sending it until sign-in", async () => {
  const original = { fetch: globalThis.fetch, host: globalThis.host, setTimeout: globalThis.setTimeout };
  const storage = new Map();
  const prompts = [];
  let generateCount = 0;
  let validationCount = 0;
  let guest = false;
  const fetchMock = async (input, options) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/generate")) {
      generateCount++;
      return jsonResponse({ code: 0, data: { url: "https://account.bilibili.com/scan", qrcode_key: "key" } });
    }
    if (url.pathname.endsWith("/poll")) return jsonResponse({ code: 0, data: { code: 0, url: loginCallback() } });
    if (url.pathname === "/x/web-interface/nav") {
      if (guest) {
        assert.equal(options.headers.Cookie, undefined);
        return jsonResponse({ code: -101, data: { isLogin: false, wbi_img: {
          img_url: `https://i.example/${"a".repeat(32)}.png`, sub_url: `https://i.example/${"b".repeat(32)}.png`,
        } } });
      }
      validationCount++;
      assert.match(options.headers.Cookie, /SESSDATA=session-value/);
      return jsonResponse({ code: 0, data: { isLogin: true, mid: 123, uname: "listener" } });
    }
    assert.equal(url.pathname, "/x/web-interface/wbi/index/top/feed/rcmd");
    assert.equal(options.headers.Cookie, undefined);
    return jsonResponse({ code: 0, data: { item: [{ goto: "av", bvid: "BV1Q9YX6QEn2", title: "Public video" }] } });
  };
  try {
    let module = await loadStrategy(fetchMock, prompts, storage);
    await module.signIn();
    const saved = storage.get("session").cookie;
    await module.signOut();
    assert.deepEqual(storage.get("session"), { cookie: saved, active: false });
    assert.equal(await module.account(), null);
    guest = true;
    module = await loadStrategy(fetchMock, prompts, storage);
    assert.equal(await module.account(), null);
    assert.deepEqual(await module.playlists(), []);
    assert.deepEqual(await module.isLiked({ ids: ["BV1Q9YX6QEn2"] }), {});
    const home = await module.home();
    assert.equal(home.sections[0].tracks[0].name, "Public video");
    assert.equal(storage.get("session").cookie, saved);
    assert.equal(storage.get("session").active, false);
    guest = false;
    assert.equal((await module.signIn()).id, "123");
    assert.equal(storage.get("session").active, true);
    assert.equal(generateCount, 1, "a valid saved cookie must not open another QR login");
    assert.equal(validationCount, 2);
    module = await loadStrategy(fetchMock, prompts, storage);
    assert.equal((await module.account()).id, "123");
    assert.equal(validationCount, 3, "an active session must be validated after restart");
  } finally {
    Object.assign(globalThis, original);
  }
});

test("session migration stages only allowlisted cookies for the verified account", async () => {
  const original = { fetch: globalThis.fetch, host: globalThis.host, setTimeout: globalThis.setTimeout };
  const storage = new Map();
  const cookie = "SESSDATA=synthetic-session; DedeUserID=123; bili_jct=synthetic-csrf";
  const candidate = { format: 1, account_id: "123", session: { cookie: `${cookie}; sid=local-only` } };
  let verifiedID = 456;
  try {
    const module = await loadStrategy(async (input, options) => {
      assert.equal(new URL(input).pathname, "/x/web-interface/nav");
      assert.equal(options.headers.Cookie, cookie);
      return jsonResponse({ code: 0, data: { isLogin: true, mid: verifiedID, uname: "listener" } });
    }, [], storage);
    assert.equal(await module.validateSession(candidate), null);
    assert.equal(storage.has("session"), false);
    verifiedID = 123;
    const account = await module.validateSession(candidate);
    assert.equal(account.id, "123");
    assert.equal(storage.has("session"), false);
    assert.equal(await module.account(), null);
    assert.equal(module.commitSession({ ...candidate, account }).id, "123");
    assert.deepEqual(storage.get("session"), { cookie, active: true });
    assert.deepEqual(module.exportSession(), { ...candidate, account_label: "listener", session: { cookie } });
    await module.signOut();
    assert.equal(await module.validateSession(candidate), null);
    assert.equal(module.exportSession(), null);
    assert.deepEqual(storage.get("session"), { cookie, active: false });
  } finally {
    Object.assign(globalThis, original);
  }
});

/** Expired saved cookies fall back to scanning and are replaced only after validation. */
test("expired saved cookies fall back to QR login", async () => {
  const original = { fetch: globalThis.fetch, host: globalThis.host, setTimeout: globalThis.setTimeout };
  try {
    for (const expired of [{ code: -101, data: {} }, { code: 0, data: { isLogin: false } }]) {
      const storage = new Map([["session", { cookie: "SESSDATA=expired", active: false }]]);
      let validations = 0;
      const module = await loadStrategy(async (input, options) => {
        const url = new URL(input);
        if (url.pathname === "/x/web-interface/nav") {
          validations++;
          if (options.headers.Cookie === "SESSDATA=expired") return jsonResponse(expired);
          assert.match(options.headers.Cookie, /SESSDATA=session-value/);
          return jsonResponse({ code: 0, data: { isLogin: true, mid: 123 } });
        }
        if (url.pathname.endsWith("/generate")) {
          assert.deepEqual(storage.get("session"), { cookie: "SESSDATA=expired", active: false });
          return jsonResponse({ code: 0, data: { url: "https://account.bilibili.com/scan", qrcode_key: "key" } });
        }
        assert.ok(url.pathname.endsWith("/poll"));
        return jsonResponse({ code: 0, data: { code: 0, url: loginCallback() } });
      }, [], storage);
      assert.equal((await module.signIn()).id, "123");
      assert.equal(validations, 2);
      assert.match(storage.get("session").cookie, /SESSDATA=session-value/);
      assert.equal(storage.get("session").active, true);
    }
  } finally {
    Object.assign(globalThis, original);
  }
});

/** A temporary network failure must not erase a reusable saved session or demand a scan. */
test("failed cookie validation keeps the saved session for a later retry", async () => {
  const original = { fetch: globalThis.fetch, host: globalThis.host, setTimeout: globalThis.setTimeout };
  const saved = { cookie: "SESSDATA=saved", active: false };
  const storage = new Map([["session", saved]]);
  try {
    const module = await loadStrategy(async (input) => {
      assert.equal(new URL(input).pathname, "/x/web-interface/nav");
      throw new Error("offline");
    }, [], storage);
    await assert.rejects(module.signIn(), /offline/);
    assert.deepEqual(storage.get("session"), saved);
    assert.equal(await module.account(), null);
  } finally {
    Object.assign(globalThis, original);
  }
});

/** Cancelling a saved-cookie check must not activate its late successful response. */
test("cancelled cookie reuse cannot silently sign in", async () => {
  const original = { fetch: globalThis.fetch, host: globalThis.host, setTimeout: globalThis.setTimeout };
  const saved = { cookie: "SESSDATA=saved", active: false };
  const storage = new Map([["session", saved]]);
  let finish;
  try {
    const module = await loadStrategy(async (input) => {
      assert.equal(new URL(input).pathname, "/x/web-interface/nav");
      return new Promise((resolve) => { finish = resolve; });
    }, [], storage);
    const signingIn = module.signIn();
    await module.signOut();
    finish(jsonResponse({ code: 0, data: { isLogin: true, mid: 123 } }));
    await assert.rejects(signingIn);
    assert.equal(await module.account(), null);
    assert.deepEqual(storage.get("session"), saved);
  } finally {
    Object.assign(globalThis, original);
  }
});

/** Verify scanning, confirmation and successful session validation in order. */
test("QR sign-in reports scan states and validates the returned account", async () => {
  const original = { fetch: globalThis.fetch, host: globalThis.host, setTimeout: globalThis.setTimeout };
  const prompts = [];
  const statuses = [86101, 86090, 0];
  const calls = [];
  try {
    const module = await loadStrategy(async (input, options) => {
      const url = new URL(input);
      calls.push({ url, options });
      if (url.pathname.endsWith("/generate")) {
        return jsonResponse({ code: 0, data: { url: "https://account.bilibili.com/scan", qrcode_key: "qr-key" } });
      }
      if (url.pathname.endsWith("/poll")) {
        assert.equal(url.searchParams.get("qrcode_key"), "qr-key");
        const code = statuses.shift();
        return jsonResponse({ code: 0, data: { code, url: code === 0 ? loginCallback() : "", message: "pending" } });
      }
      assert.equal(url.pathname, "/x/web-interface/nav");
      assert.match(options.headers.Cookie, /SESSDATA=session-value/);
      assert.match(options.headers.Cookie, /bili_jct=csrf-value/);
      assert.doesNotMatch(options.headers.Cookie, /unrelated|gourl|code=/);
      return jsonResponse({ code: 0, data: { isLogin: true, mid: 123, uname: "listener", face: "https://i.example/avatar" } });
    }, prompts);

    const account = await module.signIn();
    assert.deepEqual(account, {
      id: "123",
      name: "listener",
      imageUrl: "https://i.example/avatar",
      page: "personal",
    });
    assert.deepEqual(prompts.map(({ text }) => text), [
      "Scan this QR code with the Bilibili app.",
      "Confirm the login in the Bilibili app.",
    ]);
    assert.equal(calls.filter(({ url }) => url.pathname.endsWith("/poll")).length, 3);
  } finally {
    globalThis.fetch = original.fetch;
    globalThis.host = original.host;
    globalThis.setTimeout = original.setTimeout;
  }
});

/** Verify an expired QR code is replaced before polling continues. */
test("QR sign-in replaces an expired code", async () => {
  const original = { fetch: globalThis.fetch, host: globalThis.host, setTimeout: globalThis.setTimeout };
  const prompts = [];
  let generated = 0;
  let polled = 0;
  try {
    const module = await loadStrategy(async (input) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/generate")) {
        generated += 1;
        return jsonResponse({ code: 0, data: { url: `https://account.bilibili.com/scan/${generated}`, qrcode_key: `key-${generated}` } });
      }
      if (url.pathname.endsWith("/poll")) {
        polled += 1;
        if (polled === 1) {
          assert.equal(url.searchParams.get("qrcode_key"), "key-1");
          return jsonResponse({ code: 0, data: { code: 86038, message: "expired" } });
        }
        assert.equal(url.searchParams.get("qrcode_key"), "key-2");
        return jsonResponse({ code: 0, data: { code: 0, url: loginCallback() } });
      }
      return jsonResponse({ code: 0, data: { isLogin: true, mid: 123, uname: "listener" } });
    }, prompts);

    await module.signIn();
    assert.equal(generated, 2);
    assert.equal(prompts.at(-1).qr, "https://account.bilibili.com/scan/2");
    assert.match(prompts.at(-1).text, /expired/);
  } finally {
    globalThis.fetch = original.fetch;
    globalThis.host = original.host;
    globalThis.setTimeout = original.setTimeout;
  }
});

/** Reject callback URLs that cannot safely supply Bilibili session cookies. */
test("QR sign-in rejects a foreign callback", async () => {
  const original = { fetch: globalThis.fetch, host: globalThis.host, setTimeout: globalThis.setTimeout };
  const prompts = [];
  try {
    const module = await loadStrategy(async (input) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/generate")) {
        return jsonResponse({ code: 0, data: { url: "https://account.bilibili.com/scan", qrcode_key: "qr-key" } });
      }
      return jsonResponse({ code: 0, data: { code: 0, url: "https://example.com/?SESSDATA=x&DedeUserID=1" } });
    }, prompts);
    await assert.rejects(module.signIn(), /unsupported login callback/);
  } finally {
    globalThis.fetch = original.fetch;
    globalThis.host = original.host;
    globalThis.setTimeout = original.setTimeout;
  }
});

/** Verify numeric account IDs and the UP owner's next video page reach the strategy. */
test("UP video pagination accepts numeric IDs and requests the selected page", async () => {
  const original = { fetch: globalThis.fetch, host: globalThis.host, setTimeout: globalThis.setTimeout };
  const prompts = [];
  const calls = [];
  try {
    const module = await loadStrategy(async (input) => {
      const url = new URL(input);
      calls.push(url);
      if (url.pathname.endsWith("/generate")) {
        return jsonResponse({ code: 0, data: { url: "https://account.bilibili.com/scan", qrcode_key: "qr-key" } });
      }
      if (url.pathname.endsWith("/poll")) {
        return jsonResponse({ code: 0, data: { code: 0, url: loginCallback() } });
      }
      if (url.pathname === "/x/web-interface/nav") {
        return jsonResponse({
          code: 0,
          data: {
            isLogin: true,
            mid: 123,
            uname: "listener",
            wbi_img: {
              img_url: `https://i.example/${"a".repeat(32)}.png`,
              sub_url: `https://i.example/${"b".repeat(32)}.png`,
            },
          },
        });
      }
      if (url.pathname === "/x/space/wbi/acc/info") {
        assert.equal(url.searchParams.get("mid"), "42");
        return jsonResponse({ code: 0, data: { name: "UP", face: "https://i.example/up", sign: "profile" } });
      }
      if (url.pathname === "/x/relation/stat") {
        return jsonResponse({ code: 0, data: { follower: 8 } });
      }
      if (url.pathname === "/x/space/wbi/arc/search") {
        assert.equal(url.searchParams.get("mid"), "42");
        assert.equal(url.searchParams.get("pn"), "2");
        return jsonResponse({
          code: 0,
          data: {
            list: { vlist: [{ bvid: "BV1Q9YX6QEn2", title: "Video", duration: 61 }] },
            page: { count: 100 },
          },
        });
      }
      throw new Error(`Unexpected Bilibili request: ${url}`);
    }, prompts);

    await module.signIn();
    const page = await module.browse({ page: "user:42:2" });
    assert.equal(page.title, "UP");
    assert.equal(page.sections[0].tracks[0].id, "BV1Q9YX6QEn2");
    assert.equal(page.sections[0].morePage, "user:42:3");
    assert.ok(calls.some((url) => url.pathname === "/x/space/wbi/arc/search"));
  } finally {
    globalThis.fetch = original.fetch;
    globalThis.host = original.host;
    globalThis.setTimeout = original.setTimeout;
  }
});

/** Verify Bilibili subtitle seconds become player milliseconds. */
test("timed subtitles preserve each line's start and end", async () => {
  const original = { fetch: globalThis.fetch, host: globalThis.host, setTimeout: globalThis.setTimeout };
  const prompts = [];
  try {
    const module = await loadStrategy(async (input) => {
      const url = new URL(input);
      if (url.pathname === "/x/web-interface/view") {
        return jsonResponse({ code: 0, data: { aid: 7, cid: 8 } });
      }
      if (url.pathname === "/x/web-interface/nav") {
        return jsonResponse({
          code: -101,
          data: {
            wbi_img: {
              img_url: `https://i.example/${"a".repeat(32)}.png`,
              sub_url: `https://i.example/${"b".repeat(32)}.png`,
            },
          },
        });
      }
      if (url.pathname === "/x/player/wbi/v2") {
        assert.equal(url.searchParams.get("aid"), "7");
        assert.equal(url.searchParams.get("cid"), "8");
        return jsonResponse({
          code: 0,
          data: {
            subtitle: {
              subtitles: [{ lan: "zh-CN", subtitle_url: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/test.json" }],
            },
          },
        });
      }
      if (url.hostname === "aisubtitle.hdslb.com") {
        return { ok: true, status: 200, json: async () => ({ body: [
          { from: 1.25, to: 2.5, content: "第一句" },
          { from: 3, to: 2, content: "无效时间" },
        ] }) };
      }
      throw new Error(`Unexpected Bilibili request: ${url}`);
    }, prompts);

    const lyrics = await module.lyrics({ id: "BV1Q9YX6QEn2" });
    assert.deepEqual(lyrics.lines, [{ start: 1250, end: 2500, text: "第一句" }]);
  } finally {
    globalThis.fetch = original.fetch;
    globalThis.host = original.host;
    globalThis.setTimeout = original.setTimeout;
  }
});

/** Opening a favorites link must request its selected page instead of calling a missing handler. */
test("favorites browse pages request one page and expose the next page", async () => {
  const original = { fetch: globalThis.fetch, host: globalThis.host, setTimeout: globalThis.setTimeout };
  try {
    const module = await loadStrategy(async (input) => {
      const url = new URL(input);
      assert.equal(url.pathname, "/x/v3/fav/resource/list");
      assert.equal(url.searchParams.get("media_id"), "17");
      assert.equal(url.searchParams.get("pn"), "2");
      assert.equal(url.searchParams.get("ps"), "20");
      return jsonResponse({ code: 0, data: {
        info: { id: 17, title: "收藏夹", media_count: 65 },
        has_more: 1,
        medias: [{ bvid: "BV1Q9YX6QEn2", title: "Video", duration: 61 }],
      } });
    }, []);
    const page = await module.browse({ page: "folder:17:2" });
    assert.equal(page.title, "收藏夹");
    assert.equal(page.sections[0].morePage, "folder:17:3");
    assert.equal(page.sections[0].tracks[0].id, "BV1Q9YX6QEn2");
  } finally {
    globalThis.fetch = original.fetch;
    globalThis.host = original.host;
    globalThis.setTimeout = original.setTimeout;
  }
});

/** Verify audio requests use public playback headers without the login cookie. */
test("audio stream headers do not include the account cookie", async () => {
  const original = { fetch: globalThis.fetch, host: globalThis.host, setTimeout: globalThis.setTimeout };
  const prompts = [];
  try {
    const module = await loadStrategy(async (input, options) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/generate")) {
        return jsonResponse({ code: 0, data: { url: "https://account.bilibili.com/scan", qrcode_key: "qr-key" } });
      }
      if (url.pathname.endsWith("/poll")) {
        return jsonResponse({ code: 0, data: { code: 0, url: loginCallback() } });
      }
      if (url.pathname === "/x/web-interface/nav") {
        assert.match(options.headers.Cookie, /SESSDATA=session-value/);
        return jsonResponse({ code: 0, data: { isLogin: true, mid: 123, uname: "listener", wbi_img: { img_url: `https://i.example/${"a".repeat(32)}.png`, sub_url: `https://i.example/${"b".repeat(32)}.png` } } });
      }
      if (url.pathname === "/x/web-interface/view") {
        assert.match(options.headers.Cookie, /SESSDATA=session-value/);
        return jsonResponse({ code: 0, data: { aid: 7, cid: 8 } });
      }
      if (url.pathname === "/x/player/wbi/playurl") {
        assert.match(options.headers.Cookie, /SESSDATA=session-value/);
        const playInfo = { data: { dash: { video: [{ base_url: "https://upos-sz-mirrorcos.bilivideo.com/1080.m4s", height: 1080, codecid: 7 }, { baseUrl: "https://upos-sz-mirrorcos.bilivideo.com/720.m4s", height: 720, codecs: "avc1.640028" }, { base_url: "https://upos-sz-mirrorcos.bilivideo.com/av1.m4s", height: 720, codecid: 13 }], audio: [{ base_url: "https://upos-sz-mirrorcos.bilivideo.com/audio.m4a", mime_type: "audio/mp4", id: 30280, size: 120 }] } } };
        assert.equal(url.searchParams.get("cid"), "8");
        assert.equal(url.searchParams.get("fnval"), "4048");
        return jsonResponse({ code: 0, ...playInfo });
      }
      throw new Error(`Unexpected Bilibili request: ${url}`);
    }, prompts);

    await module.signIn();
    const stream = await module.stream({ id: "BV1Q9YX6QEn2" });
    assert.equal(stream.url, "https://upos-sz-mirrorcos.bilivideo.com/audio.m4a");
    assert.equal(stream.headers.Cookie, undefined);
    assert.equal(stream._cid, "8");
    const video = await module.video({ id: "BV1Q9YX6QEn2" });
    assert.equal(video.url, "https://upos-sz-mirrorcos.bilivideo.com/720.m4s");
    assert.equal(video.headers.Cookie, undefined);
    assert.equal(video.headers.Referer, "https://www.bilibili.com/");
  } finally {
    globalThis.fetch = original.fetch;
    globalThis.host = original.host;
    globalThis.setTimeout = original.setTimeout;
  }
});
