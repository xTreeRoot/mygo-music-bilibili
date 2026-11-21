const apiOrigin = "https://api.bilibili.com";
const siteOrigin = "https://www.bilibili.com";
const passportOrigin = "https://passport.bilibili.com";
const loginCookieNames = ["SESSDATA", "DedeUserID", "DedeUserID__ckMd5", "bili_jct", "sid"];
const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36";
const wbiOrder = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

const platformStrategies = new Map();
let currentPlatformId = "bilibili";

/** Register one isolated platform implementation for MyGo's source adapter. */
function registerPlatformStrategy(strategy) {
  if (!strategy?.id || platformStrategies.has(strategy.id)) {
    throw new Error("A platform strategy needs a unique id.");
  }
  platformStrategies.set(strategy.id, strategy);
}

/** Resolve the selected strategy without branching in MyGo capability exports. */
function activePlatformStrategy() {
  const strategy = platformStrategies.get(currentPlatformId);
  if (!strategy) throw new Error(`Platform ${currentPlatformId} is unavailable.`);
  return strategy;
}

const fail = (code, message) => Object.assign(new Error(message), { code });
const signedOut = () => fail("signIn", host.t("Sign in to Bilibili to continue."));
const text = (value) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const number = (value, fallback = 0) => {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
};
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const array = (value) => (Array.isArray(value) ? value : []);
const bvidOf = (value) => text(value).match(/BV[\da-zA-Z]+/)?.[0] ?? "";
const requestHeaders = () => ({
  Referer: `${siteOrigin}/`,
  "User-Agent": userAgent,
});

function durationMilliseconds(value) {
  if (typeof value === "number") return Math.max(0, Math.round(value * 1000));
  const parts = text(value)
    .split(":")
    .map((part) => (/^\d+$/.test(part) ? Number(part) : NaN));
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return 0;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Math.max(0, Math.round(seconds * 1000));
}

function wbiQuery(parameters, key) {
  const values = { ...parameters, wts: String(Math.floor(Date.now() / 1000)) };
  const query = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([name, value]) =>
        `${encodeURIComponent(name)}=${encodeURIComponent(String(value).replace(/[!'()*]/g, ""))}`,
    )
    .join("&");
  return `${query}&w_rid=${host.crypto.md5(`${query}${key}`)}`;
}

function signedSubtitleUrl(value) {
  const url = new URL(value.startsWith("//") ? `https:${value}` : value);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".hdslb.com")
  ) {
    throw new Error("Bilibili returned an unsupported subtitle address.");
  }
  return url.toString();
}

function loginCookie(response, value) {
  const values = new Map();
  for (const header of response.headers?.getSetCookie?.() ?? []) {
    const cookie = header.split(";", 1)[0];
    const separator = cookie.indexOf("=");
    if (separator > 0 && loginCookieNames.includes(cookie.slice(0, separator))) {
      const content = cookie.slice(separator + 1);
      if (/[\r\n\x00]/.test(content)) throw fail("invalid", host.t("Bilibili returned an invalid session cookie."));
      values.set(cookie.slice(0, separator), content);
    }
  }
  // Like Zhuoqi, trust session cookies from the HTTPS passport response, not its navigation target.
  const hasSession = ["SESSDATA", "DedeUserID", "bili_jct"].every((name) => values.get(name));
  if (value && !hasSession) {
    const callback = new URL(value);
    const validCallback = callback.hostname === "www.bilibili.com" ||
      (callback.hostname === "passport.biligame.com" && callback.pathname === "/crossDomain");
    if (callback.protocol !== "https:" || !validCallback) {
      throw new Error(host.t("Bilibili returned an unsupported login callback."));
    }
    for (const name of loginCookieNames) {
      const content = callback.searchParams.get(name);
      if (content && /[;\r\n\x00]/.test(content)) throw fail("invalid", host.t("Bilibili returned an invalid session cookie."));
      if (content && !values.has(name)) values.set(name, content);
    }
  }
  if (!values.get("SESSDATA") || !values.get("DedeUserID") || !values.get("bili_jct")) {
    throw new Error("Bilibili QR login did not return a complete session.");
  }
  return [...values].map(([name, content]) => `${name}=${content}`).join("; ");
}

/** Wait between passport requests and stop immediately when the dialog is cancelled. */
function waitForLoginPoll(signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => {
      clearTimeout(timer);
      reject(new Error(host.t("Sign-in cancelled.")));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, 2000);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

function mapVideo(data) {
  const bvid = bvidOf(data.bvid ?? data.bv_id);
  if (!bvid) return undefined;
  const owner = object(data.owner ?? data.upper);
  const authorName = text(owner.name ?? owner.uname ?? data.author);
  const authorId = text(owner.mid ?? data.mid ?? data.author_id);
  const section = text(data.tname ?? data.tname_v2?.name);
  const duration = durationMilliseconds(data.duration);
  return {
    id: bvid,
    video: { width: number(data.dimension?.width), height: number(data.dimension?.height) },
    name: text(data.title) || bvid,
    artists: authorName ? [{ id: authorId, name: authorName, imageUrl: imageURL(owner.face) }] : [],
    album: {
      id: section || "bilibili",
      name: section || host.t("Bilibili videos"),
      imageUrl: imageURL(data.pic || data.cover),
    },
    duration,
    url: `${siteOrigin}/video/${bvid}/`,
  };
}

/** Normalize the image addresses Bilibili returns, including scheme-relative covers. */
function imageURL(value) {
  const address = text(value);
  return address.startsWith("//") ? `https:${address}` : address.replace(/^http:\/\//i, "https://");
}

function mapComment(data) {
  const member = object(data.member);
  const content = object(data.content);
  const id = text(data.rpid_str ?? data.rpid);
  if (!id) return undefined;
  return {
    id,
    author: text(member.uname) || id,
    avatarUrl: text(member.avatar),
    text: text(content.message),
    time: Math.round(number(data.ctime) * 1000),
    likes: number(data.like),
  };
}

function randomDmToken() {
  const characters = "ABCDEFGHIJK";
  const first = Math.floor(Math.random() * characters.length);
  let second = Math.floor(Math.random() * characters.length);
  while (second === first) second = Math.floor(Math.random() * characters.length);
  return characters[first] + characters[second];
}

// The host copies only this plugin's legacy local storage. Format conversion
// belongs to the plugin, so no Bilibili account logic stays in the app.
function transferableCookie(value, accountID) {
  const fields = new Map();
  for (const part of text(value).split(";")) {
    const match = part.trim().match(/^(SESSDATA|DedeUserID|bili_jct)=([!-~]+)$/);
    if (!match) continue;
    if (fields.has(match[1])) return "";
    fields.set(match[1], match[2]);
  }
  if (fields.size !== 3 || fields.get("DedeUserID") !== accountID || !/^[1-9]\d*$/.test(accountID)) return "";
  return ["SESSDATA", "DedeUserID", "bili_jct"].map((name) => `${name}=${fields.get(name)}`).join("; ");
}

function savedSession() {
  const current = object(host.storage.get("session"));
  if (typeof current.cookie === "string") return current;
  const legacy = object(host.storage.get("legacy.preferences") ?? object(host.storage.get("legacy")).preferences);
  if (typeof legacy.cookie !== "string" || !legacy.cookie) return {};
  const migrated = { cookie: legacy.cookie, active: legacy.enabled === true };
  host.storage.set("session", migrated);
  return migrated;
}

// Some transports cannot abort an already delivered response body. Settle the
// login immediately and ignore a late result instead of reviving the account.
function loginWait(operation, signal) {
  if (!signal) return Promise.resolve(operation);
  return new Promise((resolve, reject) => {
    const cancel = () => reject(fail("canceled", host.t("Sign-in cancelled.")));
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve(operation).then(value => {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) cancel(); else resolve(value);
    }, error => { signal.removeEventListener("abort", cancel); reject(error); });
  });
}

async function loginFetch(address, options) {
  const signal = options.signal;
  signal?.throwIfAborted();
  const response = await loginWait(fetch(address, options), signal);
  return { ok: response.ok, status: response.status, headers: response.headers,
    json: () => loginWait(response.json(), signal) };
}

class BilibiliPlatformStrategy {
  id = "bilibili";
  session = savedSession();
  cookie = this.session.active === true ? text(this.session.cookie) : "";
  accountSnapshot = null;
  wbiKey = "";
  details = new Map();
  historyCursors = new Map();
  folderMetadata = new Map();
  likedState = new Map();
  loginAttempt = null;
  visitorRequest = null;

  headers() {
    return { ...requestHeaders(), ...(this.cookie ? { Cookie: this.cookie } : {}) };
  }

  async response(response, label, allowSignedOut = false, cookie = this.cookie) {
    if (!response.ok) throw new Error(`Bilibili ${label} returned HTTP ${response.status}.`);
    const result = await response.json();
    if (allowSignedOut && result.code === -101) return object(result.data);
    if (result.code === -101) {
      this.forgetSession(cookie);
      throw signedOut();
    }
    if (result.code !== 0) {
      throw new Error(`Bilibili ${number(result.code)}: ${text(result.message) || label} failed.`);
    }
    return object(result.data);
  }

  async request(path, params = {}, options = {}) {
    const query = options.wbi
      ? wbiQuery(params, await this.getWbiKey())
      : new URLSearchParams(params).toString();
    const discovery = options.visitor ? await this.discoveryHeaders() : {};
    const cookie = this.cookie;
    const response = await fetch(`${apiOrigin}${path}${query ? `?${query}` : ""}`, {
      method: options.body ? "POST" : "GET",
      headers: {
        ...this.headers(),
        ...discovery,
        ...(options.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: options.body,
    });
    return this.response(response, path, options.allowSignedOut === true, cookie);
  }

  async getWbiKey() {
    if (this.wbiKey) return this.wbiKey;
    const nav = await this.request("/x/web-interface/nav", {}, { allowSignedOut: true });
    const images = object(nav.wbi_img);
    const source = [images.img_url, images.sub_url]
      .map((value) => text(value).split("/").at(-1)?.split(".")[0] ?? "")
      .join("");
    this.wbiKey = wbiOrder.map((index) => source[index] ?? "").join("").slice(0, 32);
    if (this.wbiKey.length !== 32) throw new Error("Bilibili did not return valid WBI signing keys.");
    return this.wbiKey;
  }

  // Validate a candidate without enabling it for unrelated requests.
  async checkCookie(cookie, signal) {
    const response = await loginFetch(`${apiOrigin}/x/web-interface/nav`, {
      headers: { ...requestHeaders(), Cookie: cookie }, signal,
    });
    const data = await this.response(response, "/x/web-interface/nav", true);
    if (data.isLogin !== true || !text(data.mid)) {
      return null;
    }
    const expected = cookie.match(/(?:^|;\s*)DedeUserID=([^;]+)/)?.[1];
    if (expected && expected !== text(data.mid)) throw fail("invalid", host.t("Bilibili returned an inconsistent account identity."));
    return {
      id: text(data.mid),
      name: text(data.uname) || text(data.mid),
      imageUrl: imageURL(data.face),
      page: "personal",
    };
  }

  async accountInfo() {
    const cookie = this.cookie;
    if (!cookie) return null;
    const account = await this.checkCookie(cookie);
    if (this.cookie !== cookie) return null;
    if (!account) this.forgetSession(cookie);
    this.accountSnapshot = account;
    return account;
  }

  exportSession() {
    const account = this.accountSnapshot;
    const cookie = account && transferableCookie(this.cookie, account.id);
    return cookie ? { format: 1, account_id: account.id, account_label: account.name, session: { cookie } } : null;
  }

  async validateSession(input) {
    if (input.format !== 1 || text(this.session.cookie) || this.loginAttempt) return null;
    const cookie = transferableCookie(input.session?.cookie, input.account_id);
    if (!cookie) return null;
    try {
      const account = await this.checkCookie(cookie);
      return account?.id === input.account_id ? account : null;
    } catch (error) {
      if (error?.code === "invalid") return null;
      throw error;
    }
  }

  commitSession(input) {
    if (input.format !== 1 || text(this.session.cookie) || this.loginAttempt || input.account?.id !== input.account_id) return null;
    const cookie = transferableCookie(input.session?.cookie, input.account_id);
    if (!cookie) return null;
    this.rememberSession(cookie, true);
    this.cookie = cookie;
    this.accountSnapshot = input.account;
    return input.account;
  }

  rememberSession(cookie, active) {
    const session = { cookie, active };
    host.storage.set("session", session);
    this.session = session;
  }

  // Expiry deactivates a matching account; no request deletes saved credentials.
  forgetSession(cookie) {
    if (this.cookie === cookie) this.resetAccount();
    if (text(this.session.cookie) === cookie) {
      this.rememberSession(cookie, false);
    }
  }

  async requireAccount() {
    const account = await this.accountInfo();
    if (!account) throw signedOut();
    return account;
  }

  async signIn() {
    this.cancelSignIn();
    this.resetAccount();
    const attempt = new AbortController();
    this.loginAttempt = attempt;
    try {
      const signal = attempt.signal;
      let cookie = text(this.session.cookie);
      let account = cookie ? await this.checkCookie(cookie, signal) : null;
      signal.throwIfAborted();
      if (!account) {
        if (cookie) this.forgetSession(cookie);
        ({ cookie, account } = await this.scanLogin(signal));
      }
      signal.throwIfAborted();
      this.rememberSession(cookie, true);
      this.cookie = cookie;
      this.accountSnapshot = account;
      return account;
    } finally {
      if (this.loginAttempt === attempt) this.loginAttempt = null;
    }
  }

  cancelSignIn() {
    this.loginAttempt?.abort();
    this.loginAttempt = null;
  }

  async scanLogin(signal) {
    let qr = await this.newLoginQRCode(signal);
    let shownStatus = null;
    const showStatus = (status, message) => {
      if (shownStatus === status) return;
      shownStatus = status;
      host.signInPrompt({ qr: qr.url, text: host.t(message) });
    };
    showStatus(86101, "Scan this QR code with the Bilibili app.");
    const deadline = Date.now() + 280000;
    while (Date.now() < deadline) {
      await waitForLoginPoll(signal);
      const query = new URLSearchParams({ qrcode_key: qr.key });
      const response = await loginFetch(
        `${passportOrigin}/x/passport-login/web/qrcode/poll?${query}`,
        { headers: requestHeaders(), signal },
      );
      if (!response.ok) throw new Error(`Bilibili QR login returned HTTP ${response.status}.`);
      const result = object(await response.json());
      const data = object(result.data);
      if (result.code !== 0 || typeof data.code !== "number") {
        throw new Error(`Bilibili QR login: ${text(result.message) || "request failed."}`);
      }
      signal.throwIfAborted();
      switch (data.code) {
        case 86101:
          showStatus(86101, "Scan this QR code with the Bilibili app.");
          break;
        case 86090:
          showStatus(86090, "Confirm the login in the Bilibili app.");
          break;
        case 86038:
          qr = await this.newLoginQRCode(signal);
          shownStatus = null;
          showStatus(86038, "The QR code expired. Scan the new code with the Bilibili app.");
          break;
        case 0:
          const cookie = loginCookie(response, text(data.url));
          const account = await this.checkCookie(cookie, signal);
          signal.throwIfAborted();
          if (!account) throw signedOut();
          return { cookie, account };
        default:
          throw new Error(`Bilibili QR login: ${text(data.message) || "unknown login status."}`);
      }
    }
    throw new Error(host.t("Signing in took too long. Try again."));
  }

  async newLoginQRCode(signal) {
    const response = await loginFetch(
      `${passportOrigin}/x/passport-login/web/qrcode/generate`,
      { headers: requestHeaders(), signal },
    );
    if (!response.ok) throw new Error(`Bilibili QR code returned HTTP ${response.status}.`);
    const result = object(await response.json());
    const data = object(result.data);
    if (result.code !== 0 || !text(data.url) || !text(data.qrcode_key)) {
      throw new Error(`Bilibili QR code: ${text(result.message) || "could not be created."}`);
    }
    const link = new URL(text(data.url));
    if (link.protocol !== "https:" || !["account.bilibili.com", "passport.bilibili.com"].includes(link.hostname) || link.username || link.password) {
      throw fail("invalid", host.t("Bilibili returned an unsupported sign-in QR address."));
    }
    return { url: link.toString(), key: text(data.qrcode_key) };
  }

  signOut() {
    this.cancelSignIn();
    this.resetAccount();
    this.rememberSession(text(this.session.cookie), false);
  }

  resetAccount() {
    this.cookie = "";
    this.accountSnapshot = null;
    this.wbiKey = "";
    this.details.clear();
    this.historyCursors.clear();
    this.folderMetadata.clear();
    this.likedState.clear();
  }

  async detail(id) {
    const bvid = bvidOf(id);
    if (!bvid) throw fail("unavailable", "This Bilibili video ID is invalid.");
    const cached = this.details.get(bvid);
    if (cached?.cid && cached?.aid) return cached;
    const data = await this.request("/x/web-interface/view", { bvid });
    if (!text(data.cid) || !text(data.aid)) {
      throw fail("unavailable", "Bilibili did not return this video's playback IDs.");
    }
    this.details.set(bvid, data);
    return data;
  }

  async tracksFrom(items) {
    const tracks = [];
    const seen = new Set();
    for (const item of array(items)) {
      const track = mapVideo(item);
      if (track && !seen.has(track.id)) {
        seen.add(track.id);
        tracks.push(track);
        this.details.set(track.id, { ...object(this.details.get(track.id)), ...item });
      }
    }
    return tracks;
  }

  /** Public discovery requests need the website's visitor identity as well as any active login. */
  async discoveryHeaders() {
    let visitor = text(host.storage.get("visitor"));
    if (!visitor) {
      if (!this.visitorRequest) {
        this.visitorRequest = this.request("/x/frontend/finger/spi").then((data) => {
          if (!text(data.b_3)) return "";
          const value = `buvid3=${text(data.b_3)}; buvid4=${encodeURIComponent(text(data.b_4))}; b_nut=${Math.floor(Date.now() / 1000)}`;
          host.storage.set("visitor", value);
          return value;
        }).finally(() => { this.visitorRequest = null; });
      }
      visitor = await this.visitorRequest;
    }
    const cookie = [visitor, this.cookie].filter(Boolean).join("; ");
    return { Origin: siteOrigin, ...(cookie ? { Cookie: cookie } : {}) };
  }

  async recommended() {
    const data = await this.request("/x/web-interface/wbi/index/top/feed/rcmd", {}, { wbi: true });
    return this.tracksFrom(array(data.item).filter((item) => item.goto === "av" && bvidOf(item.bvid)));
  }

  /** Choose the newest available period by numeric ID, independent of response ordering. */
  async musicChart() {
    const data = await this.request("/x/copyright-music-publicity/toplist/all_period", { list_type: "1" });
    const periods = Object.values(object(data.list)).flatMap((group) => array(group));
    const latest = periods.reduce((best, period) => number(period.ID) > number(best?.ID) ? period : best, null);
    if (!latest) return { tracks: [], period: 0 };
    const songs = await this.request("/x/copyright-music-publicity/toplist/music_list", { list_id: String(latest.ID) });
    const tracks = await this.tracksFrom(array(songs.list).map((song) => ({
      bvid: song.creation_bvid,
      title: song.creation_title,
      pic: song.creation_cover,
      owner: { mid: song.creation_up, name: song.creation_nickname },
      duration: song.creation_duration,
    })));
    return { tracks, period: number(latest.priod) };
  }

  async musicRank() {
    const data = await this.request("/x/web-interface/ranking/v2", { rid: "1003", type: "all" });
    return this.tracksFrom(data.list);
  }

  async musicFresh(pages = 1) {
    const items = [];
    for (let page = 1; page <= pages; page++) {
      const data = await this.request("/x/web-interface/region/feed/rcmd", {
        display_id: String(page), request_cnt: "20", from_region: "1003",
      }, { visitor: true });
      items.push(...array(data.archives).filter((item) => !item.goto || item.goto === "av"));
    }
    return this.tracksFrom(items);
  }

  async home() {
    const results = await Promise.allSettled([
      this.recommended(), this.musicChart(), this.musicRank(), this.musicFresh(),
    ]);
    const names = ["Recommended for you", "Bilibili Music Chart", "Trending in Music", "New in Music"];
    const pages = ["recommended", "chart", "rank", "fresh"];
    const sections = results.map((result, index) => {
      const value = result.status === "fulfilled" ? result.value : null;
      const tracks = index === 1 ? value?.tracks ?? [] : value ?? [];
      return {
        title: host.t(names[index]),
        tracks: tracks.slice(0, 6),
        trackLayout: "videos",
        morePage: pages[index],
        empty: host.t(result.status === "rejected" ? "Couldn't load this section. Refresh to try again." : "No videos available."),
      };
    });
    if (!sections.some((section) => section.tracks.length)) {
      throw new Error(host.t("Bilibili didn't answer: try again later"));
    }
    return { title: host.t("Home"), sections };
  }

  async discoveryPage(page) {
    const titles = { recommended: "Recommended for you", chart: "Bilibili Music Chart", rank: "Trending in Music", fresh: "New in Music" };
    let tracks;
    let subtitle;
    if (page === "chart") {
      const chart = await this.musicChart();
      tracks = chart.tracks;
      subtitle = chart.period ? host.t("Week %d").replace("%d", String(chart.period)) : undefined;
    } else {
      tracks = await (page === "rank" ? this.musicRank() : page === "fresh" ? this.musicFresh(2) : this.recommended());
    }
    return { title: host.t(titles[page]), subtitle, sections: [{ tracks, trackLayout: "videos", empty: host.t("No videos available.") }] };
  }

  async search({ query, kind, offset }) {
    if (!text(query).trim() || kind !== "tracks") return { tracks: [], more: false };
    const page = Math.floor(Math.max(0, number(offset)) / 20) + 1;
    const data = await this.request(
      "/x/web-interface/wbi/search/type",
      { keyword: query, search_type: "video", page: String(page), page_size: "20", order: "totalrank" },
      { wbi: true },
    );
    const tracks = await this.tracksFrom(data.result);
    return { tracks, more: page < number(data.numPages) };
  }

  async browse({ page }) {
    if (["recommended", "chart", "rank", "fresh"].includes(page)) return this.discoveryPage(page);
    if (page === "personal") return this.personalPage();
    if (page === "favorites") return this.favoritesPage();
    if (page === "history" || /^history:\d+$/.test(page)) return this.historyPage(page);
    if (page === "following" || /^following:\d+$/.test(page)) return this.followingPage(page);
    const userPage = page.match(/^user:(\d+)(?::(\d+))?$/);
    if (userPage) return this.userPage(userPage[1], Number(userPage[2] ?? 1));
    const folderPage = page.match(/^folder:(\d+)(?::(\d+))?$/);
    if (folderPage) return this.folderPage(folderPage[1], Number(folderPage[2] ?? 1));
    throw fail("unavailable", "This Bilibili page is unavailable.");
  }

  async personalPage() {
    const account = await this.requireAccount();
    return {
      title: account.name,
      imageUrl: account.imageUrl,
      sections: [{
        title: host.t("Your Bilibili account"),
        links: [
          { title: host.t("Favorites"), page: "favorites" },
          { title: host.t("Watch History"), page: "history" },
          { title: host.t("Following"), page: "following" },
        ],
      }],
    };
  }

  async playlists() {
    const account = await this.accountInfo();
    if (!account) return [];
    const data = await this.request("/x/v3/fav/folder/created/list-all", { up_mid: account.id });
    if (!Array.isArray(data.list) && number(data.count) !== 0) {
      throw new Error("Bilibili did not return the account's favorite folders.");
    }
    const folders = array(data.list);
    const enriched = [];
    // The list-all endpoint omits covers; read lightweight folder metadata in bounded batches.
    for (let start = 0; start < folders.length; start += 4) {
      const batch = await Promise.all(folders.slice(start, start + 4).map(async (folder) => {
        const id = text(folder.id);
        const cached = this.folderMetadata.get(id);
        if (cached && Date.now() - cached.at < 60000) return { ...folder, ...cached.data };
        try {
          const metadata = await this.request("/x/v3/fav/folder/info", { media_id: id });
          this.folderMetadata.set(id, { data: metadata, at: Date.now() });
          return { ...folder, ...metadata };
        } catch (error) {
          if (error.code === "signIn") throw error;
          console.warn(`Bilibili favorite folder ${id}: ${error.message}`);
          return folder;
        }
      }));
      enriched.push(...batch);
    }
    return enriched.map((folder) => ({
      id: text(folder.id),
      name: text(folder.title) || text(folder.id),
      imageUrl: imageURL(folder.cover),
      description: text(folder.intro),
      trackCount: number(folder.media_count),
      mine: true,
      fixed: false,
    }));
  }

  async favoritesPage() {
    const playlists = await this.playlists();
    return {
      title: host.t("Favorites"),
      sections: [{
        title: host.t("Playlists"),
        links: playlists.map((playlist) => ({
          title: playlist.name,
          subtitle: String(playlist.trackCount),
          imageUrl: playlist.imageUrl,
          page: `folder:${playlist.id}`,
        })),
      }],
    };
  }

  async playlist({ id }) {
    return this.folderContents(id, 1);
  }

  async folderContents(id, page) {
    const folderId = text(id).match(/^\d+$/)?.[0];
    if (!folderId) throw fail("unavailable", "This Bilibili favorite folder ID is invalid.");
    const data = await this.request("/x/v3/fav/resource/list", {
      media_id: folderId,
      pn: String(page),
      ps: "20",
      keyword: "",
      order: "mtime",
      type: "0",
      tid: "0",
      platform: "web",
    });
    const metadata = object(data.info);
    return {
      id: text(metadata.id ?? folderId),
      name: text(metadata.title) || folderId,
      imageUrl: imageURL(metadata.cover),
      description: text(metadata.intro),
      owner: text(metadata.upper?.name),
      trackCount: number(metadata.media_count),
      mine: true,
      more: data.has_more === true || data.has_more === 1,
      tracks: await this.tracksFrom(data.medias),
    };
  }

  async folderPage(id, page) {
    if (!Number.isSafeInteger(page) || page < 1) {
      throw fail("unavailable", "This Bilibili favorite page is invalid.");
    }
    const folder = await this.folderContents(id, page);
    return {
      title: folder.name,
      sections: [{
        title: host.t("Videos"),
        tracks: folder.tracks,
        ...(folder.more ? { morePage: `folder:${id}:${page + 1}` } : {}),
      }],
    };
  }

  async liked({ offset }) {
    const account = await this.requireAccount();
    if (number(offset) > 0) return { tracks: [], more: false };
    const data = await this.request("/x/space/like/video", { vmid: account.id });
    if (!Array.isArray(data.list)) throw new Error("Bilibili did not return the liked-video list.");
    return { tracks: await this.tracksFrom(data.list), more: false };
  }

  async historyPage(page) {
    const account = await this.requireAccount();
    const pageNumber = page === "history" ? 1 : Number(page.slice("history:".length));
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
      throw fail("unavailable", "This Bilibili history page is invalid.");
    }
    const cursor = pageNumber === 1 ? {} : this.historyCursors.get(pageNumber);
    if (pageNumber > 1 && !cursor) throw fail("unavailable", "Load the previous history page first.");
    const data = await this.request("/x/web-interface/history/cursor", {
      type: "all",
      ps: "20",
      ...cursor,
    });
    if (!Array.isArray(data.list)) throw new Error("Bilibili did not return the watch-history list.");
    const tracks = await this.tracksFrom(data.list.map((item) => {
      const history = object(item.history);
      return {
        ...item,
        bvid: history.bvid,
        aid: history.oid,
        pic: item.cover,
        owner: { mid: item.author_mid, name: item.author_name },
        duration: history.duration ?? item.duration,
      };
    }));
    const next = object(data.cursor);
    const nextMax = text(next.max);
    const more = tracks.length > 0 && !!nextMax && nextMax !== "0";
    if (more) {
      this.historyCursors.set(pageNumber + 1, {
        max: nextMax,
        view_at: text(next.view_at),
        business: text(next.business),
      });
    }
    return {
      title: host.t("Watch History"),
      sections: [{ title: host.t("Videos"), tracks }],
      ...(more ? { sections: [{ title: host.t("Videos"), tracks, morePage: `history:${pageNumber + 1}` }] } : {}),
      imageUrl: account.imageUrl,
    };
  }

  async followingPage(page) {
    const account = await this.requireAccount();
    const pageNumber = page === "following" ? 1 : Number(page.slice("following:".length));
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
      throw fail("unavailable", "This Bilibili following page is invalid.");
    }
    const data = await this.request("/x/relation/followings", {
      vmid: account.id,
      ps: "20",
      pn: String(pageNumber),
      order: "desc",
      order_type: "",
    });
    if (!Array.isArray(data.list)) throw new Error("Bilibili did not return the following list.");
    const people = array(data.list).map((person) => ({
      title: text(person.uname) || text(person.mid),
      subtitle: text(person.sign),
      imageUrl: imageURL(person.face),
      page: `user:${text(person.mid)}`,
    }));
    const more = pageNumber * 20 < number(data.total);
    return {
      title: host.t("Following"),
      imageUrl: account.imageUrl,
      sections: [{
        title: host.t("People you follow"),
        links: people,
        ...(more ? { morePage: `following:${pageNumber + 1}` } : {}),
      }],
    };
  }

  async userPage(mid, page) {
    if (!Number.isSafeInteger(page) || page < 1) {
      throw fail("unavailable", "This Bilibili user page is invalid.");
    }
    const profile = await this.request("/x/space/wbi/acc/info", { mid }, { wbi: true });
    let followers = "";
    try {
      const relation = await this.request("/x/relation/stat", { vmid: mid });
      followers = String(number(relation.follower));
    } catch {}
    const works = await this.userWorks(mid, page);
    return {
      title: text(profile.name) || mid,
      subtitle: followers,
      imageUrl: imageURL(profile.face),
      description: text(profile.sign),
      sections: [{
        title: host.t("Videos"),
        tracks: works.tracks,
        ...(works.more ? { morePage: `user:${mid}:${page + 1}` } : {}),
      }],
    };
  }

  async userWorks(mid, page) {
    const data = await this.request(
      "/x/space/wbi/arc/search",
      {
        mid,
        order: "pubdate",
        ps: "25",
        pn: String(page),
        index: "1",
        order_avoided: "true",
        platform: "web",
        web_location: "333.1387",
        dm_img_list: "[]",
        dm_img_str: "V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ",
        dm_cover_img_str: "",
        dm_img_inter: "{}",
      },
      { wbi: true },
    );
    const list = array(object(data.list).vlist);
    const total = number(object(data.page).count);
    return { tracks: await this.tracksFrom(list), more: page * 25 < total };
  }

  async playbackInfo(id) {
    const bvid = bvidOf(id);
    const detail = await this.detail(bvid);
    // Use Zhuoqi's signed playback endpoint; current video pages may omit __playinfo__ entirely.
    const data = await this.request("/x/player/wbi/playurl", {
      bvid, cid: text(detail.cid), qn: "80", fnval: "4048", fnver: "0", fourk: "1",
      gaia_source: "view-card", from_client: "BROWSER", is_main_page: "false",
      need_fragment: "false", isGaiaAvoided: "true", voice_balance: "1", web_location: "1315873",
    }, { wbi: true });
    return { detail, dash: object(data.dash) };
  }

  async stream({ id, quality = "high" }) {
    const { detail, dash } = await this.playbackInfo(id);
    const available = array(dash.audio).filter(audio => text(audio.base_url ?? audio.baseUrl));
    const lowest = [...available].sort((a, b) => number(a.bandwidth, Infinity) - number(b.bandwidth, Infinity))[0];
    const lossless = available.find(audio => /flac/i.test(text(audio.mime_type ?? audio.mimeType)));
    const audio = object((quality === "standard" ? lowest : quality === "lossless" ? lossless : null) ?? available[0]);
    const url = text(audio.base_url ?? audio.baseUrl);
    if (!url) throw fail("noSource", host.t("The video does not have a playable audio track."));
    return {
      url,
      type: /flac/i.test(text(audio.mime_type ?? audio.mimeType)) ? "flac" : text(audio.mime_type ?? audio.mimeType).startsWith("audio/mp4") ? "m4a" : "aac",
      quality: String(audio.id ?? ""),
      headers: requestHeaders(),
      size: number(audio.size),
      backupUrls: array(audio.backup_url ?? audio.backupUrl).map(text).filter(url => /^https?:\/\//.test(url)),
      _cid: text(detail.cid),
    };
  }

  async video({ id }) {
    const { dash } = await this.playbackInfo(id);
    const streams = array(dash.video).filter((stream) => text(stream.base_url ?? stream.baseUrl));
    // AVC is supported by every system media framework used by the app.
    const avc = streams.filter((stream) => number(stream.codecid) === 7 || text(stream.codecs).startsWith("avc1"));
    const video = (avc.length ? avc : streams).sort((a, b) => {
      const score = (stream) => Math.abs(number(stream.height) - 720);
      return score(a) - score(b) || number(a.bandwidth) - number(b.bandwidth);
    })[0];
    if (!video) throw fail("unavailable", host.t("This track has no playable MV."));
    return { url: text(video.base_url ?? video.baseUrl), type: "mp4", headers: requestHeaders(),
      backupUrls: array(video.backup_url ?? video.backupUrl).map(text).filter(url => /^https?:\/\//.test(url)) };
  }

  async lyrics({ id }) {
    const detail = await this.detail(id);
    const data = await this.request(
      "/x/player/wbi/v2",
      {
        aid: text(detail.aid),
        cid: text(detail.cid),
        isGaiaAvoided: "false",
        web_location: "1315873",
      },
      { wbi: true },
    );
    const subtitles = array(object(data.subtitle).subtitles);
    if (!subtitles.length) {
      if (data.need_login_subtitle === true) throw signedOut();
      throw fail("unavailable", host.t("This video has no available subtitles."));
    }
    const sorted = [...subtitles].sort((left, right) => {
      const a = text(left.lan).toLowerCase();
      const b = text(right.lan).toLowerCase();
      return Number(b.startsWith("zh")) - Number(a.startsWith("zh"));
    });
    const subtitleUrl = signedSubtitleUrl(text(sorted[0].subtitle_url));
    const response = await fetch(subtitleUrl, { headers: this.headers() });
    if (!response.ok) throw new Error(`Bilibili subtitle returned HTTP ${response.status}.`);
    const body = object(await response.json());
    const lines = array(body.body).flatMap((line) => {
      const start = number(line.from, NaN);
      const end = number(line.to, NaN);
      const content = text(line.content);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !content) return [];
      return [{ start: Math.round(start * 1000), end: Math.round(end * 1000), text: content }];
    });
    if (!lines.length) throw fail("unavailable", host.t("This video has no available subtitles."));
    return { lines };
  }

  async comments({ trackId, offset }) {
    const detail = await this.detail(trackId);
    const page = Math.floor(Math.max(0, number(offset)) / 20) + 1;
    const data = await this.request("/x/v2/reply", {
      type: "1",
      oid: text(detail.aid),
      pn: String(page),
      ps: "20",
      sort: "2",
    });
    if (data.replies !== null && !Array.isArray(data.replies)) {
      throw new Error("Bilibili did not return the comment list.");
    }
    const pinned = page === 1 ? [data.top?.upper, data.top?.admin].filter(Boolean) : [];
    const byId = new Map();
    for (const item of [...pinned, ...array(data.replies)]) {
      const comment = mapComment(item);
      if (comment) byId.set(comment.id, comment);
    }
    const total = number(object(data.page).count);
    return { comments: [...byId.values()], total, more: page * 20 < total };
  }

  async postComment({ trackId, text: message }) {
    const detail = await this.detail(trackId);
    const csrf = this.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/)?.[1];
    if (!csrf) throw signedOut();
    const dm = randomDmToken();
    const body = new URLSearchParams({
      oid: text(detail.aid),
      type: "1",
      message: text(message),
      plat: "1",
      statistics: JSON.stringify({ appId: 100, platform: 5 }),
      gaia_source: "main_web",
      csrf,
      csrf_token: csrf,
    });
    const params = {
      dm_img_list: "[]",
      dm_img_str: dm,
      dm_cover_img_str: randomDmToken(),
      dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
    };
    const data = await this.request("/x/v2/reply/add", params, {
      wbi: true,
      body,
    });
    const comment = mapComment(object(data.reply));
    if (!comment) throw new Error(host.t("Could not confirm the comment was published. Refresh comments before trying again."));
    return comment;
  }

  async interactionSummary({ trackId }) {
    const detail = await this.detail(trackId);
    const result = {};
    for (const [key, raw] of [["likes", detail.stat?.like], ["comments", detail.stat?.reply]]) {
      if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) result[key] = raw;
    }
    return result;
  }

  async isLiked({ ids }) {
    const out = {};
    if (!this.cookie) return out;
    for (const id of array(ids).slice(0, 40)) {
      const bvid = bvidOf(id);
      if (!bvid) continue;
      if (this.likedState.has(bvid)) {
        out[bvid] = this.likedState.get(bvid);
        continue;
      }
      const detail = await this.detail(bvid);
      const relation = await this.request("/x/web-interface/archive/relation", {
        aid: text(detail.aid),
      });
      out[bvid] = relation.like === true;
      this.likedState.set(bvid, out[bvid]);
    }
    return out;
  }

  async like({ id, on }) {
    const bvid = bvidOf(id);
    const detail = await this.detail(bvid);
    const csrf = this.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/)?.[1];
    if (!csrf) throw signedOut();
    await this.request("/x/web-interface/archive/like", {}, {
      body: new URLSearchParams({
        aid: text(detail.aid),
        like: on ? "1" : "2",
        csrf,
        csrf_token: csrf,
      }),
    });
    this.likedState.set(bvid, Boolean(on));
  }
}

registerPlatformStrategy(new BilibiliPlatformStrategy());

export function signIn() {
  return activePlatformStrategy().signIn();
}

export function signOut() {
  return activePlatformStrategy().signOut();
}

export function cancelSignIn() {
  return activePlatformStrategy().cancelSignIn();
}

export function account() {
  return activePlatformStrategy().accountInfo();
}

export function exportSession() {
  return activePlatformStrategy().exportSession();
}

export function validateSession(input) {
  return activePlatformStrategy().validateSession(input);
}

export function commitSession(input) {
  return activePlatformStrategy().commitSession(input);
}

export function home() {
  return activePlatformStrategy().home();
}

export function browse(input) {
  return activePlatformStrategy().browse(input);
}

export function search(input) {
  return activePlatformStrategy().search(input);
}

export function playlists() {
  return activePlatformStrategy().playlists();
}

export function playlist(input) {
  return activePlatformStrategy().playlist(input);
}

export function liked(input) {
  return activePlatformStrategy().liked(input);
}

export function isLiked(input) {
  return activePlatformStrategy().isLiked(input);
}

export function like(input) {
  return activePlatformStrategy().like(input);
}

export function comments(input) {
  return activePlatformStrategy().comments(input);
}

export function postComment(input) {
  return activePlatformStrategy().postComment(input);
}

export function lyrics(input) {
  return activePlatformStrategy().lyrics(input);
}

export function stream(input) {
  return activePlatformStrategy().stream(input);
}

export function video(input) {
  return activePlatformStrategy().video(input);
}

/** 返回视频公开的点赞和评论总数，不需要读取用户账号。 */
export function interactionSummary(input) {
  return activePlatformStrategy().interactionSummary(input);
}
