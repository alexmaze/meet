import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ModelSettingsPanel, {
  purposeLabels,
  teachingPlanGenerationPurposeHelp,
} from "./ModelSettingsPanel.js";

describe("ModelSettingsPanel", () => {
  it("renders as a native modal dialog with a visible backdrop style", () => {
    const markup = renderToStaticMarkup(
      <ModelSettingsPanel open onClose={() => undefined} />,
    );
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
    );

    expect(markup).toContain("<dialog");
    expect(markup).toContain('class="model-settings-panel"');
    expect(markup).toContain('aria-labelledby="model-settings-title"');
    expect(styles).toContain(".model-settings-panel::backdrop");
    expect(styles).toMatch(
      /\.model-settings-panel\s*\{[^}]*margin:\s*auto;[^}]*background:/s,
    );
  });

  it("marks the teaching-plan model as required and states its data boundary", () => {
    expect(purposeLabels.teaching_plan_generation).toContain("必需");
    expect(teachingPlanGenerationPurposeHelp).toContain("待确认草稿");
    expect(teachingPlanGenerationPurposeHelp).toContain("不联网检索");
    expect(teachingPlanGenerationPurposeHelp).toContain(
      "不会读取儿童会话或记忆",
    );
  });
});
