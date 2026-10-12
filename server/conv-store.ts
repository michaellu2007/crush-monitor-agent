// 会话数据落盘：data/conversations/<id>.json，浏览器关闭/清缓存均不受影响。
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), "data", "conversations");
const META_FILE = join(process.cwd(), "data", "meta.json");

export function initStorage() {
  mkdirSync(DATA_DIR, { recursive: true });
}
const file = (id: string) => join(DATA_DIR, encodeURIComponent(id) + ".json");

export function readConversation(id: string): unknown | undefined {
  if (!existsSync(file(id))) return undefined;
  try {
    return JSON.parse(readFileSync(file(id), "utf8"));
  } catch {
    return undefined;
  }
}
export function writeConversation(id: string, value: unknown | null) {
  if (value === null) {
    if (existsSync(file(id))) unlinkSync(file(id));
    return;
  }
  writeFileSync(file(id), JSON.stringify(value), "utf8");
}
export function listConversationIds(): string[] {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => decodeURIComponent(f.slice(0, -5)));
}
export function getLastConvId(): string | null {
  try {
    if (!existsSync(META_FILE)) return null;
    return JSON.parse(readFileSync(META_FILE, "utf8")).lastConvId ?? null;
  } catch {
    return null;
  }
}
export function setLastConvId(id: string) {
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  writeFileSync(META_FILE, JSON.stringify({ lastConvId: id }), "utf8");
}
