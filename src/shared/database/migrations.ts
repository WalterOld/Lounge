import type sqlite3 from "better-sqlite3";

type Migration = {
  name: string;
  version: number;
  up: (db: sqlite3.Database) => void;
  down: (db: sqlite3.Database) => void;
};

export const migrations = [
  {
    name: "create db",
    version: 1,
    up: () => {},
    down: () => {},
  },
  {
    name: "add events table",
    version: 2,
    up: (db) => {
      db.exec(
        `CREATE TABLE IF NOT EXISTS events
         (
             id           INTEGER PRIMARY KEY AUTOINCREMENT,
             type         TEXT    NOT NULL,
             ip           TEXT    NOT NULL,
             date         TEXT    NOT NULL,
             model        TEXT    NOT NULL,
             family       TEXT    NOT NULL,
             hashes       TEXT    NOT NULL,
             userToken    TEXT    NOT NULL,
             inputTokens  INTEGER NOT NULL,
             outputTokens INTEGER NOT NULL
         )`
      );
    },
    down: (db) => db.exec("DROP TABLE events"),
  },
  {
    name: "add events indexes",
    version: 3,
    up: (db) => {
      // language=SQLite
      db.exec(
        `BEGIN;
        CREATE INDEX IF NOT EXISTS idx_events_userToken ON events (userToken);
        CREATE INDEX IF NOT EXISTS idx_events_ip ON events (ip);
        COMMIT;`
      );
    },
    down: (db) => {
      // language=SQLite
      db.exec(
        `BEGIN;
        DROP INDEX idx_events_userToken;
        DROP INDEX idx_events_ip;
        COMMIT;`
      );
    },
  },
  {
    name: "add users schema",
    version: 4,
    up: (db) => {
      // language=SQLite
      const sql = `
          CREATE TABLE IF NOT EXISTS users
          (
              token          TEXT PRIMARY KEY                                        NOT NULL,
              nickname       TEXT,
              type           TEXT CHECK (type IN ('normal', 'special', 'temporary')) NOT NULL,
              createdAt      INTEGER                                                 NOT NULL,
              lastUsedAt     INTEGER,
              disabledAt     INTEGER,
              disabledReason TEXT,
              expiresAt      INTEGER,
              maxIps         INTEGER,
              adminNote      TEXT
          );

          CREATE TABLE IF NOT EXISTS user_ips
          (
              userToken TEXT NOT NULL,
              ip        TEXT NOT NULL,
              PRIMARY KEY (userToken, ip),
              FOREIGN KEY (userToken) REFERENCES users (token)
          );

          CREATE TABLE IF NOT EXISTS user_token_counts
          (
              userToken    TEXT    NOT NULL,
              modelFamily  TEXT    NOT NULL,
              inputTokens  INTEGER NOT NULL,
              outputTokens INTEGER NOT NULL,
              tokenLimit   INTEGER NOT NULL,
              prompts      INTEGER NOT NULL,
              PRIMARY KEY (userToken, modelFamily)
          );

          CREATE TABLE IF NOT EXISTS user_meta
          (
              userToken TEXT NOT NULL,
              key       TEXT NOT NULL,
              value     TEXT NOT NULL,
              PRIMARY KEY (userToken, key),
              FOREIGN KEY (userToken) REFERENCES users (token)
          );
      `;
      db.exec(sql);
    },
    down: (db) => {
      // language=SQLite
      const sql = `
      DROP TABLE users;
      DROP TABLE user_ips;
      DROP TABLE user_token_counts;
      DROP TABLE user_meta;
      `;
      db.exec(sql);
    },
  },
] satisfies Migration[];
