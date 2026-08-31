import { Conversations, type ConversationItemType } from "@ant-design/x";
import { DeleteOutlined, EditOutlined, PushpinOutlined } from "@ant-design/icons";
import { Input, Menu, Modal, Popover } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatSessionMeta, ConversationMode } from "../../../../../shared/chat-types";

interface ConversationSidebarProps {
  mode: ConversationMode;
  sessions: ChatSessionMeta[];
  activeSessionId?: string;
  onSelect: (sessionId: string) => void;
  onOpenProject: (workspaceRoot: string) => void;
  onRename: (sessionId: string, newTitle: string) => void | Promise<void>;
  onDelete: (sessionId: string) => void | Promise<void>;
  onTogglePin: (sessionId: string, pinned: boolean) => void | Promise<void>;
}

interface ProjectSummary {
  name: string;
  workspaceRoot?: string;
  conversationCount: number;
  updatedAt: number;
}

function ProjectIcon({ mode }: { mode: ConversationMode }) {
  if (mode === "code") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M43 23V14C43 12.8954 42.1046 12 41 12H24L19 6H7C5.89543 6 5 6.89543 5 8V40C5 41.1046 5.89543 42 7 42H22" />
        <path d="M38 29L43 34L38 39" />
        <path d="M30 29L25 34L30 39" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M5 8C5 6.89543 5.89543 6 7 6H19L24 12H41C42.1046 12 43 12.8954 43 14V40C43 41.1046 42.1046 42 41 42H7C5.89543 42 5 41.1046 5 40V8Z" />
      <path d="M14 22L19 27L14 32" />
      <path d="M26 32H34" />
    </svg>
  );
}

function ConversationIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 5.5h14v10H9l-4 3v-13Z" />
    </svg>
  );
}

function formatModifiedTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function ProjectInfoCard({
  mode,
  project,
  onOpen,
}: {
  mode: ConversationMode;
  project: ProjectSummary;
  onOpen: () => void;
}) {
  return (
    <section className="cy-project-card" aria-label={`${project.name} 项目信息`}>
      <div className="cy-project-card__name">
        <ProjectIcon mode={mode} />
        <span>{project.name}</span>
      </div>
      <dl className="cy-project-card__details">
        <div><dt>项目名</dt><dd>{project.name}</dd></div>
        <div><dt>对话串数</dt><dd>{project.conversationCount}</dd></div>
        <div><dt>项目路径</dt><dd title={project.workspaceRoot}>{project.workspaceRoot ?? "暂无项目路径"}</dd></div>
        <div><dt>上次修改时间</dt><dd>{formatModifiedTime(project.updatedAt)}</dd></div>
      </dl>
      <button
        className="cy-project-card__open"
        type="button"
        disabled={!project.workspaceRoot}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
      >
        <ProjectIcon mode={mode} />
        <span>跳转对应文件夹</span>
      </button>
    </section>
  );
}

export function ConversationSidebar({
  mode,
  sessions,
  activeSessionId,
  onSelect,
  onOpenProject,
  onRename,
  onDelete,
  onTogglePin,
}: ConversationSidebarProps) {
  const supportsProjects = mode === "work" || mode === "code";
  const projects = useMemo(() => {
    const result = new Map<string, ProjectSummary>();
    for (const session of sessions) {
      const key = session.workspaceRoot ?? `unbound:${session.id}`;
      const current = result.get(key);
      if (current) {
        current.conversationCount += 1;
        current.updatedAt = Math.max(current.updatedAt, session.updatedAt);
      } else {
        result.set(key, {
          name: session.workspaceDisplayName ?? "未绑定项目",
          workspaceRoot: session.workspaceRoot,
          conversationCount: 1,
          updatedAt: session.updatedAt,
        });
      }
    }
    return result;
  }, [sessions]);
  const projectKeys = useMemo(() => [...projects.keys()], [projects]);
  const [expandedKeys, setExpandedKeys] = useState<string[]>(projectKeys);

  useEffect(() => {
    setExpandedKeys((current) => [...new Set([...current, ...projectKeys])]);
  }, [projectKeys]);

  const [contextMenu, setContextMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    sessionId: string;
    sessionTitle: string;
    pinned: boolean;
  }>({ open: false, x: 0, y: 0, sessionId: "", sessionTitle: "", pinned: false });

  const [editing, setEditing] = useState<{
    sessionId: string;
    value: string;
  } | null>(null);

  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) return;
    const input = renameInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [editing]);

  const sortedSessions = useMemo(
    () =>
      [...sessions].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return b.updatedAt - a.updatedAt;
      }),
    [sessions],
  );

  const items: ConversationItemType[] = sortedSessions.map((session) => ({
    key: session.id,
    "data-session-id": session.id,
    "data-pinned": session.pinned ? "true" : undefined,
    label:
      editing?.sessionId === session.id ? (
        <Input
          ref={renameInputRef}
          size="small"
          className="cy-session-rename-input"
          value={editing.value}
          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
          onPressEnter={() => {
            const title = editing.value.trim();
            if (title && title !== session.title) {
              void onRename(session.id, title);
            }
            setEditing(null);
          }}
          onBlur={() => setEditing(null)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setEditing(null);
            }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="cy-session-label">
          <span className="cy-session-label__title">{session.title || "新对话"}</span>
          {session.pinned && <PushpinOutlined className="cy-session-label__pin" />}
        </span>
      ),
    icon: <ConversationIcon />,
    ...(supportsProjects ? { group: session.workspaceRoot ?? `unbound:${session.id}` } : {}),
  }));

  function openContextMenu(event: React.MouseEvent, sessionId: string) {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      open: true,
      x: event.clientX,
      y: event.clientY,
      sessionId,
      sessionTitle: session.title || "新对话",
      pinned: session.pinned ?? false,
    });
  }

  function closeContextMenu() {
    setContextMenu((current) => ({ ...current, open: false }));
  }

  function handleMenuClick(key: string) {
    closeContextMenu();
    if (key === "rename") {
      const target = sessions.find((s) => s.id === contextMenu.sessionId);
      setEditing({
        sessionId: contextMenu.sessionId,
        value: target?.title ?? "",
      });
    } else if (key === "toggle-pin") {
      void onTogglePin(contextMenu.sessionId, !contextMenu.pinned);
    } else if (key === "delete") {
      Modal.confirm({
        title: `删除"${contextMenu.sessionTitle}"？`,
        content: "删除后无法恢复，确定要继续吗？",
        okText: "删除",
        okType: "danger",
        cancelText: "取消",
        onOk: () => void onDelete(contextMenu.sessionId),
      });
    }
  }

  useEffect(() => {
    if (!contextMenu.open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (target.closest(".cy-session-context-menu")) return;
      closeContextMenu();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeContextMenu();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu.open]);

  return (
    <nav className="cy-conversation-sidebar" aria-label={supportsProjects ? "项目与对话" : "对话列表"}>
      <div className="cy-conversation-sidebar__title">{supportsProjects ? "项目" : "对话"}</div>
      {items.length === 0 ? (
        <div className="cy-conversation-sidebar__empty">
          {supportsProjects ? "还没有项目任务" : "还没有对话"}
        </div>
      ) : (
        <>
          <div
            className="cy-conversation-list-wrapper"
            onContextMenu={(e) => {
              const item = (e.target as HTMLElement).closest("[data-session-id]");
              const sessionId = item?.getAttribute("data-session-id");
              if (!sessionId) return;
              openContextMenu(e, sessionId);
            }}
          >
            <Conversations
              rootClassName="cy-conversation-list"
              items={items}
              activeKey={activeSessionId}
              onActiveChange={(key) => {
                onSelect(String(key));
              }}
              groupable={supportsProjects ? {
                collapsible: true,
                expandedKeys,
                onExpand: setExpandedKeys,
                label: (group) => {
                  const project = projects.get(group);
                  if (!project) return null;
                  return (
                    <Popover
                      placement="rightTop"
                      mouseEnterDelay={0.25}
                      mouseLeaveDelay={0.12}
                      overlayClassName="cy-project-popover"
                      content={(
                        <ProjectInfoCard
                          mode={mode}
                          project={project}
                          onOpen={() => project.workspaceRoot && onOpenProject(project.workspaceRoot)}
                        />
                      )}
                    >
                      <span className="cy-conversation-project">
                        <ProjectIcon mode={mode} />
                        <span>{project.name}</span>
                      </span>
                    </Popover>
                  );
                },
              } : false}
            />
          </div>
          {contextMenu.open && (
            <div
              className="cy-session-context-menu"
              style={{
                position: "fixed",
                left: contextMenu.x,
                top: contextMenu.y,
                zIndex: 1050,
              }}
            >
              <Menu
                items={[
                  { key: "rename", label: "重命名", icon: <EditOutlined /> },
                  {
                    key: "toggle-pin",
                    label: contextMenu.pinned ? "取消置顶" : "置顶",
                    icon: <PushpinOutlined />,
                  },
                  { key: "delete", label: "删除", icon: <DeleteOutlined />, danger: true },
                ]}
                onClick={({ key }) => handleMenuClick(key)}
              />
            </div>
          )}
        </>
      )}
    </nav>
  );
}
