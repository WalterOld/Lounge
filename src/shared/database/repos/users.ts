import { ZodType, z } from "zod";
import { MODEL_FAMILIES, ModelFamily } from "../../models";
import { makeOptionalPropsNullable } from "../../utils";
import { getDatabase } from "../index";
import type { Transaction } from "better-sqlite3";

// This just dynamically creates a Zod object type with a key for each model
// family and an optional number value.
export const tokenCountsSchema: ZodType<UserTokenCounts> = z.object(
  MODEL_FAMILIES.reduce(
    (acc, family) => {
      return {
        ...acc,
        [family]: z.object({
          input: z.number().optional().default(0),
          output: z.number().optional().default(0),
          limit: z.number().optional().default(0),
          prompts: z.number().optional().default(0),
        }),
      };
    },
    {} as Record<
      ModelFamily,
      ZodType<{ input: number; output: number; limit: number; prompts: number }>
    >
  )
);

// Old token counts schema before counts were combined into a single object.
const tokenCountsSchemaOld = z.object(
  MODEL_FAMILIES.reduce(
    (acc, family) => ({ ...acc, [family]: z.number().optional().default(0) }),
    {} as Record<ModelFamily, ZodType<number>>
  )
);

export const UserSchema = z
  .object({
    /** User's personal access token. */
    token: z.string(),
    /** IP addresses the user has connected from. */
    ip: z.array(z.string()),
    /** User's nickname. */
    nickname: z.string().max(80).optional(),
    /**
     * The user's privilege level.
     * - `normal`: Default role. Subject to usual rate limits and quotas.
     * - `special`: Special role. Higher quotas and exempt from auto-ban/lockout.
     **/
    type: z.enum(["normal", "special", "temporary"]),
    /** Number of prompts the user has made. */
    promptCount: z.number(),
    /**
     * @deprecated Use `tokenCounts` instead.
     * Never used; retained for backwards compatibility.
     */
    tokenCount: z.any().optional(),
    /** Number of tokens the user has consumed, by model family. */
    tokenCounts: tokenCountsSchemaOld,
    /** Maximum number of tokens the user can consume, by model family. */
    tokenLimits: tokenCountsSchemaOld,
    /** Token data for the user, by model family. */
    modelTokenCounts: tokenCountsSchema,
    /** Time at which the user was created. */
    createdAt: z.number(),
    /** Time at which the user last connected. */
    lastUsedAt: z.number().optional(),
    /** Time at which the user was disabled, if applicable. */
    disabledAt: z.number().optional(),
    /** Reason for which the user was disabled, if applicable. */
    disabledReason: z.string().optional(),
    /** Time at which the user will expire and be disabled (for temp users). */
    expiresAt: z.number().optional(),
    /** The user's maximum number of IP addresses; supercedes global max. */
    maxIps: z.coerce.number().int().min(0).optional(),
    /** Private note about the user. */
    adminNote: z.string().optional(),
    meta: z.record(z.any()).optional(),
  })
  .strict();
/**
 * Variant of `;
 UserSchema` which allows for partial updates, and makes any
 * optional properties on the base schema nullable. Null values are used to
 * indicate that the property should be deleted from the user object.
 */
export const UserPartialSchema = makeOptionalPropsNullable(UserSchema)
  .partial()
  .extend({ token: z.string() });
export type UserTokenCounts = {
  [K in ModelFamily]: {
    input: number;
    output: number;
    limit: number;
    prompts: number;
  };
};
export type UserTokenCountsOld = {
  [K in ModelFamily]: number | undefined;
};
export type User = z.infer<typeof UserSchema>;
export type UserUpdate = z.infer<typeof UserPartialSchema>;
export type VirtualUser = User & { virtual: true; ipCount: number };

export const UsersRepo = {
  getUserByToken: (token: string) => {
    const db = getDatabase();
    // language=SQLite
    const sql = `
        SELECT u.*,
               json_group_array(ui.ip)                                as ip,
               json_group_object(utc.modelFamily,
                                 json_object('input', utc.inputTokens,
                                             'output', utc.outputTokens,
                                             'limit', utc.tokenLimit,
                                             'prompts', utc.prompts)) as tokenCounts,
               json_object(um.key, um.value)                          as meta
        FROM users u
                 LEFT JOIN user_ips ui ON u.token = ui.userToken
                 LEFT JOIN user_token_counts utc ON u.token = utc.userToken
                 LEFT JOIN user_meta um ON u.token = um.userToken
        WHERE u.token = ?;
    `;

    const user = db.prepare(sql).get(token);
    if (!user) return;

    return marshalUser(user);
  },
  getUsers: (pagination: { limit: number; cursor?: string }): VirtualUser[] => {
    const db = getDatabase();
    const { limit, cursor } = pagination;
    const params = [];
    let sql = `
        SELECT u.*,
               count(ui.ip)                                           as ipCount,
               json_group_object(utc.modelFamily,
                                 json_object('input', utc.inputTokens,
                                             'output', utc.outputTokens,
                                             'limit', utc.tokenLimit,
                                             'prompts', utc.prompts)) as tokenCounts,
               json_object(um.key, um.value)                          as meta
        FROM users u
                 LEFT JOIN user_ips ui ON u.token = ui.userToken
                 LEFT JOIN user_token_counts utc ON u.token = utc.userToken
                 LEFT JOIN user_meta um ON u.token = um.userToken
    `;

    if (cursor) {
      sql += ` WHERE u.token < ?`;
      params.push(cursor);
    }

    sql += ` GROUP BY u.token ORDER BY u.token DESC LIMIT ?`;
    params.push(limit);

    return db
      .prepare(sql)
      .all(params)
      .map((r: any) => {
        const virtual: VirtualUser = {
          ...marshalUser(r),
          virtual: true,
          ipCount: r.ipCount ?? 0,
        };
        return virtual;
      });
  },
  /**
   * Upserts a user record by user token. Intended for use via the REST API,
   * prefer a more targeted method if possible. Undefined values are ignored,
   * null values are used to indicate that the field should be cleared.
   *
   * @param update - The user data to upsert, with `token` required.
   */
  upsertUser: (update: UserUpdate): void => {
    const db = getDatabase();
    if (!db.inTransaction) {
      return db.transaction(() => UsersRepo.upsertUser(update))();
    }

    const updates: Partial<User> = {};
    for (const field of Object.entries(update)) {
      const [key, value] = field as [keyof User, any]; // assertion validated by zod
      if (value === undefined || key === "token") continue;
      updates[key] = value;
    }

    const setFields = Object.keys(updates)
      .map((key) => `${key} = :${key}`)
      .join(", ");
    const params = { ...updates, token: update.token };

    // scalars
    const sql = `
        INSERT INTO users (token, nickname, type, createdAt, lastUsedAt, disabledAt, disabledReason, expiresAt, maxIps,
                           adminNote)
        VALUES (:token, :nickname, :type, :createdAt, :lastUsedAt, :disabledAt, :disabledReason, :expiresAt, :maxIps,
                :adminNote)
        ON CONFLICT(token) DO UPDATE SET ${setFields};
    `;

    db.prepare(sql).run(params);

    // replace ip addresses
    if (update.ip) {
      const sql = `
          DELETE
          FROM user_ips
          WHERE userToken = :token;
          INSERT INTO user_ips (userToken, ip)
          VALUES ${update.ip.map(() => "(?, ?)").join(", ")};
      `;

      db.prepare(sql).run(
        update.ip.flatMap((ip: string) => [update.token, ip])
      );
    }

    if (update.modelTokenCounts) {
      const sql = `
          INSERT INTO user_token_counts (userToken, modelFamily, inputTokens, outputTokens, tokenLimit, prompts)
          VALUES (:token, :modelFamily, :inputTokens, :outputTokens, :tokenLimit, :prompts)
          ON CONFLICT(userToken, modelFamily) DO UPDATE SET inputTokens  = :inputTokens,
                                                            outputTokens = :outputTokens,
                                                            tokenLimit   = :tokenLimit,
                                                            prompts      = :prompts;
      `;

      for (const [family, counts] of Object.entries(update.modelTokenCounts)) {
        db.prepare(sql).run({
          token: update.token,
          modelFamily: family,
          ...counts,
        });
      }
    }

    if (update.meta) {
      const sql = `
          DELETE
          FROM user_meta
          WHERE userToken = :token;
          INSERT INTO user_meta (userToken, key, value)
          VALUES ${Object.keys(update.meta)
            .map(() => "(?, ?, ?)")
            .join(", ")};
      `;

      db.prepare(sql).run(
        Object.entries(update.meta).flatMap(([key, value]) => [
          update.token,
          key,
          value,
        ])
      );
    }
  },
  /**
   * Inserts or updates multiple user records in a single transaction.
   * Periodically commits the transaction and yields to the event loop to
   * prevent blocking the main thread for too long.
   * @param updates - The user data to upsert.
   */
  upsertUsers: async (updates: UserUpdate[]) => {
    const db = getDatabase();
    const BATCH_SIZE = 50;
    const chunked = updates.reduce<UserUpdate[][]>((acc, _, i) => {
      if (i % BATCH_SIZE === 0) acc.push(updates.slice(i, i + BATCH_SIZE));
      return acc;
    }, []);

    const transaction = db.transaction((updates: UserUpdate[]) => {
      for (const update of updates) {
        UsersRepo.upsertUser(update);
      }
    });

    for (const chunk of chunked) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      transaction(chunk);
    }
  },
  /**
   * Increments the token usage counters for a user's token by the provided
   * values, and increments prompt count by 1.
   */
  incrementUsage(
    userToken: string,
    family: ModelFamily,
    input: number,
    output: number
  ) {
    const db = getDatabase();

    const sql = `
        INSERT INTO user_token_counts (userToken, modelFamily, inputTokens, outputTokens, tokenLimit, prompts)
        VALUES (:userToken, :modelFamily, :inputTokens, :outputTokens, 0, 1)
        ON CONFLICT(userToken, modelFamily) DO UPDATE SET inputTokens  = inputTokens + :inputTokens,
                                                          outputTokens = outputTokens + :outputTokens,
                                                          prompts      = prompts + 1;
    `;

    db.prepare(sql).run({
      userToken,
      modelFamily: family,
      inputTokens: input,
      outputTokens: output,
    });
  },
  /**
   * Disables user, optionally with reason.
   */
  disableUser(userToken: string, reason?: string) {
    const db = getDatabase();
    const disabledAt = Date.now();
    const sql = `
        UPDATE users
        SET disabledAt     = :disabledAt,
            disabledReason = :reason
        WHERE token = :userToken;
        INSERT OR REPLACE INTO user_meta (userToken, key, value)
        VALUES (:userToken, 'refreshable', 'false');
    `;

    db.prepare(sql).run({ userToken, disabledAt, reason });
  },
  /**
   * Restores quotas for a user by adding the provided token counts to their
   * existing counts.
   */
  refreshQuotas(
    userToken: string,
    tokensByFamily: Record<ModelFamily, number>
  ): void {
    const db = getDatabase();
    if (!db.inTransaction) {
      return db.transaction(() =>
        UsersRepo.refreshQuotas(userToken, tokensByFamily)
      )();
    }

    // for each provided family, increment the tokenLimit to equal inputTokens + outputTokens + refresh amount
    const sql = `
        INSERT INTO user_token_counts (userToken, modelFamily, inputTokens, outputTokens, tokenLimit, prompts)
        VALUES (:userToken, :modelFamily, 0, 0, :refreshAmount, 0)
        ON CONFLICT(userToken, modelFamily) DO UPDATE SET tokenLimit = inputTokens + outputTokens + :refreshAmount;
    `;

    for (const [family, tokens] of Object.entries(tokensByFamily)) {
      db.prepare(sql).run({
        userToken,
        modelFamily: family,
        refreshAmount: tokens,
      });
    }
  },
  /**
   * Resets token usage counters for a given user to zero.
   */
  resetUsage(userToken: string) {
    const db = getDatabase();
    const sql = `
        DELETE
        FROM user_token_counts
        WHERE userToken = :token
    `;
    db.prepare(sql).run({ token: userToken });
  },
};

function marshalUser(row: any): User {
  const user: Partial<User> = {
    token: row.token,
    nickname: row.nickname,
    type: row.type,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    disabledAt: row.disabledAt,
    disabledReason: row.disabledReason,
    expiresAt: row.expiresAt,
    maxIps: row.maxIps,
    adminNote: row.adminNote,
  };

  user.ip = row.ip ? JSON.parse(row.ip) : [];
  user.meta = row.meta ? JSON.parse(row.meta) : {};
  user.modelTokenCounts = JSON.parse(row.tokenCounts ?? "{}") as z.infer<
    typeof tokenCountsSchema
  >;
  // legacy token fields
  user.promptCount = 0;
  user.tokenCount = 0;
  user.tokenCounts = {} as z.infer<typeof tokenCountsSchemaOld>;

  if (row.tokenCounts) {
    // initialize missing model families
    for (const family of MODEL_FAMILIES) {
      if (!user.modelTokenCounts[family]) {
        user.modelTokenCounts[family] = {
          input: 0,
          output: 0,
          limit: 0,
          prompts: 0,
        };
      }

      // aggregate legacy fields
      user.promptCount += user.modelTokenCounts[family].prompts;
      user.tokenCount +=
        user.modelTokenCounts[family].input +
        user.modelTokenCounts[family].output;
      user.tokenCounts[family] =
        user.modelTokenCounts[family].input +
        user.modelTokenCounts[family].output;
    }
  }

  return user as User;
}
