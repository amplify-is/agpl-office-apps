-- stg-agpl-spreadsheet (staging only): storage for the Amplify-modified AGPL Spreadsheet app
CREATE TABLE IF NOT EXISTS kv (
  user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS files (
  user_id TEXT NOT NULL, path TEXT NOT NULL, id TEXT NOT NULL, is_dir INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, modified INTEGER NOT NULL,
  PRIMARY KEY (user_id, path)
);
CREATE UNIQUE INDEX IF NOT EXISTS files_id ON files (user_id, id);
