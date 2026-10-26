// 挂载 CORE-DSE 站点；刷新时清除旧锚点并回到页首，保留首次直接链接与点击跳转。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

/** 刷新时阻止浏览器恢复旧滚动位置，页面显示后归还原有历史恢复策略。 */
function resetReloadPosition(): void {
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (navigation?.type !== "reload") return;
  const previousRestoration = history.scrollRestoration;
  history.scrollRestoration = "manual";
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  window.addEventListener("pageshow", () => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      history.scrollRestoration = previousRestoration;
    });
  }, { once: true });
}

resetReloadPosition();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
