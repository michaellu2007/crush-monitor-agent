// 视觉+行为验收:双栏布局、供应商草稿互不覆盖
import { chromium } from "@playwright/test";
const browser = await chromium.launch({ channel: "chrome" });
const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await p.goto("http://127.0.0.1:3198/");
await p.waitForTimeout(2500);
await p.getByRole("button", { name: "模型设置" }).click();
await p.waitForTimeout(600);
await p.getByRole("button", { name: "硅基流动" }).click();
await p.getByPlaceholder("粘贴这个平台的 API Key").fill("sk-test-draft-123");
await p.getByRole("button", { name: "豆包 · 火山方舟" }).click();
await p.waitForTimeout(300);
await p.getByRole("button", { name: "硅基流动" }).click();
await p.waitForTimeout(300);
const kept = await p.getByPlaceholder("粘贴这个平台的 API Key").inputValue();
console.log(
  "切走再切回,Key 保留:",
  kept === "sk-test-draft-123" ? "✓" : "✗ " + kept,
);
await p.screenshot({ path: "tests/manual/ms-3-draft.png" });
await browser.close();
