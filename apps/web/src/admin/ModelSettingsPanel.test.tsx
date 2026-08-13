import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ModelSettingsPanel from "./ModelSettingsPanel.js";

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
});
