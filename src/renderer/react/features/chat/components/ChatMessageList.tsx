import { Bubble, CodeHighlighter, Think, ThoughtChain, type BubbleItemType } from "@ant-design/x";
import { XMarkdown, type ComponentProps } from "@ant-design/x-markdown";
import Latex from "@ant-design/x-markdown/plugins/Latex";
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type KeyboardEvent, type ReactNode } from "react";
import { resolveAsset } from "../../../../../shared/renderer-base";
import type { AgentRoundRecord, ConversationMode, ProcessMessageRecord, ReasoningBlock, RunActivityRecord, TaskDelegationDisplayRecord, ToolExecutionRecord, ToolFileChange } from "../../../../../shared/chat-types";
import type { ContextUsageSnapshot } from "../../../../../shared/context-usage";
import thinkingMoodUrl from "../../../assets/status-moods/思考中.png?url";
import completedThinkingMoodUrl from "../../../assets/status-moods/提醒.png?url";
import workingMoodUrl from "../../../assets/status-moods/工作中.png?url";
import interruptedMoodUrl from "../../../assets/status-moods/已中断.png?url";
import processedMoodUrl from "../../../assets/status-moods/已处理.png?url";
import connectingMoodUrl from "../../../assets/status-moods/连接中.png?url";
import { useUserAvatar } from "../../../hooks/useUserAvatar";
import {
  assistantRenderStages,
  resolveReasoningExpanded,
  updateReasoningExpanded,
} from "./message-visibility";
import { formatElapsed, resolveRunActivityExpanded, resolveRunActivitySnapshot, shouldAutoCollapseRunActivity } from "./run-activity";
import { RunStageIndicator } from "./RunStageIndicator";
import { TaskPlanCard } from "./TaskPlanCard";
import type { AgentRunStage, TaskPlanPresentation } from "./run-presentation";
import { CopyButton } from "./CopyButton";
import { TtsButton } from "./TtsButton";
import { stopTtsPlayback } from "./tts-playback";
import { LastTurnActionButton } from "./LastTurnActionButton";
import { resolveRevisableLastTurn, type RevisableLastTurn } from "./last-turn-actions";
import { extractMessageStickerId, stripMessageStickerMarkers } from "./message-sticker";
import type { WeatherData } from "./weather/weather-types";
import { WeatherCard } from "./weather/WeatherCard";
import { countRoundChangedFiles, describeToolExecution, resolveAgentRoundTitle } from "./agent-rounds";
import { TaskDelegationRow } from "./TaskDelegationRow";
import { extractFileChanges, FileChangeCard } from "./FileChangeCard";
import { ReviewPanel } from "./ReviewPanel";

export interface ChatMessageItem {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string;
  reasoningBlocks?: ReasoningBlock[];
  processMessages?: ProcessMessageRecord[];
  agentRounds?: AgentRoundRecord[];
  taskDelegations?: TaskDelegationDisplayRecord[];
  reasoningStreaming?: boolean;
  responseStarted?: boolean;
  streaming?: boolean;
  loading?: boolean;
  /** 请求已发出但尚未收到 Think、工具或正文等首个可视事件。 */
  waitingForFirstEvent?: boolean;
  ttsCacheKey?: string;
  ttsCacheVersion?: string;
  sticker?: string | null;
  toolExecutions?: ToolExecutionRecord[];
  runActivity?: RunActivityRecord;
  runStage?: AgentRunStage;
  /** 关联的 Run ID，用于获取 Review 快照 */
  runId?: string;
  taskPlan?: TaskPlanPresentation;
  attachments?: ChatMessageAttachment[];
  weather?: WeatherData;
  /** 上下文容量快照：运行中为每轮 preRequest 实时值，run 结束后为终态快照。 */
  contextUsage?: ContextUsageSnapshot;
}

export interface ChatMessageAttachment {
  name: string;
  kind: string;
  filePath?: string;
  mime?: string;
  previewUrl?: string;
  caption?: string;
  status?: string;
  reason?: string;
  imageSendMode?: "direct" | "caption";
}

interface ChatMessageListProps {
  messages: ChatMessageItem[];
  conversationId?: string;
  mode: ConversationMode;
  preferredAddress: string;
  stickerSize?: "small" | "standard" | "large";
  onTtsCacheKey?: (messageId: string, cacheKey: string, converterVersion: string) => void;
  revisionBusy?: boolean;
  onEditLastUserMessage?: (messageId: string, content: string) => Promise<boolean>;
  onRegenerateLastResponse?: (userMessageId: string, assistantMessageId: string) => Promise<boolean>;
  onScrollToBottomVisibilityChange?: (visible: boolean) => void;
  onRegisterScrollToBottom?: (scroll: () => void) => void;
  /** 点击 Review 文件项时打开右侧检查面板 */
  onOpenReviewInspector?: (runId: string, fileIndex: number) => void;
}

const markdownConfig = { extensions: Latex() };
const cyreneAvatarUrl = resolveAsset("avatars/cyrene-avatar.png");

function MarkdownCode({ children, lang, block }: ComponentProps<{ children?: ReactNode }>) {
  if (!block) return <code>{children}</code>;
  return (
    <CodeHighlighter lang={(lang ?? "text").split(/\s+/)[0]} prismLightMode={false}>
      {String(children ?? "").replace(/\n$/, "")}
    </CodeHighlighter>
  );
}

const markdownComponents = { code: MarkdownCode };
const completedMarkdownOptions = {
  hasNextChunk: false,
  enableAnimation: false,
  tail: false,
};

class MarkdownRenderBoundary extends Component<{
  content: string;
  children: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ReactChat] Markdown/KaTeX 渲染失败，已降级为原始文本", error, info);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <pre className="cy-message-markdown-fallback">{this.props.content}</pre>;
    }
    return this.props.children;
  }
}

export function MarkdownContent({ content }: { content: string; streaming?: boolean }) {
  return (
    <MarkdownRenderBoundary content={content}>
      <XMarkdown
        content={content}
        config={markdownConfig}
        components={markdownComponents}
        openLinksInNewTab
        escapeRawHtml
        rootClassName="cy-message-markdown"
        streaming={completedMarkdownOptions}
      />
    </MarkdownRenderBoundary>
  );
}

interface EnabledSticker {
  id: string;
  src: string;
}

function resolveStickerUrl(id: string, stickers: EnabledSticker[]): string | undefined {
  const raw = stickers.find((sticker) => sticker.id === id)?.src;
  if (!raw) return undefined;
  return raw.startsWith("/stickers/") ? resolveAsset(raw) : raw;
}

function AssistantContent({
  content,
  streaming,
  stickerUrl,
}: {
  content: string;
  streaming: boolean;
  stickerUrl?: string;
}) {
  return (
    <div className="cy-message__assistant-body">
      {content && <MarkdownContent content={content} streaming={streaming} />}
      {stickerUrl && <img className="cy-message__sticker" src={stickerUrl} alt="昔涟表情" draggable={false} />}
    </div>
  );
}

function DotSpinner() {
  return (
    <span className="cy-dot-spinner" aria-label="加载中" role="status">
      {Array.from({ length: 8 }, (_, index) => <span className="cy-dot-spinner__dot" key={index} />)}
    </span>
  );
}

function ModelWaitContent() {
  return (
    <section className="cy-model-wait" aria-label="等待模型响应">
      <span className="cy-model-wait__art" aria-hidden="true">
        <img src={connectingMoodUrl} alt="" draggable={false} />
        <DotSpinner />
      </span>
      <span>昔涟正在等模型回应…</span>
    </section>
  );
}

function ReasoningContent({
  content,
  loading,
  expanded,
  onExpand,
}: {
  content: string;
  loading: boolean;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
}) {
  return (
    <Think
      rootClassName="cy-message-reasoning"
      title={loading ? "正在思考…" : "思考完成"}
      icon={
        <span className={`cy-reasoning-status-art${loading ? " is-thinking" : " is-complete"}`} aria-hidden="true">
          <img src={thinkingMoodUrl} alt="" draggable={false} />
          {loading && <DotSpinner />}
        </span>
      }
      blink={loading}
      expanded={expanded}
      onExpand={onExpand}
      destroyOnHidden
    >
      {content && <MarkdownContent content={content} streaming={loading} />}
    </Think>
  );
}

function useRunActivityNow(processing: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!processing) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [processing]);
  return now;
}

function RunActivityReasoningBlock({ block }: { block: ReasoningBlock }) {
  const streaming = Boolean(block.streaming);
  // 与纯聊天模式保持一致：思考块默认折叠（含流式生成期间），仅用户点击后展开
  const [expanded, setExpanded] = useState(false);
  return (
    <ReasoningContent
      content={block.content}
      loading={streaming}
      expanded={expanded}
      onExpand={setExpanded}
    />
  );
}

function AgentRoundGroup({
  round,
  reasoningBlocks,
  processMessages,
  taskDelegations,
  tools,
  interrupted,
}: {
  round: AgentRoundRecord;
  reasoningBlocks: ReasoningBlock[];
  processMessages: ProcessMessageRecord[];
  taskDelegations: TaskDelegationDisplayRecord[];
  tools: ToolExecutionRecord[];
  interrupted: boolean;
}) {
  const running = round.status === "running" && !interrupted;
  const [expanded, setExpanded] = useState(running);
  const wasRunningRef = useRef(running);
  useEffect(() => {
    if (!wasRunningRef.current && running) setExpanded(true);
    if (wasRunningRef.current && !running) setExpanded(false);
    wasRunningRef.current = running;
  }, [running]);

  const roundArt = interrupted
    ? interruptedMoodUrl
    : running
      ? workingMoodUrl
      : completedThinkingMoodUrl;

  return (
    <section className={`cy-agent-round${running ? " is-running" : " is-complete"}`}>
      {processMessages.filter((message) => message.content.trim()).map((message) => (
        <div className="cy-run-activity__process" key={message.id}>
          <MarkdownContent content={message.content} />
        </div>
      ))}
      {taskDelegations.map((delegation) => (
        <TaskDelegationRow delegation={delegation} key={delegation.invocationId} />
      ))}
      <button
        type="button"
        className="cy-agent-round__header"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="cy-agent-round__art" aria-hidden="true">
          <img
            className="cy-agent-round__art-image"
            src={roundArt}
            alt=""
            draggable={false}
          />
        </span>
        <span className="cy-agent-round__title">
          {resolveAgentRoundTitle(round, tools, interrupted)}
          {!interrupted && round.status !== "running" && countRoundChangedFiles(tools) > 0 && (
            <span className="cy-agent-round__files"> · {countRoundChangedFiles(tools)} 个文件已被改动</span>
          )}
        </span>
        <svg className={`cy-agent-round__chevron${expanded ? " is-expanded" : ""}`} viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
        </svg>
      </button>
      {expanded && (
        <div className="cy-agent-round__body">
          {reasoningBlocks.filter((block) => block.content.trim()).map((block) => (
            <RunActivityReasoningBlock block={block} key={block.id} />
          ))}
          {tools.length > 0 && <ToolExecutionContent tools={tools} />}
        </div>
      )}
    </section>
  );
}

export function RunActivityDetail({
  agentRounds = [],
  reasoningBlocks,
  processMessages,
  taskDelegations = [],
  tools,
  interrupted = false,
}: {
  agentRounds?: AgentRoundRecord[];
  reasoningBlocks: ReasoningBlock[];
  processMessages: ProcessMessageRecord[];
  taskDelegations?: TaskDelegationDisplayRecord[];
  tools: ToolExecutionRecord[];
  interrupted?: boolean;
}) {
  if (agentRounds.length > 0) {
    const visibleRounds = agentRounds.filter((round) =>
      processMessages.some((message) => message.roundId === round.id && message.content.trim())
      || reasoningBlocks.some((block) => block.roundId === round.id && block.content.trim())
      || taskDelegations.some((delegation) => delegation.roundId === round.id)
      || tools.some((tool) => tool.roundId === round.id));
    if (visibleRounds.length === 0) {
      return <div className="cy-run-activity__empty">昔涟正在整理这一轮回复…</div>;
    }
    return (
      <div className="cy-run-activity__detail">
        {visibleRounds.map((round) => (
          <AgentRoundGroup
            key={round.id}
            round={round}
            interrupted={interrupted && round.status === "running"}
            processMessages={processMessages.filter((message) => message.roundId === round.id)}
            taskDelegations={taskDelegations.filter((delegation) => delegation.roundId === round.id)}
            reasoningBlocks={reasoningBlocks.filter((block) => block.roundId === round.id)}
            tools={tools.filter((tool) => tool.roundId === round.id)}
          />
        ))}
      </div>
    );
  }
  const timeline: ReactNode[] = [];
  taskDelegations.forEach((delegation) => {
    timeline.push(<TaskDelegationRow delegation={delegation} key={`task-${delegation.invocationId}`} />);
  });
  for (let index = 0; index <= tools.length; index += 1) {
    processMessages
      .filter((message) => (message.afterToolCount ?? 0) === index)
      .forEach((message) => {
        if (!message.content.trim()) return;
        timeline.push(
          <div className="cy-run-activity__process" key={`process-${message.id}`}>
            <MarkdownContent content={message.content} />
          </div>,
        );
      });
    reasoningBlocks
      .filter((block) => (block.afterToolCount ?? 0) === index)
      .forEach((block) => {
        if (!block.content.trim()) return;
        timeline.push(
          <RunActivityReasoningBlock
            key={`reasoning-${block.id}`}
            block={block}
          />,
        );
      });
    if (index < tools.length) {
      timeline.push(<ToolExecutionContent key={`tool-${tools[index].id}`} tools={[tools[index]]} />);
    }
  }
  return timeline.length
    ? <div className="cy-run-activity__detail">{timeline}</div>
    : <div className="cy-run-activity__empty">昔涟正在整理这一轮回复…</div>;
}

function RunActivityContent({
  activityId,
  activity,
  reasoningBlocks,
  processMessages,
  agentRounds,
  taskDelegations,
  tools,
  stage,
  taskPlan,
  expanded,
  onExpand,
}: {
  activityId: string;
  activity: RunActivityRecord;
  reasoningBlocks: ReasoningBlock[];
  processMessages: ProcessMessageRecord[];
  agentRounds: AgentRoundRecord[];
  taskDelegations: TaskDelegationDisplayRecord[];
  tools: ToolExecutionRecord[];
  stage?: AgentRunStage;
  taskPlan?: TaskPlanPresentation;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
}) {
  const now = useRunActivityNow(activity.completedAt === undefined);
  const snapshot = resolveRunActivitySnapshot(activity, now);
  const wasProcessingRef = useRef(snapshot.processing);
  useEffect(() => {
    if (shouldAutoCollapseRunActivity(wasProcessingRef.current, snapshot.processing, activity.keepExpanded)) onExpand(false);
    wasProcessingRef.current = snapshot.processing;
  }, [activity.keepExpanded, onExpand, snapshot.processing]);

  const title = snapshot.processing
    ? `昔涟正在处理中 ${formatElapsed(snapshot.processingMs)}`
    : `昔涟已处理 ${formatElapsed(snapshot.processingMs)}`;
  const image = snapshot.processing ? workingMoodUrl : processedMoodUrl;

  return (
    <section className={`cy-run-activity${snapshot.processing ? " is-processing" : " is-complete"}`}>
      <button
        type="button"
        className="cy-run-activity__header"
        onClick={() => onExpand(!expanded)}
        aria-expanded={expanded}
        aria-controls={`${activityId}-details`}
      >
        <span className="cy-run-activity__title">
            <span className="cy-run-activity__art" aria-hidden="true">
              <img src={image} alt="" draggable={false} />
              {snapshot.processing && <DotSpinner />}
            </span>
            <span>{title}</span>
            {stage && <RunStageIndicator stage={stage} />}
        </span>
        <svg className={`cy-run-activity__chevron${expanded ? " is-expanded" : ""}`} viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
        </svg>
      </button>
      {expanded && (
        <div className="cy-run-activity__expanded" id={`${activityId}-details`}>
          {taskPlan && <TaskPlanCard plan={taskPlan} />}
          <div className="cy-run-activity__divider" />
          <RunActivityDetail
            agentRounds={agentRounds}
            reasoningBlocks={reasoningBlocks}
            processMessages={processMessages}
            taskDelegations={taskDelegations}
            tools={tools}
            interrupted={Boolean(activity.keepExpanded && activity.completedAt !== undefined)}
          />
          <div className="cy-run-activity__divider" />
        </div>
      )}
    </section>
  );
}

function ToolExecutionContent({ tools }: { tools: ToolExecutionRecord[] }) {
  return (
    <section className="cy-tool-executions" aria-label="工具执行过程">
      <ThoughtChain
        rootClassName="cy-tool-executions__chain"
        line="dashed"
        items={tools.map((tool) => {
          const presentation = describeToolExecution(tool);
          return {
            key: tool.id,
            title: presentation.label,
            description: (
              <span className="cy-tool-executions__description">
                <span className="cy-tool-executions__status">{presentation.statusText}</span>
                {presentation.detail && <code className="cy-tool-executions__detail">{presentation.detail}</code>}
              </span>
            ),
            status: tool.status === "running" ? "loading" : tool.status === "error" ? "error" : "success",
            blink: tool.status === "running",
            collapsible: Boolean(tool.result || tool.changes),
            content: (tool.result || tool.changes)
              ? <ToolResultContent result={tool.result} changes={tool.changes} />
              : undefined,
          };
        })}
      />
    </section>
  );
}

/** 工具结果展示：优先用事件携带的结构化 changes 渲染 Diff Review 卡片；否则尝试解析完整 result JSON；最后原样展示 */
function ToolResultContent({ result, changes }: { result?: string; changes?: ToolFileChange[] }) {
  if (changes && changes.length > 0) return <FileChangeCard changes={changes} />;
  if (result) {
    const parsed = extractFileChanges(result);
    if (parsed) return <FileChangeCard changes={parsed} />;
    return <pre className="cy-tool-executions__result">{result}</pre>;
  }
  return null;
}

function attachmentStatus(attachment: ChatMessageAttachment): string | undefined {
  if (attachment.status === "processing") return "视觉分析中…";
  if (attachment.status === "error") return attachment.reason ?? "图片分析失败";
  if (attachment.imageSendMode === "direct") return "已交给主模型查看";
  if (attachment.imageSendMode === "caption" && attachment.status === "done") return "视觉分析完成";
  return undefined;
}

function UserAttachments({ attachments }: { attachments: ChatMessageAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="cy-message__attachments">
      {attachments.map((attachment, index) => {
        const status = attachmentStatus(attachment);
        if (attachment.kind === "image" && (attachment.previewUrl || attachment.filePath)) {
          return (
            <figure className="cy-message__image-attachment" key={`${attachment.filePath ?? attachment.name}-${index}`}>
              <AttachmentImage attachment={attachment} />
              {status && <figcaption className={attachment.status === "error" ? "is-error" : ""}>{status}</figcaption>}
            </figure>
          );
        }
        return <span className="cy-message__file-attachment" key={`${attachment.filePath ?? attachment.name}-${index}`}>{attachment.name}</span>;
      })}
    </div>
  );
}

function AttachmentImage({ attachment }: { attachment: ChatMessageAttachment }) {
  const [src, setSrc] = useState(attachment.previewUrl);

  useEffect(() => {
    setSrc(attachment.previewUrl);
    if ((!attachment.previewUrl || attachment.previewUrl.startsWith("file:")) && attachment.filePath) {
      let active = true;
      void window.chat?.getImagePreview?.(attachment.filePath).then((result) => {
        if (active && result.ok && result.dataUrl) setSrc(result.dataUrl);
      });
      return () => {
        active = false;
      };
    }
  }, [attachment.filePath, attachment.previewUrl]);

  return <img src={src} alt={attachment.name} draggable={false} />;
}

function UserContent({
  content,
  stickerUrl,
  attachments = [],
}: {
  content: string;
  stickerUrl?: string;
  attachments?: ChatMessageAttachment[];
}) {
  return (
    <div className="cy-message__user-body">
      <UserAttachments attachments={attachments} />
      {content && <MarkdownContent content={content} />}
      {stickerUrl && <img className="cy-message__sticker" src={stickerUrl} alt="用户表情" draggable={false} />}
    </div>
  );
}

function LastUserMessageEditor({
  value,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSubmit();
    }
  };
  return (
    <div className="cy-last-message-editor">
      <textarea
        autoFocus
        value={value}
        disabled={busy}
        aria-label="编辑最后一条消息"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="cy-last-message-editor__actions">
        <button type="button" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" className="is-primary" disabled={busy || !value.trim()} onClick={onSubmit}>
          保存并重新生成
        </button>
      </div>
    </div>
  );
}

function CyreneMessageAvatar() {
  return <img className="cy-message-avatar__image" src={cyreneAvatarUrl} alt="昔涟" draggable={false} />;
}

function UserMessageAvatar({ src }: { src: string | null }) {
  if (src) return <img className="cy-message-avatar__image" src={src} alt="用户" draggable={false} />;
  return <span className="cy-message-avatar__user" aria-label="用户" />;
}

function createRoles(
  userAvatarUrl: string | null,
  conversationId: string | undefined,
  mode: ConversationMode,
  preferredAddress: string,
  lastTurn: RevisableLastTurn | null,
  editingMessageId: string | null,
  editDraft: string,
  revisionBusy: boolean,
  onBeginEdit: (messageId: string, content: string) => void,
  onEditDraftChange: (value: string) => void,
  onCancelEdit: () => void,
  onSubmitEdit: () => void,
  onRegenerate: () => void,
  reasoningExpanded: Readonly<Record<string, boolean>>,
  onReasoningExpand: (id: string, expanded: boolean) => void,
  onTtsCacheKey?: (messageId: string, cacheKey: string, converterVersion: string) => void,
  onOpenReviewInspector?: (runId: string, fileIndex: number) => void,
) {
  return {
  user: {
    placement: "end" as const,
    variant: "filled" as const,
    rootClassName: "cy-message cy-message--user",
    avatar: <UserMessageAvatar src={userAvatarUrl} />,
    contentRender: (content: string, info: { extraInfo?: { messageId?: string; stickerUrl?: string; attachments?: ChatMessageAttachment[] } }) => (
      info.extraInfo?.messageId === editingMessageId
        ? <LastUserMessageEditor
            value={editDraft}
            busy={revisionBusy}
            onChange={onEditDraftChange}
            onCancel={onCancelEdit}
            onSubmit={onSubmitEdit}
          />
        : <UserContent
            content={content}
            stickerUrl={info.extraInfo?.stickerUrl}
            attachments={info.extraInfo?.attachments}
          />
    ),
    footer: (content: string, info: { extraInfo?: { messageId?: string } }) => {
      const cleanText = content.replace(/\[sticker:[^\]]+\]/g, "").trim();
      const messageId = info.extraInfo?.messageId;
      if (!cleanText || messageId === editingMessageId) return null;
      return (
        <div className="cy-message-actions">
          {messageId === lastTurn?.userMessageId && (
            <LastTurnActionButton
              kind="edit"
              disabled={revisionBusy}
              onClick={() => onBeginEdit(messageId, cleanText)}
            />
          )}
          <CopyButton text={cleanText} />
        </div>
      );
    },
  },
  assistant: {
    placement: "start" as const,
    variant: "filled" as const,
    rootClassName: "cy-message cy-message--assistant",
    avatar: <CyreneMessageAvatar />,
    contentRender: (content: string, info: { extraInfo?: { streaming?: boolean; stickerUrl?: string } }) => (
      <AssistantContent
        content={content}
        streaming={Boolean(info.extraInfo?.streaming)}
        stickerUrl={info.extraInfo?.stickerUrl}
      />
    ),
    footer: (content: string, info: { extraInfo?: { messageId?: string; streaming?: boolean; ttsCacheKey?: string } }) => {
      const cleanText = content.trim();
      const messageId = info.extraInfo?.messageId;
      const canRegenerate = messageId === lastTurn?.assistantMessageId;
      if (info.extraInfo?.streaming || (!cleanText && !canRegenerate)) return null;
      return (
        <div className="cy-message-actions">
          {cleanText && messageId && conversationId && (
            <TtsButton
              conversationId={conversationId}
              messageId={messageId}
              text={cleanText}
              speechMode={mode === "learn" ? "learn" : "default"}
              preferredAddress={preferredAddress}
              onCacheKey={(cacheKey, converterVersion) => onTtsCacheKey?.(messageId, cacheKey, converterVersion)}
            />
          )}
          {cleanText && <CopyButton text={cleanText} />}
          {canRegenerate && (
            <LastTurnActionButton kind="regenerate" disabled={revisionBusy} onClick={onRegenerate} />
          )}
        </div>
      );
    },
  },
  reasoning: {
    placement: "start" as const,
    variant: "borderless" as const,
    rootClassName: "cy-message cy-message--reasoning",
    contentRender: (_content: string, info: { extraInfo?: { reasoningId?: string; reasoning?: string; reasoningStreaming?: boolean } }) => (
      <ReasoningContent
        content={info.extraInfo?.reasoning ?? ""}
        loading={Boolean(info.extraInfo?.reasoningStreaming)}
        expanded={info.extraInfo?.reasoningId
          ? resolveReasoningExpanded(reasoningExpanded, info.extraInfo.reasoningId)
          : false}
        onExpand={(expanded) => {
          if (info.extraInfo?.reasoningId) onReasoningExpand(info.extraInfo.reasoningId, expanded);
        }}
      />
    ),
  },
  activity: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--activity",
    contentRender: (_content: string, info: {
      extraInfo?: {
        activityId?: string;
        activity?: RunActivityRecord;
        reasoningBlocks?: ReasoningBlock[];
        processMessages?: ProcessMessageRecord[];
        agentRounds?: AgentRoundRecord[];
        taskDelegations?: TaskDelegationDisplayRecord[];
        tools?: ToolExecutionRecord[];
        runStage?: AgentRunStage;
        taskPlan?: TaskPlanPresentation;
      };
    }) => {
      const activityId = info.extraInfo?.activityId;
      const activity = info.extraInfo?.activity;
      if (!activityId || !activity) return null;
      return (
        <RunActivityContent
          activityId={activityId}
          activity={activity}
          reasoningBlocks={info.extraInfo?.reasoningBlocks ?? []}
          processMessages={info.extraInfo?.processMessages ?? []}
          agentRounds={info.extraInfo?.agentRounds ?? []}
          taskDelegations={info.extraInfo?.taskDelegations ?? []}
          tools={info.extraInfo?.tools ?? []}
          stage={info.extraInfo?.runStage}
          taskPlan={info.extraInfo?.taskPlan}
          expanded={resolveRunActivityExpanded(reasoningExpanded, activityId, activity)}
          onExpand={(expanded) => onReasoningExpand(activityId, expanded)}
        />
      );
    },
  },
  tool: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--tool",
    contentRender: (_content: string, info: { extraInfo?: { tools?: ToolExecutionRecord[] } }) => (
      info.extraInfo?.tools?.length ? <ToolExecutionContent tools={info.extraInfo.tools} /> : null
    ),
  },
  waiting: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--waiting",
    contentRender: () => <ModelWaitContent />,
  },
  weather: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--weather",
    contentRender: (_content: string, info: { extraInfo?: { weather?: WeatherData } }) => (
      info.extraInfo?.weather ? <WeatherCard data={info.extraInfo.weather} /> : null
    ),
  },
  review: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--review",
    contentRender: (_content: string, info: { extraInfo?: { runId?: string } }) => (
      info.extraInfo?.runId
        ? <ReviewPanel runId={info.extraInfo.runId} onOpenInspector={onOpenReviewInspector} />
        : null
    ),
  },
  system: {
    placement: "start" as const,
    variant: "borderless" as const,
    rootClassName: "cy-message cy-message--system",
  },
  };
}

export function createMessageItems(messages: ChatMessageItem[], enabledStickers: EnabledSticker[]): BubbleItemType[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant") {
      const stickerId = extractMessageStickerId(message.content, message.sticker);
      return [{
        key: message.id,
        role: message.role,
        content: stripMessageStickerMarkers(message.content),
        extraInfo: {
          stickerUrl: stickerId ? resolveStickerUrl(stickerId, enabledStickers) : undefined,
          attachments: message.attachments,
          messageId: message.id,
        },
      }];
    }

    const assistantItems: BubbleItemType[] = [];
    const stages = assistantRenderStages(message);
    if (message.waitingForFirstEvent && !message.runActivity) {
      assistantItems.push({
        key: `${message.id}-waiting`,
        role: "waiting",
        content: "",
      });
    }
    const reasoningBlocks = message.reasoningBlocks?.length
      ? message.reasoningBlocks
      : (stages.includes("reasoning") ? [{ id: `${message.id}-legacy`, content: message.reasoning ?? "", streaming: message.reasoningStreaming }] : []);
    const appendReasoning = (block: ReasoningBlock) => {
      assistantItems.push({
        key: `${message.id}-reasoning-${block.id}`,
        role: "reasoning",
        content: "",
        extraInfo: {
          reasoningId: block.id,
          reasoning: block.content,
          reasoningStreaming: block.streaming,
        },
      });
    };
    const tools = message.toolExecutions ?? [];
    if (message.runActivity) {
      assistantItems.push({
        key: `${message.id}-activity`,
        role: "activity",
        content: "",
        extraInfo: {
          activityId: `${message.id}-activity`,
          activity: message.runActivity,
          reasoningBlocks,
          processMessages: message.processMessages ?? [],
          agentRounds: message.agentRounds ?? [],
          taskDelegations: message.taskDelegations ?? [],
          tools,
          runStage: message.runStage,
          taskPlan: message.taskPlan,
        },
      });
    } else {
      for (let index = 0; index <= tools.length; index += 1) {
        reasoningBlocks.filter((block) => (block.afterToolCount ?? 0) === index).forEach(appendReasoning);
        if (index === tools.length) continue;
        assistantItems.push({
          key: `${message.id}-tool-${tools[index].id}`,
          role: "tool",
          content: "",
          extraInfo: { tools: [tools[index]] },
        });
      }
    }
    if (message.weather) {
      assistantItems.push({
        key: `${message.id}-weather`,
        role: "weather",
        content: "",
        extraInfo: { weather: message.weather },
      });
    }
    if (stages.includes("assistant")) {
      assistantItems.push({
        key: message.id,
        role: "assistant",
        content: message.content,
        streaming: message.streaming,
        extraInfo: {
          messageId: message.id,
          streaming: message.streaming,
          ttsCacheKey: message.ttsCacheKey,
          stickerUrl: message.sticker ? resolveStickerUrl(message.sticker, enabledStickers) : undefined,
        },
      });
    }
    // Review 面板：Run 结束后（非 streaming/loading）且有 runId 时显示
    if (message.runId && !message.streaming && !message.loading) {
      assistantItems.push({
        key: `${message.id}-review`,
        role: "review",
        content: "",
        extraInfo: { runId: message.runId },
      });
    }
    return assistantItems;
  });
}

export function ChatMessageList({
  messages,
  conversationId,
  mode,
  preferredAddress,
  stickerSize = "standard",
  onTtsCacheKey,
  revisionBusy = false,
  onEditLastUserMessage,
  onRegenerateLastResponse,
  onScrollToBottomVisibilityChange,
  onRegisterScrollToBottom,
  onOpenReviewInspector,
}: ChatMessageListProps) {
  const userAvatarUrl = useUserAvatar();
  const [enabledStickers, setEnabledStickers] = useState<EnabledSticker[]>([]);
  const [reasoningExpanded, setReasoningExpanded] = useState<Record<string, boolean>>({});
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const lastTurn = resolveRevisableLastTurn(messages, mode);
  const onReasoningExpand = useCallback((id: string, expanded: boolean) => {
    setReasoningExpanded((current) => updateReasoningExpanded(current, id, expanded));
  }, []);
  const beginEdit = useCallback((messageId: string, content: string) => {
    setEditingMessageId(messageId);
    setEditDraft(content);
  }, []);
  const cancelEdit = useCallback(() => {
    if (revisionBusy) return;
    setEditingMessageId(null);
    setEditDraft("");
  }, [revisionBusy]);
  const submitEdit = useCallback(() => {
    if (!editingMessageId || !editDraft.trim() || !onEditLastUserMessage || revisionBusy) return;
    void onEditLastUserMessage(editingMessageId, editDraft.trim()).then((accepted) => {
      if (!accepted) return;
      setEditingMessageId(null);
      setEditDraft("");
    });
  }, [editDraft, editingMessageId, onEditLastUserMessage, revisionBusy]);
  const regenerate = useCallback(() => {
    if (!lastTurn || !onRegenerateLastResponse || revisionBusy) return;
    void onRegenerateLastResponse(lastTurn.userMessageId, lastTurn.assistantMessageId);
  }, [lastTurn, onRegenerateLastResponse, revisionBusy]);

  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // 向父组件注册滚动到底部的回调
  useEffect(() => {
    onRegisterScrollToBottom?.(scrollToBottom);
  }, [onRegisterScrollToBottom, scrollToBottom]);

  const updateScrollState = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distance < 100;
    isNearBottomRef.current = nearBottom;
    onScrollToBottomVisibilityChange?.(!nearBottom);
  }, [onScrollToBottomVisibilityChange]);

  // 打开/切换会话时滚动到底部
  useEffect(() => {
    scrollToBottom("auto");
    // 内容渲染后再次兜底滚动
    const timer = window.setTimeout(() => scrollToBottom("auto"), 100);
    isNearBottomRef.current = true;
    onScrollToBottomVisibilityChange?.(false);
    return () => window.clearTimeout(timer);
  }, [conversationId, onScrollToBottomVisibilityChange, scrollToBottom]);

  const roles = useMemo(
    () => createRoles(
      userAvatarUrl,
      conversationId,
      mode,
      preferredAddress,
      lastTurn,
      editingMessageId,
      editDraft,
      revisionBusy,
      beginEdit,
      setEditDraft,
      cancelEdit,
      submitEdit,
      regenerate,
      reasoningExpanded,
      onReasoningExpand,
      onTtsCacheKey,
      onOpenReviewInspector,
    ),
    [beginEdit, cancelEdit, conversationId, editDraft, editingMessageId, lastTurn, mode, onOpenReviewInspector, onReasoningExpand, onTtsCacheKey, preferredAddress, reasoningExpanded, regenerate, revisionBusy, submitEdit, userAvatarUrl],
  );

  useEffect(() => {
    if (editingMessageId && editingMessageId !== lastTurn?.userMessageId) {
      setEditingMessageId(null);
      setEditDraft("");
    }
  }, [editingMessageId, lastTurn?.userMessageId]);

  useEffect(() => stopTtsPlayback, [conversationId]);

  useEffect(() => {
    let active = true;
    void window.chat?.getEnabledStickers?.().then((stickers) => {
      if (active) setEnabledStickers(stickers);
    }).catch(() => {
      if (active) setEnabledStickers([]);
    });
    return () => {
      active = false;
    };
  }, []);

  const items = createMessageItems(messages, enabledStickers);

  return (
    <div
      ref={containerRef}
      className={`cy-message-list cy-message-list--stickers-${stickerSize}`}
      aria-live="polite"
      onScroll={updateScrollState}
    >
      <Bubble.List items={items} role={roles} autoScroll />
    </div>
  );
}
