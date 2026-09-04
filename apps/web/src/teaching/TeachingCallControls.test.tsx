import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import TeachingCallControls from "./TeachingCallControls.js";
import TeachingPlansPanel from "./TeachingPlansPanel.js";

const available = {
  enabled: true,
  providerCapability: "dynamic_instructions_next_safe_turn",
  subject: "science",
  difficulty: "growing",
  triggerMode: "gentle",
  disclosureVersion: "teaching-disclosure-v1",
  configurationRevision: 3,
} as const;

describe("TeachingCallControls", () => {
  it("shows a transparent, optional child choice before creating a call", () => {
    const markup = renderToStaticMarkup(
      <TeachingCallControls
        phase="precall"
        characterName="星盾队长"
        availability={available}
        loading={false}
        loadError={false}
        temporary={false}
        guardianHistoryAccess="allowed"
        onEnable={() => undefined}
        onChatOnly={() => undefined}
      />,
    );
    expect(markup).toContain("可以带一个科学小挑战");
    expect(markup).toContain("随时跳过");
    expect(markup).toContain("家庭管理员可按你的账号设置查看");
    expect(markup).toContain("知道了，开始聊天");
    expect(markup).toContain("本次只聊天");
  });

  it("labels a general learning branch as comprehensive/other", () => {
    const markup = renderToStaticMarkup(
      <TeachingCallControls
        phase="precall"
        characterName="星盾队长"
        availability={{ ...available, subject: "general" }}
        loading={false}
        loadError={false}
        temporary={false}
        guardianHistoryAccess="allowed"
        onEnable={() => undefined}
        onChatOnly={() => undefined}
      />,
    );
    expect(markup).toContain("可以带一个综合/其他小挑战");
  });

  it("forces temporary conversations into an explicit chat-only start", () => {
    const markup = renderToStaticMarkup(
      <TeachingCallControls
        phase="precall"
        characterName="星盾队长"
        availability={available}
        loading={false}
        loadError={false}
        temporary
        guardianHistoryAccess="denied"
        onEnable={() => undefined}
        onChatOnly={() => undefined}
      />,
    );
    expect(markup).toContain("临时对话本次只聊天");
    expect(markup).toContain("开始临时聊天");
    expect(markup).not.toContain("知道了，开始聊天");
  });

  it("keeps ordinary chat available when no plan is enabled", () => {
    const markup = renderToStaticMarkup(
      <TeachingCallControls
        phase="precall"
        characterName="星盾队长"
        availability={{ enabled: false, reason: "no_enabled_plan" }}
        loading={false}
        loadError={false}
        temporary={false}
        guardianHistoryAccess="allowed"
        onEnable={() => undefined}
        onChatOnly={() => undefined}
      />,
    );
    expect(markup).toContain("这个角色还没有开启学习设置");
    expect(markup).toContain("开始普通聊天");
  });

  it("shows request and immediate skip controls only when allowed by state", () => {
    const availableMarkup = renderToStaticMarkup(
      <TeachingCallControls
        phase="incall"
        state={{
          revision: 1,
          state: "available",
          canRequest: true,
          canMute: true,
        }}
        onRequest={() => undefined}
        onMute={() => undefined}
      />,
    );
    expect(availableMarkup).toContain("现在来一个");
    expect(availableMarkup).toContain("本次只聊天");

    const activeMarkup = renderToStaticMarkup(
      <TeachingCallControls
        phase="incall"
        state={{
          revision: 2,
          state: "active",
          canRequest: false,
          canMute: true,
        }}
        onRequest={() => undefined}
        onMute={() => undefined}
      />,
    );
    expect(activeMarkup).toContain("跳过，本次只聊天");
    expect(activeMarkup).not.toContain("现在来一个");
  });
});

describe("TeachingPlansPanel", () => {
  it("renders the adult/admin configuration entry as a native dialog", () => {
    const markup = renderToStaticMarkup(
      <TeachingPlansPanel
        currentUser={{
          id: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069116",
          username: "adult",
          displayName: "家长",
          accountType: "adult",
          status: "active",
          guardianHistoryAccess: null,
          createdAt: "2026-08-15T08:00:00.000Z",
          updatedAt: "2026-08-15T08:00:00.000Z",
        }}
        open
        onClose={() => undefined}
        onUnauthorized={() => undefined}
      />,
    );
    expect(markup).toContain("<dialog");
    expect(markup).toContain('class="teaching-plans-panel"');
    expect(markup).toContain("学习小支线");
    expect(markup).toContain("孩子每次都能选择只聊天");
  });
});
