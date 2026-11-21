import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../index.js", import.meta.url), "utf8");
let serial = 0;

/** Load one isolated plugin and restore the test process's host afterwards. */
async function withPlugin(fetchMock, run, storage = new Map()) {
  const original = { host: globalThis.host, fetch: globalThis.fetch };
  globalThis.host = {
    t: (value) => value,
    crypto: { md5: () => "signed" },
    storage: {
      get: (key) => structuredClone(storage.get(key)),
      set: (key, value) => storage.set(key, structuredClone(value)),
      remove: (key) => storage.delete(key),
    },
  };
  globalThis.fetch = fetchMock;
  try {
    const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#home-${serial++}`);
    await run(module);
  } finally {
    Object.assign(globalThis, original);
  }
}

const response = (data) => ({ ok: true, status: 200, json: async () => ({ code: 0, data }) });
const video = (id) => ({ bvid: `BV${id}`, goto: "av", title: `Video ${id}`, pic: "//i.example/cover.jpg", owner: { mid: 7, name: "UP" }, duration: 123 });

/** Respond using the documented discovery endpoints and their different schemas. */
function discovery(input) {
  const url = new URL(input);
  switch (url.pathname) {
    case "/x/web-interface/nav":
      return response({ wbi_img: { img_url: `https://i.example/${"a".repeat(32)}.png`, sub_url: `https://i.example/${"b".repeat(32)}.png` } });
    case "/x/web-interface/wbi/index/top/feed/rcmd":
      return response({ item: Array.from({ length: 10 }, (_, i) => video(`recommend${i}`)) });
    case "/x/copyright-music-publicity/toplist/all_period":
      return response({ list: { 2026: [{ ID: "100", priod: 231 }, { ID: 9, priod: 7 }], 2025: [{ ID: 11, priod: 9 }] } });
    case "/x/copyright-music-publicity/toplist/music_list":
      assert.equal(url.searchParams.get("list_id"), "100");
      return response({ list: [{ creation_bvid: "BVchart", creation_title: "Chart song", creation_cover: "//i.example/chart.jpg", creation_up: 123, creation_nickname: "Singer", creation_duration: 211 }] });
    case "/x/web-interface/ranking/v2":
      assert.equal(url.searchParams.get("rid"), "1003");
      return response({ list: [video("rank")] });
    case "/x/frontend/finger/spi":
      return response({ b_3: "visitor-id", b_4: "visitor/four" });
    case "/x/web-interface/region/feed/rcmd":
      assert.equal(url.searchParams.get("from_region"), "1003");
      return response({ archives: [video("fresh"), video("fresh"), { ...video("ad"), goto: "ad" }, { title: "no ID" }, video(`page${url.searchParams.get("display_id")}`)] });
    default:
      throw new Error(`Unexpected ${url.pathname}`);
  }
}

test("home exposes four playable sections and latest weekly chart metadata", async () => {
  await withPlugin(discovery, async (plugin) => {
    const home = await plugin.home();
    assert.equal(home.sections.length, 4);
    assert.equal(home.sections[0].tracks.length, 6);
    assert.ok(home.sections.every((section) => section.trackLayout === "videos" && section.morePage));
    const chart = await plugin.browse({ page: "chart" });
    assert.equal(chart.subtitle, "Week 231");
    const track = chart.sections[0].tracks[0];
    assert.equal(track.name, "Chart song");
    assert.equal(track.duration, 211000);
    assert.equal(track.artists[0].id, "123");
    assert.equal(track.album.imageUrl, "https://i.example/chart.jpg");
  });
});

test("fresh pages deduplicate videos and use visitor cookies without enabling a signed-out account", async () => {
  const session = { active: false, cookie: "SESSDATA=disabled-session" };
  const storage = new Map([["session", session]]);
  let visits = 0;
  const seenPages = [];
  await withPlugin((input, options) => {
    const url = new URL(input);
    assert.ok(!String(options.headers.Cookie).includes("disabled-session"));
    if (url.pathname === "/x/frontend/finger/spi") visits++;
    if (url.pathname === "/x/web-interface/region/feed/rcmd") {
      assert.match(options.headers.Cookie, /buvid3=visitor-id/);
      assert.match(options.headers.Cookie, /buvid4=visitor%2Ffour/);
      assert.equal(options.headers.Origin, "https://www.bilibili.com");
      seenPages.push(url.searchParams.get("display_id"));
    }
    return discovery(input);
  }, async (plugin) => {
    const fresh = await plugin.browse({ page: "fresh" });
    assert.deepEqual(fresh.sections[0].tracks.map((track) => track.id), ["BVfresh", "BVpage1", "BVpage2"]);
    assert.equal(visits, 1);
    assert.deepEqual(seenPages, ["1", "2"]);
    assert.deepEqual(storage.get("session"), session);
  }, storage);
});

test("one failed region keeps the other regions available; all failed requests surface a retryable error", async () => {
  await withPlugin((input) => {
    if (new URL(input).pathname === "/x/web-interface/ranking/v2") throw new Error("offline");
    return discovery(input);
  }, async (plugin) => {
    const home = await plugin.home();
    assert.ok(home.sections[0].tracks.length);
    assert.equal(home.sections[2].tracks.length, 0);
    assert.match(home.sections[2].empty, /Refresh/);
  });
  await withPlugin(() => { throw new Error("offline"); }, async (plugin) => {
    await assert.rejects(plugin.home(), /try again later/);
  });
});
