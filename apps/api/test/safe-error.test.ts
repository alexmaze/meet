import { describe, expect, it } from "vitest";

import { getSafeErrorLogContext } from "../src/auth/http.js";

describe("safe error logging", () => {
  it("keeps diagnostic identifiers without logging query parameters or secrets", () => {
    const passwordHash = "scrypt$131072$8$1$secret-salt$secret-hash";
    const error = Object.assign(
      new Error(`Failed query with params: ${passwordHash}`),
      {
        code: "23505",
        constraint: "password_credentials_user_id_unique",
        params: [passwordHash],
        query: "insert into password_credentials values ($1)",
        table: "password_credentials",
      },
    );

    const context = getSafeErrorLogContext(error);

    expect(context).toEqual({
      causeName: "Error",
      causeCode: "23505",
      causeConstraint: "password_credentials_user_id_unique",
      causeTable: "password_credentials",
    });
    expect(JSON.stringify(context)).not.toContain(passwordHash);
    expect(context).not.toHaveProperty("params");
    expect(context).not.toHaveProperty("query");
    expect(context).not.toHaveProperty("message");
    expect(context).not.toHaveProperty("stack");
  });
});
