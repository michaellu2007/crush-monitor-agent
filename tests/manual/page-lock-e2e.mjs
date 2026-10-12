// 一次性验证:双页面互斥(用户报告的两个页面互相覆盖数据场景)
import { chromium } from "@playwright/test";

const url = "http://127.0.0.1:3178/";
const browser = await chromium.launch({ channel: "chrome" });
const p1 = await browser.newPage();
const p2 = await browser.newPage();
await p1.goto(url);
await p2.goto(url);
await p1.waitForTimeout(1500);
await p2.waitForTimeout(1500);

const p1App = await p1.locator("#root textarea, #root button").count();
const p2Blocked = await p2.getByText("应用已在另一个窗口打开").count();
const p2App = await p2.locator("#root textarea, #root button").count();
console.log(`页面1: 应用控件=${p1App} (应>0)`);
console.log(`页面2: 提示文案=${p2Blocked} (应=1), 应用控件=${p2App} (应=0)`);

// 关掉页面1(触发 release),页面2 应在几秒内自动接管
await p1.close();
await p2.waitForSelector("#root button", { timeout: 15000 });
console.log(`页面1 关闭后, 页面2 自动接管: 应用控件=${await p2.locator("#root button").count()} (应>0)`);

// 页面2 持有期间再开页面3,同样应被拦
const p3 = await browser.newPage();
await p3.goto(url);
await p3.waitForTimeout(1000);
console.log(`页面3: 提示文案=${await p3.getByText("应用已在另一个窗口打开").count()} (应=1)`);
await browser.close();
