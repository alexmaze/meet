import type {
  CharacterSummary,
  ConversationContinuityStatus,
  UserAccount,
} from "@meet/protocol";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CharacterLibrary from "../characters/CharacterLibrary.js";
import {
  applyPendingEndOperation,
  conversationActions,
  conversationStateLabel,
  formatConnectedDuration,
} from "./continuity-presentation.js";
import { HistoryDetailView } from "./HistoryPage.js";

const user: UserAccount = {
  id: "00000000-0000-4000-8000-000000000004",
  username: "member",
  displayName: "家庭成员",
  status: "active",
  accountType: "adult",
  guardianHistoryAccess: null,
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};
const character: CharacterSummary = {
  id: "00000000-0000-4000-8000-000000000001",
  systemKey: "zhixia",
  systemVersion: 1,
  visibility: "builtin",
  name: "知夏",
  description: "温暖的聊天伙伴",
  revision: 1,
  visualProfile: {
    avatarUrl: "/avatars/zhixia.svg",
    accentColor: "#2F6F78",
    background: "aurora",
    animationStyle: "subtle",
  },
  voiceProfile: {
    id: "00000000-0000-4000-8000-000000000003",
    realtimeModelProfileId: "00000000-0000-4000-8000-000000000002",
    type: "preset",
    providerVoiceId: "longanqian",
    displayName: "龙安浅",
    style: {},
  },
  permissions: {
    canEdit: false,
    canDelete: false,
    canCopy: true,
    canShare: false,
    canRestore: false,
  },
  updatedAt: "2026-09-08T00:00:00.000Z",
};
function status(
  overrides: Partial<ConversationContinuityStatus> = {},
): ConversationContinuityStatus {
  return {
    conversation: {
      id: "00000000-0000-4000-8000-000000000005",
      userId: user.id,
      character: {
        id: character.id,
        name: character.name,
        visualProfile: character.visualProfile,
      },
      mode: "normal",
      status: "active",
      messageCount: 4,
      lastSequence: 4,
      provider: "qwen",
      model: "qwen-audio-3.0-realtime-plus",
      voice: "longanqian",
      startedAt: "2026-09-01T09:00:00.000Z",
      endedAt: null,
      updatedAt: "2026-09-01T09:10:00.000Z",
    },
    connectionState: "interrupted",
    writerClientId: null,
    writerEpoch: 1,
    leaseExpiresAt: null,
    lastActivityAt: "2026-09-01T09:10:00.000Z",
    lastSavedAt: "2026-09-01T09:09:59.000Z",
    connectedDurationMs: 600_000,
    finalizedAt: null,
    hasConnected: true,
    endRequestId: null,
    endTargetSequence: null,
    isOwner: true,
    canResume: true,
    canFinish: true,
    unavailableReason: null,
    summary: { state: "completed", content: "不应出现在首页的私人话题" },
    memory: { state: "completed", activeCount: 2, suggestedCount: 1 },
    ...overrides,
  };
}

function detailProps(value: ConversationContinuityStatus) {
  return {
    status: value,
    messages: [],
    currentUserId: user.id,
    busy: false,
    onCall: vi.fn(),
    onResume: vi.fn(),
    onFinish: vi.fn(),
    onDelete: vi.fn(),
    onViewMemories: vi.fn(),
  };
}

function clickButton(node: ReactNode, label: string): boolean {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child))
      continue;
    if (child.type === "button" && child.props.children === label) {
      child.props.onClick?.();
      return true;
    }
    if (clickButton(child.props.children, label)) return true;
  }
  return false;
}

describe("通话入口与私人内容边界", () => {
  it("结束请求结果未知时只提供确认收尾，不把本机待结束标记当成恢复邀请", () => {
    const interrupted = status();
    const awaiting = applyPendingEndOperation(interrupted, {
      conversationId: interrupted.conversation.id,
      requestId: "00000000-0000-4000-8000-000000000006",
      lastSequence: 6,
    });
    expect(conversationStateLabel(awaiting)).toBe("等待结束确认");
    expect(conversationActions(awaiting)).toMatchObject({
      resume: null,
      finish: true,
    });
    expect(awaiting.endTargetSequence).toBe(6);
    const completed = status({ connectionState: "completed" });
    expect(
      applyPendingEndOperation(completed, {
        conversationId: completed.conversation.id,
        requestId: "request",
        lastSequence: 6,
      }),
    ).toBe(completed);
  });

  it("在线和连接确认中不提供抢占或远程结束", () => {
    for (const state of ["connected", "connecting", "recovering"] as const) {
      const active = status({
        connectionState: state,
        canResume: false,
        canFinish: false,
        unavailableReason: "in_use",
      });
      expect(conversationActions(active)).toEqual({
        resume: null,
        start: null,
        finish: false,
        remove: false,
      });
    }
  });

  it("管理员只读儿童记录时不出现恢复、结束、新聊、删除或记忆操作", () => {
    for (const connectionState of ["interrupted", "completed"] as const) {
      const props = detailProps(status({ connectionState, isOwner: false }));
      const markup = renderToStaticMarkup(<HistoryDetailView {...props} />);
      expect(markup).toContain("只读查看该成员的历史");
      expect(markup).not.toContain("<button");
      expect(conversationActions(props.status)).toEqual({
        resume: null,
        start: null,
        finish: false,
        remove: false,
      });
    }
  });

  it("保存失败期间打开的本人历史也是只读，不会卸载原页面去新聊", () => {
    const props = detailProps(status({ connectionState: "completed" }));
    const markup = renderToStaticMarkup(
      <HistoryDetailView {...props} readOnly />,
    );
    expect(markup).toContain("尚未同步的文字仍保留在原页面");
    expect(markup).not.toContain("<button");
  });

  it("已结束临时对话的按钮把temporary传给新通话，未结束临时对话传原会话恢复", () => {
    const temporary = status();
    temporary.conversation.mode = "temporary";
    const completed = { ...temporary, connectionState: "completed" as const };
    const completedProps = detailProps(completed);
    expect(clickButton(HistoryDetailView(completedProps), "新的临时对话")).toBe(
      true,
    );
    expect(completedProps.onCall).toHaveBeenCalledWith(
      character.id,
      "temporary",
    );
    expect(completedProps.onResume).not.toHaveBeenCalled();
    const interruptedProps = detailProps(temporary);
    expect(
      clickButton(HistoryDetailView(interruptedProps), "恢复临时对话"),
    ).toBe(true);
    expect(interruptedProps.onResume).toHaveBeenCalledWith(temporary);
    expect(interruptedProps.onCall).not.toHaveBeenCalled();
  });

  it("首页近期和待处理卡片不渲染私人摘要，最近、收藏与全部保留独立入口", () => {
    const markup = renderToStaticMarkup(
      <CharacterLibrary
        user={user}
        characters={[character]}
        loading={false}
        error=""
        busyCharacterId={null}
        pending={[
          status(),
          status({ conversation: { ...status().conversation, id: "older" } }),
        ]}
        recent={[status({ connectionState: "completed" })]}
        overviewLoading={false}
        overviewError=""
        favoriteIds={[character.id]}
        favoriteBusyId={null}
        onRetry={vi.fn()}
        onOpen={vi.fn()}
        onCall={vi.fn()}
        onCreate={vi.fn()}
        onToggleFavorite={vi.fn()}
        onResume={vi.fn()}
        onFinish={vi.fn()}
        onViewHistory={vi.fn()}
        onRefreshOverview={vi.fn()}
      />,
    );
    expect(markup).not.toContain("不应出现在首页的私人话题");
    expect(markup).toContain("还有 1 次待处理");
    expect(markup).toContain("最近聊过");
    expect(markup).toContain("全部角色");
    expect(markup).toContain('aria-label="取消收藏知夏"');
    expect(markup).toContain("再次聊天");
  });

  it("通话时长只呈现累计连接时间，不把多天中断计入", () => {
    expect(formatConnectedDuration(status().connectedDurationMs)).toBe(
      "10 分钟",
    );
  });
});
