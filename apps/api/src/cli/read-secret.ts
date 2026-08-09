export async function readNewPassword(useStdin: boolean): Promise<string> {
  if (useStdin) {
    let value = "";
    for await (const chunk of process.stdin) {
      value += chunk.toString();
      if (value.length > 1_024) {
        throw new Error("标准输入中的密码过长。");
      }
    }
    return value.replace(/\r?\n$/, "");
  }
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error(
      "当前终端不能安全隐藏密码；请通过 --password-stdin 从标准输入传入。",
    );
  }

  const first = await readMaskedLine("请输入新密码：");
  const second = await readMaskedLine("请再次输入新密码：");
  if (first !== second) {
    throw new Error("两次输入的密码不一致。");
  }
  return first;
}

function readMaskedLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = "";

    const restore = (): void => {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
    };
    const fail = (error: Error): void => {
      restore();
      process.stdout.write("\n");
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      for (const character of text) {
        if (character === "\u0003" || character === "\u0004") {
          fail(new Error("已取消密码输入。"));
          return;
        }
        if (character === "\r" || character === "\n") {
          restore();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = Array.from(value).slice(0, -1).join("");
            process.stdout.write("\b \b");
          }
          continue;
        }

        value += character;
        process.stdout.write("*");
      }
    };

    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}
