/**
 * NILTO Content API クライアント（サーバー／ビルド時 fetch 用）
 */

/** NILTO GET /contents の limit 上限（公式: 1〜100） */
const NILTO_CONTENTS_LIMIT_MAX = 100;

/** NILTO モデル LUID（日別エントリ＋繰り返し photos） */
const NILTO_MODEL_ALBUM = "album";

let warnedMissingAlbumListUrl = false;

export type TopPageData = {
  _title?: string;
  hamu_name?: string;
  description?: string;
  main_image?: { url?: string; alt?: string } | null;
  skills?: Array<{ skill_name?: string }>;
};

export type PhotoDayRow = {
  image?: { url?: string; alt?: string; width?: unknown; height?: unknown };
  alt?: string;
  /** メディアに width/height が無い場合の縦横ヒント（単一選択の値・表示ラベルどちらでも可） */
  orientation?: string;
};

export type PhotoDayItem = {
  _id?: number | string;
  _title?: string;
  shoot_date?: string;
  photos?: PhotoDayRow[];
};

export type PhotoForAlbum = {
  url: string;
  alt: string;
  /** メディア API が返す実寸があれば一覧の aspect-ratio 予約に使う */
  width?: number;
  height?: number;
  /** `width` / `height` が無いとき `orientation` から付与（CSS 値、例: `3 / 4`） */
  aspectRatioCss?: string;
};

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const n = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function readImageDimensions(img: PhotoDayRow["image"]): { w?: number; h?: number } {
  if (!img || typeof img !== "object") return {};
  const o = img as Record<string, unknown>;
  let w = parsePositiveInt(o.width);
  let h = parsePositiveInt(o.height);
  const meta = o.metadata;
  if ((!w || !h) && meta && typeof meta === "object" && !Array.isArray(meta)) {
    const m = meta as Record<string, unknown>;
    w = w ?? parsePositiveInt(m.width);
    h = h ?? parsePositiveInt(m.height);
  }
  return { w, h };
}

/**
 * NILTO の単一選択や自由入力から CSS aspect-ratio 用の比率文字列を得る。
 * 実寸が取れないときのフォールバック用（完全な一致ではないがレイアウトの乱れを抑える）。
 */
function orientationToAspectRatioCss(orientation: string | undefined): string | undefined {
  const raw = (orientation ?? "").trim();
  if (!raw) return undefined;
  const o = raw.toLowerCase();

  if (["portrait", "縦", "縦長", "たて", "縦向き"].includes(o)) {
    return "3 / 4";
  }
  if (["landscape", "横", "横長", "よこ", "横向き"].includes(o)) {
    return "4 / 3";
  }
  if (["square", "正方形", "スクエア", "1:1", "1：1"].includes(o)) {
    return "1 / 1";
  }

  const ratioMatch = raw.match(/^(\d+)\s*[/:：]\s*(\d+)$/);
  if (ratioMatch) {
    const a = Number.parseInt(ratioMatch[1]!, 10);
    const b = Number.parseInt(ratioMatch[2]!, 10);
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) {
      return `${a} / ${b}`;
    }
  }

  return undefined;
}

/** サムネ枠のインライン style（aspect-ratio のみ）。無ければ undefined。 */
export function albumThumbFrameStyle(p: PhotoForAlbum): string | undefined {
  if (p.width && p.height) return `aspect-ratio: ${p.width} / ${p.height}`;
  if (p.aspectRatioCss) return `aspect-ratio: ${p.aspectRatioCss}`;
  return undefined;
}

export function albumThumbUsesLockedAspect(p: PhotoForAlbum): boolean {
  return albumThumbFrameStyle(p) !== undefined;
}

/**
 * `https://cms-api.nilto.com/v1/contents/123?...` から `https://cms-api.nilto.com/v1` を得る。
 * `NILTO_API_BASE` 未設定でも、トップ用の `NILTO_CONTENT_URL` があれば album 一覧を組み立てられるようにする。
 */
function deriveApiBaseFromContentUrl(contentUrl: string): string | undefined {
  try {
    const u = new URL(contentUrl.trim());
    const segments = u.pathname.split("/").filter(Boolean);
    const contentsIdx = segments.indexOf("contents");
    if (contentsIdx > 0) {
      const prefix = segments.slice(0, contentsIdx).join("/");
      return `${u.origin}/${prefix}`.replace(/\/+$/, "");
    }
  } catch {
    /* 無効な URL */
  }
  return undefined;
}

function apiBase(): string | undefined {
  const fromEnv = (import.meta.env.NILTO_API_BASE as string | undefined)?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");

  const contentUrl = (import.meta.env.NILTO_CONTENT_URL as string | undefined)?.trim();
  if (contentUrl) {
    const derived = deriveApiBaseFromContentUrl(contentUrl);
    if (derived) return derived;
  }

  return undefined;
}

function niltoHeaders(apiKey: string): HeadersInit {
  return { "X-NILTO-API-KEY": apiKey };
}

/** NILTO が `fields` にカスタムフィールドをネストする場合にフラット化 */
function unwrapFields<T extends Record<string, unknown>>(item: T): T {
  const fields = item.fields;
  if (fields && typeof fields === "object" && !Array.isArray(fields)) {
    return { ...item, ...(fields as Record<string, unknown>) } as T;
  }
  return item;
}

function normalizeContentList(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== "object") return [];

  const o = json as Record<string, unknown>;
  const tryArray = (v: unknown): v is unknown[] => Array.isArray(v);

  if (tryArray(o.contents)) return o.contents;
  if (tryArray(o.items)) return o.items;
  if (tryArray(o.results)) return o.results;

  // NILTO 一覧: { total, offset, limit, data: [...] }
  if (tryArray(o.data)) return o.data;

  // data がさらにオブジェクトで包まれる場合
  const nested = o.data;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const d = nested as Record<string, unknown>;
    if (tryArray(d.contents)) return d.contents;
    if (tryArray(d.items)) return d.items;
    if (tryArray(d.data)) return d.data;
  }

  return [];
}

async function niltoJson(url: string, apiKey: string): Promise<unknown> {
  const res = await fetch(url, { headers: niltoHeaders(apiKey) });
  if (!res.ok) {
    const body = await res.text();
    const snippet = body.length > 280 ? `${body.slice(0, 280)}…` : body;
    const hint400 = res.status === 400 ? "（GET /contents の limit は 1〜100）" : "";
    throw new Error(
      `NILTO API エラー: ${res.status} ${res.statusText}${hint400}${snippet ? ` — ${snippet}` : ""}`
    );
  }
  return res.json();
}

function readListTotal(json: unknown): number | undefined {
  if (json && typeof json === "object" && "total" in json) {
    const t = (json as { total: unknown }).total;
    if (typeof t === "number" && Number.isFinite(t)) return t;
  }
  return undefined;
}

/**
 * album 一覧をページングで全件取得（各リクエスト limit ≤ 100）
 */
async function fetchAlbumListAllPaged(
  pageLimit: number,
  buildUrl: (offset: number, limit: number) => string,
  apiKey: string
): Promise<PhotoDayItem[]> {
  const limit = Math.min(Math.max(1, pageLimit), NILTO_CONTENTS_LIMIT_MAX);
  const all: PhotoDayItem[] = [];
  let offset = 0;
  let total: number | undefined;

  while (true) {
    const json = await niltoJson(buildUrl(offset, limit), apiKey);
    if (total === undefined) {
      total = readListTotal(json);
    }
    const batch = normalizeContentList(json).map(normalizePhotoDayItem);
    all.push(...batch);
    if (batch.length === 0) break;
    if (batch.length < limit) break;
    if (total !== undefined && all.length >= total) break;
    offset += limit;
    if (offset > 1_000_000) break;
  }

  return all;
}

/**
 * トップページ用コンテンツを 1 件取得。
 * `NILTO_CONTENT_URL` があればそれを使用。なければ `NILTO_API_BASE` で `model=top_page&limit=1`。
 */
export async function fetchTopPageData(): Promise<Record<string, unknown> | null> {
  const apiKey = import.meta.env.NILTO_API_KEY as string | undefined;
  const contentUrl = import.meta.env.NILTO_CONTENT_URL as string | undefined;
  const base = apiBase();

  if (!apiKey) return null;

  try {
    if (contentUrl) {
      const parsed = await niltoJson(contentUrl, apiKey);
      if (parsed && typeof parsed === "object") {
        return unwrapFields(parsed as Record<string, unknown>);
      }
      return null;
    }

    if (base) {
      const url = `${base}/contents?model=top_page&limit=1`;
      const json = await niltoJson(url, apiKey);
      const list = normalizeContentList(json);
      const first = list[0];
      if (first && typeof first === "object") {
        return unwrapFields(first as Record<string, unknown>);
      }
    }
  } catch (e) {
    console.error("NILTO top_page の取得に失敗しました。", e);
  }

  return null;
}

/**
 * `shoot_date` を `YYYY-MM-DD` に統一（ISO 文字列先頭10文字など）
 */
export function normalizeShootDate(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object" && value !== null && "value" in value) {
    return normalizeShootDate((value as { value: unknown }).value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return normalizeShootDate(new Date(value).toISOString());
  }
  const s = String(value).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s.slice(0, 10);
}

/**
 * 一覧 API で `shoot_date` が欠ける場合があるため `_title`（例: 2026-03-28）も参照する。
 */
export function getItemShootDate(item: PhotoDayItem): string {
  const fromShoot = normalizeShootDate(item.shoot_date);
  if (fromShoot) return fromShoot;
  return normalizeShootDate(item._title);
}

function normalizePhotoDayItem(raw: unknown): PhotoDayItem {
  if (!raw || typeof raw !== "object") return {};
  return unwrapFields(raw as Record<string, unknown>) as PhotoDayItem;
}

/**
 * モデル `album` の一覧を取得。
 * `NILTO_ALBUM_LIST_URL` または `NILTO_PHOTO_DAY_LIST_URL` があれば優先。
 * なければ `${API_BASE}/contents?model=album&limit=...`。
 */
export async function fetchPhotoDayList(): Promise<PhotoDayItem[]> {
  const apiKey = import.meta.env.NILTO_API_KEY as string | undefined;
  const listUrlEnv =
    (import.meta.env.NILTO_ALBUM_LIST_URL as string | undefined) ||
    (import.meta.env.NILTO_PHOTO_DAY_LIST_URL as string | undefined);
  const base = apiBase();

  if (!apiKey) return [];

  const defaultListBase = base ? `${base}/contents` : undefined;

  if (!listUrlEnv && !defaultListBase) {
    if (!warnedMissingAlbumListUrl) {
      warnedMissingAlbumListUrl = true;
      console.warn(
        "album 一覧の取得には NILTO_API_BASE、または NILTO_ALBUM_LIST_URL（互換: NILTO_PHOTO_DAY_LIST_URL）を設定してください。"
      );
    }
    return [];
  }

  try {
    let list: PhotoDayItem[];

    if (listUrlEnv) {
      const u = new URL(listUrlEnv.trim());
      if (!u.searchParams.has("model")) {
        u.searchParams.set("model", NILTO_MODEL_ALBUM);
      }
      let customLimit = Number.parseInt(u.searchParams.get("limit") ?? "", 10);
      if (!Number.isFinite(customLimit) || customLimit < 1) {
        customLimit = NILTO_CONTENTS_LIMIT_MAX;
      }
      const pageLimit = Math.min(customLimit, NILTO_CONTENTS_LIMIT_MAX);
      u.searchParams.set("limit", String(pageLimit));
      u.searchParams.delete("offset");

      list = await fetchAlbumListAllPaged(
        pageLimit,
        (offset, lim) => {
          u.searchParams.set("offset", String(offset));
          u.searchParams.set("limit", String(lim));
          return u.toString();
        },
        apiKey
      );
    } else {
      list = await fetchAlbumListAllPaged(
        NILTO_CONTENTS_LIMIT_MAX,
        (offset, lim) =>
          `${defaultListBase}?model=${encodeURIComponent(NILTO_MODEL_ALBUM)}&limit=${lim}&offset=${offset}`,
        apiKey
      );
    }

    if (import.meta.env.DEV && list.length === 0) {
      console.warn(
        "[NILTO] album 一覧が0件です。モデルLUID・APIキー・スペース設定（必要なら URL に space=）を確認してください。"
      );
    }

    return list;
  } catch (e) {
    console.error("NILTO album 一覧の取得に失敗しました。", e);
    return [];
  }
}

/** 同じ撮影日のエントリをまとめる（複数件あれば写真をマージ可能） */
export function groupPhotoDaysByDate(items: PhotoDayItem[]): Map<string, PhotoDayItem[]> {
  const map = new Map<string, PhotoDayItem[]>();
  for (const item of items) {
    const date = getItemShootDate(item);
    if (!date) continue;
    const arr = map.get(date) ?? [];
    arr.push(item);
    map.set(date, arr);
  }
  return map;
}

export function mergePhotosForDate(items: PhotoDayItem[]): PhotoForAlbum[] {
  const photos: PhotoForAlbum[] = [];
  for (const item of items) {
    const rows = item.photos ?? [];
    for (const row of rows) {
      const img = row.image;
      const url = img?.url?.trim() ?? "";
      if (!url) continue;
      const alt = (row.alt || img?.alt || "ぽこちゃんの写真").trim() || "ぽこちゃんの写真";
      const { w, h } = readImageDimensions(img);
      const aspectRatioCss =
        w && h ? undefined : orientationToAspectRatioCss(row.orientation?.trim() || undefined);

      const entry: PhotoForAlbum = { url, alt };
      if (w && h) {
        entry.width = w;
        entry.height = h;
      }
      if (aspectRatioCss) {
        entry.aspectRatioCss = aspectRatioCss;
      }
      photos.push(entry);
    }
  }
  return photos;
}

/** アルバム用: 日付キー一覧（静的パス生成） */
export function distinctShootDates(items: PhotoDayItem[]): string[] {
  const set = new Set<string>();
  for (const item of items) {
    const d = getItemShootDate(item);
    if (d) set.add(d);
  }
  return [...set].sort();
}

/** `YYYY-MM-DD` を日本語の日付見出し用に整形 */
export function formatJapaneseAlbumHeading(ymd: string): string {
  const seg = ymd.split("-");
  if (seg.length !== 3) return ymd;
  const y = Number.parseInt(seg[0]!, 10);
  const mo = Number.parseInt(seg[1]!, 10);
  const d = Number.parseInt(seg[2]!, 10);
  if (Number.isNaN(y) || Number.isNaN(mo) || Number.isNaN(d)) return ymd;
  const isoDay = `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const dt = new Date(`${isoDay}T12:00:00`);
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(dt);
}
