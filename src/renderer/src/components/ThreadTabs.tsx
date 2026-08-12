import { useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { getDisplayThreadTitle, useStore } from "../store";
import type { ThreadState } from "../lib/types";
import { useOutsideClose } from "../lib/useOutsideClose";
import { Close, Pin, Plus, Split } from "./icons";

function tabLabel(thread: ThreadState | undefined): string {
  const firstUser = thread?.messages.find((m) => m.role === "user")?.text || "";
  return getDisplayThreadTitle(thread?.sessionName, firstUser).slice(0, 24) || "新会话";
}

type TabMenu = {
  id: string;
  x: number;
  y: number;
  title: string;
};

export function ThreadTabs() {
  const openThreadIds = useStore((s) => s.openThreadIds);
  const pinnedThreadIds = useStore((s) => s.pinnedThreadIds);
  const activeThreadId = useStore((s) => s.activeThreadId);
  const primaryThreadId = useStore((s) => s.primaryThreadId);
  const paneThreadId = useStore((s) => s.paneThreadId);
  const threads = useStore((s) => s.threads);
  const setActiveThread = useStore((s) => s.setActiveThread);
  const splitThreadIntoPane = useStore((s) => s.splitThreadIntoPane);
  const newTaskInSplit = useStore((s) => s.newTaskInSplit);
  const requestCloseThread = useStore((s) => s.requestCloseThread);
  const requestCloseOtherThreads = useStore((s) => s.requestCloseOtherThreads);
  const requestCloseThreadsToRight = useStore((s) => s.requestCloseThreadsToRight);
  const requestCloseAllThreads = useStore((s) => s.requestCloseAllThreads);
  const reorderOpenThreads = useStore((s) => s.reorderOpenThreads);
  const togglePinThread = useStore((s) => s.togglePinThread);
  const revealThreadInSidebar = useStore((s) => s.revealThreadInSidebar);
  const newTask = useStore((s) => s.newTask);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useOutsideClose(menuRef, !!menu, () => setMenu(null));

  const pinnedSet = new Set(pinnedThreadIds);

  // Keep the active tab visible even if openThreadIds briefly drifts.
  const ids =
    activeThreadId && !openThreadIds.includes(activeThreadId)
      ? [...openThreadIds, activeThreadId]
      : openThreadIds;

  if (ids.length === 0) return null;

  const askClose = (id: string) => {
    void requestCloseThread(id);
  };

  const openMenu = (id: string, title: string, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const width = 198;
    const height = 280;
    setMenu({
      id,
      title,
      x: Math.min(e.clientX, window.innerWidth - width - 8),
      y: Math.min(e.clientY, window.innerHeight - height - 8),
    });
  };

  const onDragStart = (id: string, e: DragEvent<HTMLButtonElement>) => {
    setDraggingId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  };

  const onDragOver = (index: number, e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropIndex(index);
  };

  const onDrop = (index: number, e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    const fromId = e.dataTransfer.getData("text/plain") || draggingId;
    setDraggingId(null);
    setDropIndex(null);
    if (!fromId) return;
    const fromIndex = openThreadIds.indexOf(fromId);
    if (fromIndex < 0 || fromIndex === index) return;
    reorderOpenThreads(fromIndex, index);
  };

  const onDragEnd = () => {
    setDraggingId(null);
    setDropIndex(null);
  };

  const menuPinned = menu ? pinnedSet.has(menu.id) : false;
  const menuIndex = menu ? openThreadIds.indexOf(menu.id) : -1;
  const canCloseOthers = openThreadIds.length > 1;
  const canCloseRight = menuIndex >= 0 && menuIndex < openThreadIds.length - 1;

  return (
    <div className="thread-tabs" role="tablist" aria-label="打开的会话">
      <div className="thread-tabs-list">
        {ids.map((id, index) => {
          const active = id === activeThreadId;
          const t = threads[id];
          const running = !!t?.isStreaming;
          const title = tabLabel(t);
          const pinned = pinnedSet.has(id);
          const dragging = draggingId === id;
          const dropTarget = dropIndex === index && draggingId && draggingId !== id;
          const lastPinned = pinned && index === pinnedThreadIds.length - 1 && pinnedThreadIds.length < ids.length;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              draggable
              aria-selected={active}
              className={`thread-tab${active ? " active" : ""}${pinned ? " pinned" : ""}${dragging ? " dragging" : ""}${dropTarget ? " drop-target" : ""}${lastPinned ? " last-pinned" : ""}`}
              data-thread-id={id}
              data-pinned={pinned ? "1" : "0"}
              title={pinned ? `${title}（已固定）` : title}
              onClick={() => setActiveThread(id)}
              onContextMenu={(e) => openMenu(id, title, e)}
              onDragStart={(e) => onDragStart(id, e)}
              onDragOver={(e) => onDragOver(index, e)}
              onDrop={(e) => onDrop(index, e)}
              onDragEnd={onDragEnd}
              onAuxClick={(e) => {
                // Pinned tabs hide ×; middle-click close is also disabled.
                if (e.button === 1 && !pinned) {
                  e.preventDefault();
                  askClose(id);
                }
              }}
            >
              {pinned && (
                <span className="thread-tab-pin" aria-hidden="true">
                  <Pin size={11} />
                </span>
              )}
              {running && <span className="thread-running" aria-hidden="true" />}
              <span className="thread-tab-title">{title}</span>
              {!pinned && (
                <span
                  className="thread-tab-close"
                  title="关闭会话"
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    askClose(id);
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <Close size={12} />
                </span>
              )}
            </button>
          );
        })}
      </div>
      <button type="button" className="thread-tab-add" title="新会话" onClick={() => void newTask()}>
        <Plus size={14} />
      </button>
      <button type="button" className="thread-tab-add" title="分屏新建会话" onClick={() => void newTaskInSplit()}>
        <Split size={14} />
      </button>

      {menu && (
        <div ref={menuRef} className="thread-tab-context-menu" style={{ left: menu.x, top: menu.y }} role="menu">
          <div className="thread-tab-context-name" title={menu.title}>
            {menu.title}
          </div>
          <button
            role="menuitem"
            onClick={() => {
              const id = menu.id;
              setMenu(null);
              togglePinThread(id);
            }}
          >
            {menuPinned ? "取消固定" : "固定标签"}
          </button>
          <div className="thread-tab-context-sep" />
          <button
            role="menuitem"
            onClick={() => {
              const id = menu.id;
              setMenu(null);
              void requestCloseThread(id);
            }}
          >
            关闭
          </button>
          <button
            role="menuitem"
            disabled={!canCloseOthers}
            onClick={() => {
              const id = menu.id;
              setMenu(null);
              void requestCloseOtherThreads(id);
            }}
          >
            关闭其他标签
          </button>
          <button
            role="menuitem"
            disabled={!canCloseRight}
            onClick={() => {
              const id = menu.id;
              setMenu(null);
              void requestCloseThreadsToRight(id);
            }}
          >
            关闭右侧标签
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenu(null);
              void requestCloseAllThreads();
            }}
          >
            关闭全部标签
          </button>
          <div className="thread-tab-context-sep" />
          <button
            role="menuitem"
            disabled={menu.id === activeThreadId || menu.id === primaryThreadId || menu.id === paneThreadId}
            onClick={() => {
              const id = menu.id;
              setMenu(null);
              splitThreadIntoPane(id);
            }}
          >
            在分屏打开
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const id = menu.id;
              setMenu(null);
              revealThreadInSidebar(id);
            }}
          >
            在侧栏中显示
          </button>
        </div>
      )}
    </div>
  );
}
