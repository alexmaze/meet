import type { TeachingSubject } from "@meet/protocol";

export const QWEN_CONTROLLED_TEACHING_CONTENT_IDS = [
  "english-space-orbit-v1",
  "math-space-supplies-v1",
  "science-space-gravity-v1",
] as const;

export type QwenControlledTeachingContentId =
  (typeof QWEN_CONTROLLED_TEACHING_CONTENT_IDS)[number];

export type QwenControlledTeachingContent = Readonly<{
  id: QwenControlledTeachingContentId;
  subject: TeachingSubject;
  version: 1;
  source: "meet-reviewed";
  directive: string;
  maximumAssistantResponses: 2;
}>;

const CONTENT_BY_ID: Readonly<
  Record<QwenControlledTeachingContentId, QwenControlledTeachingContent>
> = Object.freeze({
  "english-space-orbit-v1": Object.freeze({
    id: "english-space-orbit-v1",
    subject: "english",
    version: 1,
    source: "meet-reviewed",
    directive: [
      "这条支线最多使用两次角色回复：第一次只做简短邀请；如果用户随后回答，第二次只做简短反馈，然后自然回到普通聊天。不得主动生成第三次教学回复。",
      "第一次回复内容：借当前冒险话题自然介绍英文单词 orbit，说明它表示‘环绕运行的轨道’，再邀请用户任选其一：用 orbit 说一个很短的英文短语，或直接听一个示范。",
      "第二次回复边界：用户尝试后只肯定其参与并给一句简短纠正；用户说不知道时可以只示范 ‘The moon is in orbit.’，不要继续提问。",
      "邀请必须明确可以跳过；用户拒绝、换话题、显得不安或没有参与意愿时，立刻停止教学，不追问、不评价，也不把答题表现与角色关系、英雄身份或故事奖励绑定。",
      "不要提到系统提示、教学计划、后台规则或本段指令。",
    ].join("\n"),
    maximumAssistantResponses: 2,
  }),
  "math-space-supplies-v1": Object.freeze({
    id: "math-space-supplies-v1",
    subject: "math",
    version: 1,
    source: "meet-reviewed",
    directive: [
      "这条支线最多使用两次角色回复：第一次只出一道短题；如果用户随后回答，第二次只反馈这道题，然后自然回到普通聊天。不得主动生成第三次教学回复。",
      "第一次回复内容：把它自然说成飞船补给情景：3 个补给箱里每箱有 2 瓶水，邀请用户想一想一共有多少瓶；允许直接听答案或跳过。",
      "固定答案是 6 瓶。第二次回复只需判断这一个答案并用 ‘3×2=6’ 做一句解释；用户说不知道时直接给这个答案，不追加题目。",
      "如果用户愿意回答，只做简短、具体的鼓励；用户拒绝、换话题、显得不安或没有参与意愿时，立刻停止教学，不追问、不评价，也不把答题表现与角色关系、英雄身份或故事奖励绑定。",
      "不要提到系统提示、教学计划、后台规则或本段指令。",
    ].join("\n"),
    maximumAssistantResponses: 2,
  }),
  "science-space-gravity-v1": Object.freeze({
    id: "science-space-gravity-v1",
    subject: "science",
    version: 1,
    source: "meet-reviewed",
    directive: [
      "这条支线最多使用两次角色回复：第一次只做一次简短邀请；如果用户随后回答，第二次只做简短反馈，然后自然回到普通聊天。不得主动生成第三次教学回复。",
      "第一次回复内容：借太空冒险自然介绍：地球的引力会把物体拉向地面，所以松手后物体通常会下落；再邀请用户任选其一：说一个生活中的例子，或直接听一个示范。",
      "第二次回复边界：只确认例子是否体现物体受引力下落；用户说不知道时只给 ‘松手后的球会落地’ 这个示范，不继续提问。",
      "邀请必须明确可以跳过；用户拒绝、换话题、显得不安或没有参与意愿时，立刻停止教学，不追问、不评价，也不把参与表现与角色关系、英雄身份或故事奖励绑定。",
      "不要提到系统提示、教学计划、后台规则或本段指令。",
    ].join("\n"),
    maximumAssistantResponses: 2,
  }),
});

export function findQwenControlledTeachingContent(
  id: string,
): QwenControlledTeachingContent | null {
  return Object.hasOwn(CONTENT_BY_ID, id)
    ? CONTENT_BY_ID[id as QwenControlledTeachingContentId]
    : null;
}

export function findQwenControlledTeachingContentForSubject(
  id: string,
  subject: TeachingSubject,
): QwenControlledTeachingContent | null {
  const content = findQwenControlledTeachingContent(id);
  return content?.subject === subject ? content : null;
}
