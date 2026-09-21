import "../desktop/api.ts";
import { initializePreferences } from "./lib/preference-storage.ts";
function showError(message: string) {
  let banner = document.getElementById("pix-storage-error");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "pix-storage-error";
    banner.setAttribute("role", "alert");
    Object.assign(banner.style, {
      position: "fixed",
      bottom: "0",
      left: "0",
      right: "0",
      zIndex: "10000",
      padding: "16px",
      background: "#fff2e0",
      color: "#402010",
      whiteSpace: "pre-wrap",
    });
    document.body.append(banner);
  }
  banner.textContent = `Pix could not load/save preferences. Please check your data directory and restart.\n${message}`;
}
window.addEventListener("pix:preferences-error", (event) =>
  showError((event as CustomEvent<string>).detail),
);
const loading = setTimeout(() => {
  const root = document.getElementById("root");
  if (root && !root.childNodes.length) {
    root.textContent = "Pix 正在检查数据目录；如已安排迁移，将先复制并校验文件。";
    root.style.padding = "32px";
  }
}, 1000);
try {
  await initializePreferences();
  clearTimeout(loading);
  const root = document.getElementById("root");
  if (root) {
    root.textContent = "";
    root.style.padding = "";
  }
  await import("./main.tsx");
} catch (error) {
  clearTimeout(loading);
  showError(String(error));
}
