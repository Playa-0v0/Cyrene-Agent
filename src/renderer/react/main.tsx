import React from "react";
import { createRoot } from "react-dom/client";
import "../ui/theme";
import { App } from "./App";
import { AppProviders } from "./app/providers/AppProviders";
import { initUiLocale } from "./i18n";

const container = document.getElementById("cyrene-react-root");
if (!container) {
  throw new Error("Root element #cyrene-react-root not found");
}

const root = createRoot(container);
// 先从主进程读取语言设置再渲染，避免首帧语言跳变；读取失败时保持默认 zh-CN
void initUiLocale().finally(() => {
  root.render(
    <React.StrictMode>
      <AppProviders>
        <App />
      </AppProviders>
    </React.StrictMode>,
  );
});
