import { chromium } from "@playwright/test";
const browser = await chromium.launch({ channel: "chrome" });
const p = await browser.newPage();
await p.goto("http://127.0.0.1:3178/");
await p.waitForTimeout(2500);
const info = await p.evaluate(() => ({
  title: document.title,
  rootChildren: document.getElementById("root")?.children.length ?? 0,
  advisors: document.querySelectorAll(".advisor").length,
  placeholders: [...document.querySelectorAll("[placeholder]")].map(e => e.placeholder.slice(0, 18)),
  headerSpan: document.querySelector(".contact-title span")?.textContent ?? null,
  bodyText: document.body.innerText.slice(0, 120).replace(/\n/g, "|"),
}));
console.log(JSON.stringify(info, null, 1));
await browser.close();
