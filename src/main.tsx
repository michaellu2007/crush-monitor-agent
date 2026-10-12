import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./style.css";

// 单页面锁：第二个窗口/标签页只显示提示、绝不挂载 App——两边同时自动保存会互相覆盖数据。
const TOKEN_KEY = "crushPageToken";
const pageToken =
  sessionStorage.getItem(TOKEN_KEY) ??
  (() => {
    const t = crypto.randomUUID();
    sessionStorage.setItem(TOKEN_KEY, t);
    return t;
  })();

// 认领/心跳/续约共用;服务不在线时放行,由页面原有的连接错误提示兜底。
function claimPage(): Promise<boolean> {
  return fetch("/api/page", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: pageToken }),
  })
    .then((r) => r.status !== 409)
    .catch(() => true);
}

function Blocked() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#f5f3ed",
        color: "#6b6459",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <p style={{ textAlign: "center", lineHeight: 2 }}>
        应用已在另一个窗口打开。
        <br />
        请使用已打开的窗口;关闭它之后,这里会在几秒内自动继续。
      </p>
    </div>
  );
}

function boot() {
  // 心跳续约;持有权被收走(服务重启后被别的窗口认领)时重新走一遍锁定流程
  setInterval(() => {
    void claimPage().then((ok) => {
      if (!ok) location.reload();
    });
  }, 2500);
  addEventListener("pagehide", () => {
    navigator.sendBeacon(
      "/api/page",
      new Blob([JSON.stringify({ token: pageToken, release: true })], {
        type: "application/json",
      }),
    );
  });
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

const root = createRoot(document.getElementById("root")!);
void claimPage().then((ok) => {
  if (ok) {
    boot();
    return;
  }
  root.render(<Blocked />);
  setInterval(() => {
    void claimPage().then((ok) => ok && location.reload());
  }, 3000);
});
