import { Notification, app, type BrowserWindow, type Tray } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { GeneralSettings } from "../settings/general-settings";
import { loadModelSettings, resolveModelSettingsProfile } from "../settings/model-settings";
import { loadUserProfile } from "../settings-store";
import {
  setSearchConfig,
  setUserTimezoneConfig,
  setWeatherConfig,
} from "../orchestrator/built-in-tools";
import { setEmailConfig } from "../orchestrator/email-tools";
import { setTravelConfig } from "../orchestrator/travel-tools";
import { toolRegistry } from "../orchestrator/tool-registry";
import { resolveVendorRuntimeSettings, setVendorRuntimeSettingsGetter } from "../orchestrator/vendors/runtime-settings";
import { setChoiceCardSender, setCardReminderNotifier } from "../user-choice";
import { createCardReminder } from "../card-reminder";
import { setAsrConfig } from "../asr/asr-config";
import { setCallSettings } from "../call/call-manager";
import { buildCallSystemPrompt } from "../call/call-prompt-builder";
import type { SceneIndex } from "../scene-embedder";
import { reactChatWindow } from "../windows/window-state";
import type { WindowManager } from "../windows/window-manager";
import type { ReminderPopupManager } from "../reminder/reminder-popup";

export interface BootstrapConfigContext {
  loadGeneralSettings: () => GeneralSettings;
  /** 场景嵌入索引 getter，用于通话语气注入。 */
  getSceneEmbeddingIndex: () => SceneIndex | null;
  /** 系统托盘实例（可能尚未创建，运行时动态读取）。 */
  getTray: () => Tray | null;
  /** 窗口管理器（桌宠动作/气泡/可见性查询）。 */
  getWindowManager: () => WindowManager | null;
  /** 卡片提醒浮窗管理器（右下角置顶浮窗）。 */
  getReminderPopup: () => ReminderPopupManager | null;
}

function getReactChatWindow(): BrowserWindow | null {
  return reactChatWindow && !reactChatWindow.isDestroyed() ? reactChatWindow : null;
}

/**
 * 启动阶段配置 getter 注入。
 * 所有业务模块的"实时读配置"回调都在这里统一注册，避免散落在 createWindow 中。
 */
export function bootstrapConfigGetters(ctx: BootstrapConfigContext): void {
  const { loadGeneralSettings } = ctx;

  // 厂商适配层保持独立可测试；通过 getter 实时读取全局模型开关，避免反向依赖主进程入口。
  // thinkingOverride / disableMaxToken 仅对自定义端点生效（preset 厂商由 capability 表 + chat 下拉控制），
  // 详见 resolveVendorRuntimeSettings 的实现与单元测试。
  setVendorRuntimeSettingsGetter(() => resolveVendorRuntimeSettings(loadModelSettings()));

  // 注入天气工具配置获取器：每次工具执行时实时读 key/默认城市
  // （用户改了设置不用重启就能生效）
  setWeatherConfig(
    () => loadUserProfile().defaultCity,
    () => loadGeneralSettings().weatherSource,
    () => loadGeneralSettings().amapKey,
    // 天气卡片回调：工具拿到结构化数据后，发 Custom 事件给 react 聊天窗口渲染卡片
    (card, context) => {
      const win = getReactChatWindow();
      if (win) {
        win.webContents.send(IPC.AGUI_EVENT, {
          type: "CUSTOM",
          name: "cyrene.weather",
          value: card,
          // 天气工具在 Harness 内执行时必须归属到该 run；否则 renderer 的
          // RunEventGate 会把没有 runId 的卡片事件当作串会话事件丢弃。
          ...(context?.runId ? { runId: context.runId } : {}),
        });
      }
    },
    () => loadGeneralSettings().weatherEnabled,
  );

  // 注入用户时区 getter：工具侧通过 currentUserTimezone() 统一拿用户时区（缺/非法回退 Asia/Shanghai）
  setUserTimezoneConfig(() => loadUserProfile().timezone);

  // 注入用户选择卡片回调：工具调 ask_user_choice 时发 Custom 事件给 react 聊天窗口
  setChoiceCardSender((cardData) => {
    const win = getReactChatWindow();
    if (win) {
      win.webContents.send(IPC.AGUI_EVENT, {
        type: "CUSTOM",
        name: "cyrene.choice",
        value: cardData,
      });
    }
  });

  // 注入卡片提醒多通道通知器：提问卡片/计划书审批卡提交时按聚焦状态选通道提醒。
  // 通道设计（本版无 TTS 语音链路）：
  //   - 聊天窗口聚焦/全屏 → 仅应用内提示（卡片本身在聊天窗口内展示）
  //   - 未聚焦（其他应用）→ C 置顶浮窗 + B 托盘气泡 + D 桌宠气泡 + 通知兜底
  setCardReminderNotifier(
    createCardReminder({
      getChatWindow: getReactChatWindow,
      // 桌宠可见时才走 D 通道
      isPetVisible: () => ctx.getWindowManager()?.isMainWindowVisible() ?? false,
      // ── 任务八：C 置顶浮窗 ──
      showReminderPopup: (payload) => {
        ctx.getReminderPopup()?.show(payload);
      },
      hideReminderPopup: () => {
        ctx.getReminderPopup()?.hide();
      },
      // ── 任务八：B 托盘气泡（Windows 专属 API；dev/打包都可靠）──
      showTrayBalloon: (title, body) => {
        // displayBalloon 是 Windows 专属，非 Windows 静默跳过
        if (process.platform !== "win32") return;
        const tray = ctx.getTray();
        if (!tray) return;
        try {
          tray.displayBalloon({ title, content: body, iconType: "info" });
        } catch (err) {
          console.warn("[CardReminder] 托盘气泡显示失败:", err);
        }
      },
      // ── 任务八：D 桌宠头顶气泡 ──
      showPetBubble: (text) => {
        ctx.getWindowManager()?.sendToMainWindow(IPC.LIVE2D_BUBBLE_SHOW, text);
      },
      // 弹出应用外原生通知（Windows toast），点击后把聊天窗口带回前台
      notify: (title, body) => {
        const win = getReactChatWindow();
        // dev 模式（未打包）下 Windows toast 常因缺少已注册 AUMID 而静默失败，
        // 降级为任务栏闪烁 + 日志，保证开发环境也能注意到提醒。
        const flashFallback = (): void => {
          if (win && !win.isDestroyed()) {
            win.flashFrame(true);
            // 5 秒后停止闪烁，避免持续打扰
            setTimeout(() => {
              if (!win.isDestroyed()) win.flashFrame(false);
            }, 5000);
          }
        };
        if (!app.isPackaged) {
          console.log("[CardReminder] dev 模式：未打包无 AUMID 注册，跳过 toast 改用任务栏闪烁");
          flashFallback();
          return;
        }
        if (!Notification.isSupported()) {
          console.warn("[CardReminder] 系统不支持 Notification，改用任务栏闪烁");
          flashFallback();
          return;
        }
        try {
          const notification = new Notification({ title, body });
          notification.on("click", () => {
            if (win && !win.isDestroyed()) {
              if (win.isMinimized()) win.restore();
              win.show();
              win.focus();
            }
          });
          notification.show();
        } catch (err) {
          console.warn("[CardReminder] 原生通知弹出失败，改用任务栏闪烁:", err);
          flashFallback();
        }
      },
    }),
  );

  // 注入搜索配置获取器
  setSearchConfig(
    () => loadGeneralSettings().searchEngine,
    () => loadGeneralSettings().searchBochaKey,
    () => loadGeneralSettings().searchTavilyKey,
    () => loadGeneralSettings().searchAnySearchKey,
  );

  // 注入出行工具 amapKey 获取器（复用 GeneralSettings 中的 amapKey）
  setTravelConfig(() => loadGeneralSettings().amapKey, () => loadGeneralSettings().travelEnabled);

  // 注入邮件工具 SMTP 配置获取器（每次执行实时读 GeneralSettings）
  setEmailConfig(
    () => loadGeneralSettings().emailEnabled,
    () => loadGeneralSettings().emailSmtpHost,
    () => loadGeneralSettings().emailSmtpPort,
    () => loadGeneralSettings().emailSmtpSecure,
    () => loadGeneralSettings().emailSmtpUser,
    () => loadGeneralSettings().emailSmtpPass,
    () => loadGeneralSettings().emailFromName,
  );

  // 注入 ASR 配置获取器（通话功能用，实时读 GeneralSettings）
  setAsrConfig(() => {
    const s = loadGeneralSettings();
    if (s.asrEngine === "mossland") {
      return { engine: "mossland", apiKey: s.ttsMosslandKey };
    }
    if (s.asrEngine === "aliyun") {
      return { engine: "aliyun", appKey: s.asrAliyunAppKey, accessKeyId: s.asrAliyunAccessKeyId, accessKeySecret: s.asrAliyunAccessKeySecret, language: s.asrLanguage };
    }
    return null;
  });

  // 注入通话模型/TTS 配置获取器
  // 模型 getter 必须先展开默认档案再取字段：顶层镜像可能指向空壳 provider
  // （用户只在档案里配了模型），直接读会导致通话报"模型配置缺失"（与 channel bot 读到顶层空壳镜像同病根）。
  setCallSettings(
    () => {
      const s = resolveModelSettingsProfile(loadModelSettings());
      return { provider: s.provider, baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey, explicitTransport: s.explicitTransport };
    },
    () => {
      const s = loadGeneralSettings();
      return {
        ttsEngine: s.ttsEngine,
        ttsMinimaxKey: s.ttsMinimaxKey, ttsMinimaxVoiceId: s.ttsMinimaxVoiceId,
        ttsMinimaxModel: s.ttsMinimaxModel,
        ttsSpeed: s.ttsSpeed, ttsVolume: s.ttsVolume,
        ttsMinimaxVocalEnhance: s.ttsMinimaxVocalEnhance,
        ttsGptsovitsBaseUrl: s.ttsGptsovitsBaseUrl,
        ttsGptsovitsRefAudioPath: s.ttsGptsovitsRefAudioPath,
        ttsGptsovitsPromptText: s.ttsGptsovitsPromptText,
        ttsGptsovitsFormat: s.ttsGptsovitsFormat,
        ttsGptsovitsTimeoutMs: s.ttsGptsovitsTimeoutMs,
        ttsCustomCloudEndpointUrl: s.ttsCustomCloudEndpointUrl,
        ttsCustomCloudApiKey: s.ttsCustomCloudApiKey,
        ttsCustomCloudVoiceId: s.ttsCustomCloudVoiceId,
        ttsCustomCloudFormat: s.ttsCustomCloudFormat,
        ttsCustomCloudTimeoutMs: s.ttsCustomCloudTimeoutMs,
        ttsMimoKey: s.ttsMimoKey,
        ttsMimoVoiceAudioPath: s.ttsMimoVoiceAudioPath,
        ttsMimoStylePrompt: s.ttsMimoStylePrompt,
      };
    },
    // 通话专用 system prompt 构建器
    async (userText: string) => {
      const messages = [{ role: "user" as const, content: userText }];
      return buildCallSystemPrompt(
        { sceneEmbeddingIndex: ctx.getSceneEmbeddingIndex() },
        userText,
        messages,
      );
    },
    // 天气快捷处理：正则匹配到天气关键词 → 调 weather 工具的 execute
    async (userText: string) => {
      try {
        const weatherTool = toolRegistry.getById("weather");
        if (!weatherTool) return null;
        // 提取城市名（简单匹配：XX天气 / XX的天气）
        const cityMatch = userText.match(/([北京上海广州深圳成都杭州南京武汉西安重庆天津苏州长沙郑州青岛大连沈阳哈尔滨长春济南太原合肥南昌福州昆明贵阳拉萨乌鲁木齐呼和浩特]+)/);
        const city = cityMatch?.[1] ?? "";
        const result = await weatherTool.execute({ city }, undefined);
        return result;
      } catch (err) {
        console.warn("[Call] 天气查询失败:", err);
        return null;
      }
    },
  );

}
