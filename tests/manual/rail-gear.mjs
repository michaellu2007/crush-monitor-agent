// 视觉验收:左栏模型齿轮 + 点击直开模型设置
import { chromium } from "@playwright/test";
const browser = await chromium.launch({ channel: "chrome" });
const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await p.goto("http://127.0.0.1:3199/");
await p.waitForTimeout(2500);
await p.getByRole("button", { name: "模型设置" }).click();
await p.waitForTimeout(800);
await p.screenshot({ path: "tests/manual/rail-gear.png" });
const title = await p.locator(".ms-name").textContent();
console.log("直开成功,面板:", title);
await browser.close();
