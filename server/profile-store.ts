// 画像落盘：data/profiles/<contactId>.json（data/ 整目录已 gitignore）。
// 原子写（tmp+rename），与 model-config.ts 同模式；读失败返回 null 不抛。
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { normalizeProfile, type ContactProfile } from "../shared/profile";

const PROFILES_DIR = join(process.cwd(), "data", "profiles");
const file = (id: string) => join(PROFILES_DIR, encodeURIComponent(id) + ".json");

export function readProfile(contactId: string): ContactProfile | null {
  if (!existsSync(file(contactId))) return null;
  try {
    const raw = JSON.parse(readFileSync(file(contactId), "utf8"));
    return normalizeProfile(raw, contactId);
  } catch {
    return null;
  }
}

/** 规整并落盘；非法输入抛错（路由层转 400）。 */
export function saveProfile(raw: unknown, contactId: string): ContactProfile {
  const profile = normalizeProfile(raw, contactId);
  if (!profile) throw new Error("画像格式不正确");
  mkdirSync(PROFILES_DIR, { recursive: true });
  const temp = `${file(contactId)}.tmp`;
  writeFileSync(temp, JSON.stringify(profile), "utf8");
  renameSync(temp, file(contactId));
  return profile;
}

/** 删除会话时连带清掉对方画像（联系人没了，画像/MBTI 不该留在盘上）——
 * 2026-11-19 bug 审查：此前删除会话不清衍生数据。 */
export function deleteProfile(contactId: string): void {
  if (!contactId || contactId.length > 120) return;
  try {
    if (existsSync(file(contactId))) unlinkSync(file(contactId));
  } catch {
    /* 被占用时跳过，无副作用 */
  }
}


function readdirSafe(): string[] {
  try {
    return readdirSync(PROFILES_DIR);
  } catch {
    return [];
  }
}
